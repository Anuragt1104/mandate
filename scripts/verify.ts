/**
 * Observe an existing liquidity arrangement, read-only (no escrow, no program, no keys), for
 * as long as it takes: the unattended version of "Monitor an existing arrangement" in the app.
 *
 *   RPC_URL=https://api.mainnet-beta.solana.com npx tsx scripts/verify.ts \
 *     --pair <DLMM pair> --owner <operator wallet> [--position <pubkey>] \
 *     --min-depth 5000 --window-bps 200 --max-spread-bps 100 --period-min 60 --hours 24 \
 *     [--checks-per-period 3] [--twap-min 5] [--trade-size 5000] [--cluster mainnet]
 *
 * Every sample keeps the exact per-bin committed values (the Mandate program's arithmetic),
 * so the session can later be replayed against any terms. It writes
 *   reports/<id>.session.json   import it in the app (Reports → Import) to share a report or
 *                               draft terms from it
 *   reports/<id>.md             a replay against the terms given here
 * both rewritten after every sample. See sdk/src/observe.ts and sdk/src/report.ts.
 */
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { evaluate, newSession, nextSampleIn, resolvePosition, sampleOracle, takeSample, type Session } from "../sdk/src";
import { makeConnection, sleep } from "../keeper/common";

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const conn = makeConnection();
const TERMS = { minDepth: Number(arg("min-depth", "500")), depthWindowBps: Number(arg("window-bps", "200")), maxSpreadBps: Number(arg("max-spread-bps", "100")) };
const TRADE = Number(arg("trade-size", String(TERMS.minDepth)));
const HOURS = Number(arg("hours", "24"));

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
const money = (x: number | null) => (x === null ? "n/a" : Math.round(x).toLocaleString("en-US"));

function write(s: Session, base: string) {
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(`${base}.session.json`, JSON.stringify(s));
  const e = evaluate(s, TERMS, { tradeSizes: [TRADE] });
  const ex = e.execution[0];
  const lines = [
    `# Liquidity verification: ${s.pair}`,
    ``,
    `Operator ${s.owner ?? s.position} · ${s.cluster} · from ${new Date(s.startedAt * 1000).toISOString()} · ${e.summary.samples} samples, periods of ${s.periodSecs / 60} min`,
    ``,
    `Terms replayed: at least ${money(TERMS.minDepth)} quote of committed bids in the reference bin and the whole bins within ${TERMS.depthWindowBps} bps below it, the same of asks above it, spread at most ${TERMS.maxSpreadBps} bps at a tenth of that size. Reference: the pair's DLMM oracle TWAP over ${s.twapSecs / 60} min.`,
    ``,
    `- ${e.readiness.ready ? "Enough evidence to interpret." : `Not enough evidence yet: ${e.readiness.needs.join(" ")}`}`,
    `- Periods met: **${e.summary.met} of ${e.summary.decided}** decided; ${e.summary.unknown} unknown; ${e.summary.unobserved} unobserved.`,
    `- Longest run of missed periods: ${e.summary.longestMissRun}. Checks failing each threshold: bids ${e.failures.bids}, asks ${e.failures.asks}, spread ${e.failures.spread}.`,
    `- Observed committed depth (lower tenth): bids ${money(e.observed.bidP10)}, asks ${money(e.observed.askP10)}; spread median ${e.observed.spreadMedian ?? "n/a"} bps.`,
    `- A ${money(TRADE)} trade (estimate, before swap fees): buy median ${pct(ex.buyMedian)}, worst ${pct(ex.buyWorst)}; sell median ${pct(ex.sellMedian)}, worst ${pct(ex.sellWorst)}; couldn't fill in ${ex.unfilled} of ${ex.samples} samples.`,
    ...e.readiness.missing.map((m) => `- Missing evidence: ${m}`),
    ``,
    `| Period start (UTC) | Samples | Result | Lowest bids | Lowest asks | Widest spread |`,
    `|---|---|---|---|---|---|`,
    ...e.periods.map((p) => `| ${new Date(p.start * 1000).toISOString().slice(0, 16)} | ${p.checks.length} | ${p.verdict === "missed" ? "**missed**" : p.verdict} | ${money(p.minBid)} | ${money(p.minAsk)} | ${p.worstSpread === null ? "" : p.worstSpread >= 65535 ? "one side empty" : `${p.worstSpread} bps`} |`),
    ``,
    `Committed liquidity is measured bin by bin at each bin's price, as the Mandate program does, so trades against the book don't change it. Trade costs are estimates from the operator's book only. Import ${path.basename(base)}.session.json in the app to replay other terms or share the report.`,
  ];
  fs.writeFileSync(`${base}.md`, lines.join("\n") + "\n");
}

async function main() {
  let pair = arg("pair") ? new PublicKey(arg("pair")!) : null;
  let owner = arg("owner") ? new PublicKey(arg("owner")!) : null;
  const position = arg("position") ? new PublicKey(arg("position")!) : null;
  if (position) {
    const r = await resolvePosition(conn, position);
    if (!r) throw new Error("--position is not a DLMM PositionV2 account");
    pair ??= new PublicKey(r.pair);
    owner ??= new PublicKey(r.owner);
  }
  if (!pair || (!owner && !position)) throw new Error("--pair with --owner, or --position, is required");
  const s = await newSession(conn, {
    cluster: arg("cluster", process.env.CLUSTER ?? "mainnet")!,
    pair,
    owner,
    position,
    periodSecs: Number(arg("period-min", "60")) * 60,
    checksPerPeriod: Number(arg("checks-per-period", "3")),
    twapSecs: Number(arg("twap-min", "5")) * 60,
    terms: TERMS,
  });
  const base = path.resolve(__dirname, `../reports/${s.id}`);
  console.log(`observing ${s.pair} (${s.owner ?? s.position}) for ${HOURS} h → ${path.relative(process.cwd(), base)}.*`);
  const endAt = s.startedAt + HOURS * 3600;
  let next = s.startedAt + nextSampleIn(s) / 2;
  let oracleAt = 0;
  while (Math.floor(Date.now() / 1000) < endAt) {
    const now = Math.floor(Date.now() / 1000);
    if (now - oracleAt >= 15) {
      oracleAt = now;
      await sampleOracle(conn, s, now);
    }
    if (now >= next) {
      try {
        const sample = await takeSample(conn, s);
        s.samples.push(sample);
        write(s, base);
        const e = evaluate(s, TERMS);
        const c = e.periods[e.periods.length - 1].checks.at(-1)!;
        console.log(`${new Date().toISOString().slice(11, 19)} ${c.result.toUpperCase().padEnd(7)} ref ${sample.reference.state} · ${c.result === "unknown" ? c.reason : `bids ${money(c.bid!)} asks ${money(c.ask!)} spread ${c.spreadBps! >= 65535 ? "—" : c.spreadBps} bps`}`);
      } catch (e: any) {
        console.log(`sample failed: ${e.message?.split("\n")[0]}`);
      }
      next = now + nextSampleIn(s);
    }
    await sleep(1000);
  }
  write(s, base);
  console.log(`wrote ${path.relative(process.cwd(), base)}.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
