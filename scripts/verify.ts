/**
 * Verify an existing liquidity arrangement, read-only: no escrow, no program, no keys.
 *
 * The cheapest way to find out which obligations a token team would trust enough to automate
 * is to monitor the operator it already pays. This samples the operator's DLMM position(s) on a
 * pair at random times, measures them against agreed terms with the same committed-liquidity
 * math the Mandate program enforces (sdk/src/measure.ts), records what a trader could execute
 * at the agreed size, and writes a per-period report the team can bring to a payment or
 * renewal decision.
 *
 *   RPC_URL=https://api.mainnet-beta.solana.com npx tsx scripts/verify.ts \
 *     --pair <DLMM pair> --owner <operator wallet> --min-depth 5000 --window-bps 200 \
 *     --max-spread-bps 100 --period-min 60 --hours 24 [--position <pubkey>] [--trade-size 5000]
 *
 * Without a mandate there is no on-chain reference price, so the reference is the median of
 * the pair's active bin over the last --twap-min minutes (default 5) of samples: like the
 * program's reference, a price pushed for one block barely moves it.
 *
 * Reports go to reports/verify-<pair>-<start>.md and .json, rewritten after every period.
 */
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, binArraysCovering, decodeBinArray, decodeLbPair, decodePosition } from "../sdk/src";
import { committed, executable, type Bin } from "../sdk/src/measure";
import { makeConnection, sleep } from "../keeper/common";

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PAIR = new PublicKey(arg("pair") ?? (() => { throw new Error("--pair required"); })());
const OWNER = arg("owner") ? new PublicKey(arg("owner")!) : null;
const POSITION = arg("position") ? new PublicKey(arg("position")!) : null;
if (!OWNER && !POSITION) throw new Error("--owner or --position required");
const TERMS = { minDepth: Number(arg("min-depth", "500")), windowBps: Number(arg("window-bps", "200")), maxSpreadBps: Number(arg("max-spread-bps", "100")) };
const PERIOD_SECS = Number(arg("period-min", "60")) * 60;
const HOURS = Number(arg("hours", "24"));
const CHECKS = Number(arg("checks-per-period", "3"));
const TWAP_SECS = Number(arg("twap-min", "5")) * 60;
const TRADE = Number(arg("trade-size", String(TERMS.minDepth)));
const POSITION_V2 = Buffer.from([117, 176, 212, 199, 245, 180, 133, 182]);

const conn = makeConnection();
const decimalsCache = new Map<string, number>();
async function decimals(mint: PublicKey) {
  const k = mint.toBase58();
  if (!decimalsCache.has(k)) decimalsCache.set(k, (await conn.getAccountInfo(mint))!.data[44]);
  return decimalsCache.get(k)!;
}

async function positions(): Promise<PublicKey[]> {
  if (POSITION) return [POSITION];
  const accs = await conn.getProgramAccounts(DLMM_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 8, bytes: PAIR.toBase58() } }, { memcmp: { offset: 40, bytes: OWNER!.toBase58() } }],
    dataSlice: { offset: 0, length: 8 },
  });
  return accs.filter((a) => Buffer.from(a.account.data).equals(POSITION_V2)).map((a) => a.pubkey);
}

interface Check { ts: number; ok: boolean; bidDepth: number; askDepth: number; spreadBps: number | null; buyCost: number | null; sellCost: number | null; filled: number; referencePrice: number; widePositions: number }
const actives: { ts: number; bin: number }[] = [];

async function sample(): Promise<Check> {
  const pairInfo = await conn.getAccountInfo(PAIR);
  if (!pairInfo) throw new Error("pair not found");
  const pair = decodeLbPair(pairInfo.data);
  const [bd, qd] = await Promise.all([decimals(pair.tokenX), decimals(pair.tokenY)]);
  const now = Math.floor(Date.now() / 1000);
  actives.push({ ts: now, bin: pair.activeId });
  while (actives.length && actives[0].ts < now - TWAP_SECS) actives.shift();
  const sorted = actives.map((a) => a.bin).sort((a, b) => a - b);
  const refBin = sorted[Math.floor(sorted.length / 2)];
  const uiPrice = (bin: number) => Math.pow(1 + pair.binStep / 10_000, bin) * Math.pow(10, bd - qd);

  const bins = new Map<number, Bin>();
  let wide = 0;
  const keys = await positions();
  const infos = await conn.getMultipleAccountsInfo(keys);
  for (const info of infos) {
    if (!info) continue;
    const pos = decodePosition(info.data);
    if (pos.upperBinId - pos.lowerBinId + 1 > 70) wide++; // only the first 70 bins are read
    const arrays = await conn.getMultipleAccountsInfo(binArraysCovering(PAIR, pos.lowerBinId, Math.min(pos.upperBinId, pos.lowerBinId + 69)));
    const byIndex = new Map<number, ReturnType<typeof decodeBinArray>>();
    arrays.forEach((a) => a && byIndex.set(decodeBinArray(a.data).index, decodeBinArray(a.data)));
    for (let b = pos.lowerBinId; b <= Math.min(pos.upperBinId, pos.lowerBinId + 69); b++) {
      const share = pos.shares[b - pos.lowerBinId];
      const idx = Math.floor(b / 70);
      const arr = byIndex.get(idx);
      if (!arr || share === 0n) continue;
      const bin = arr.bins[b - idx * 70];
      if (bin.liquiditySupply === 0n) continue;
      const base = Number((bin.amountX * share) / bin.liquiditySupply) / 10 ** bd;
      const quote = Number((bin.amountY * share) / bin.liquiditySupply) / 10 ** qd;
      const prev = bins.get(b);
      bins.set(b, { binId: b, base: base + (prev?.base ?? 0), quote: quote + (prev?.quote ?? 0), price: uiPrice(b) });
    }
  }
  const list = [...bins.values()];
  const c = committed(list, refBin, pair.binStep, TERMS);
  const ex = executable(list, pair.activeId, uiPrice(refBin), TRADE);
  return { ts: now, ok: c.ok, bidDepth: c.bidDepth, askDepth: c.askDepth, spreadBps: c.spreadBps, buyCost: ex.buy.cost, sellCost: ex.sell.cost, filled: Math.min(ex.buy.filled, ex.sell.filled), referencePrice: uiPrice(refBin), widePositions: wide };
}

interface Period { index: number; start: number; checks: Check[] }
const started = Math.floor(Date.now() / 1000);
const periods: Period[] = [];
const outBase = path.resolve(__dirname, `../reports/verify-${PAIR.toBase58().slice(0, 8)}-${new Date(started * 1000).toISOString().slice(0, 16).replace(/[:T]/g, "")}`);

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
const money = (x: number) => Math.round(x).toLocaleString("en-US");
function write() {
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const scored = periods.filter((p) => p.checks.length);
  const met = scored.filter((p) => p.checks.every((c) => c.ok));
  const poorWhileMet = scored.flatMap((p) => p.checks).filter((c) => c.ok && (c.filled < 0.999 || (c.buyCost ?? 1) > 0.05 || (c.sellCost ?? 1) > 0.05));
  let run = 0;
  let longest = 0;
  for (const p of scored) {
    run = p.checks.every((c) => c.ok) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  const lines = [
    `# Liquidity verification: ${PAIR.toBase58()}`,
    ``,
    `Operator ${OWNER?.toBase58() ?? "(position)"} · from ${new Date(started * 1000).toISOString()} · ${scored.length} periods of ${PERIOD_SECS / 60} min checked`,
    ``,
    `Terms: at least ${money(TERMS.minDepth)} quote of bids within ${TERMS.windowBps / 100}% below the reference and the same of asks above it, spread at most ${TERMS.maxSpreadBps} bps. Reference: median active bin over ${TWAP_SECS / 60} min.`,
    ``,
    `- Periods met: **${met.length} of ${scored.length}**${scored.length ? ` (${((100 * met.length) / scored.length).toFixed(1)}%)` : ""}`,
    `- Longest run of missed periods: ${longest}`,
    `- Checks where the terms were met but a ${money(TRADE)} trade cost over 5% or couldn't fill: ${poorWhileMet.length}`,
    ...(periods.some((p) => p.checks.some((c) => c.widePositions)) ? [`- Note: some positions span more than 70 bins; only their first 70 bins were measured.`] : []),
    ``,
    `| Period start (UTC) | Checks | Result | Lowest bids | Lowest asks | Widest spread | Worst buy cost | Worst sell cost |`,
    `|---|---|---|---|---|---|---|---|`,
    ...periods.map((p) => {
      if (!p.checks.length) return `| ${new Date(p.start * 1000).toISOString().slice(0, 16)} | 0 | not checked | | | | | |`;
      const ok = p.checks.every((c) => c.ok);
      const worst = (f: (c: Check) => number | null) => Math.max(...p.checks.map((c) => f(c) ?? Infinity));
      const spread = worst((c) => c.spreadBps);
      return `| ${new Date(p.start * 1000).toISOString().slice(0, 16)} | ${p.checks.length} | ${ok ? "met" : "**missed**"} | ${money(Math.min(...p.checks.map((c) => c.bidDepth)))} | ${money(Math.min(...p.checks.map((c) => c.askDepth)))} | ${isFinite(spread) ? `${spread} bps` : "one side empty"} | ${pct(isFinite(worst((c) => c.buyCost)) ? worst((c) => c.buyCost) : null)} | ${pct(isFinite(worst((c) => c.sellCost)) ? worst((c) => c.sellCost) : null)} |`;
    }),
    ``,
    `Committed liquidity is measured bin by bin at each bin's price, as the Mandate program does, so trades against the book don't change it. Trade costs walk the operator's current book only, before swap fees; they are shown, not part of the terms.`,
  ];
  fs.writeFileSync(`${outBase}.md`, lines.join("\n") + "\n");
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({ pair: PAIR.toBase58(), owner: OWNER?.toBase58(), terms: TERMS, periodSecs: PERIOD_SECS, periods }, null, 2));
}

async function main() {
  console.log(`verifying ${PAIR.toBase58()} for ${HOURS} h; positions: ${(await positions()).map((p) => p.toBase58().slice(0, 8)).join(", ") || "none found"}`);
  const endAt = started + HOURS * 3600;
  let next = started;
  while (Math.floor(Date.now() / 1000) < endAt) {
    const now = Math.floor(Date.now() / 1000);
    const index = Math.floor((now - started) / PERIOD_SECS);
    while (periods.length <= index) {
      periods.push({ index: periods.length, start: started + periods.length * PERIOD_SECS, checks: [] });
      if (periods.length > 1) write();
    }
    if (now >= next) {
      try {
        const c = await sample();
        periods[index].checks.push(c);
        console.log(`${new Date().toISOString().slice(11, 19)} ${c.ok ? "met   " : "MISSED"} bids ${money(c.bidDepth)} asks ${money(c.askDepth)} spread ${c.spreadBps ?? "—"} bps · ${money(TRADE)} buy ${pct(c.buyCost)} sell ${pct(c.sellCost)}`);
      } catch (e: any) {
        console.log(`sample failed: ${e.message?.split("\n")[0]}`);
      }
      next = now + Math.random() * 2 * (PERIOD_SECS / CHECKS);
    }
    await sleep(1000);
  }
  write();
  console.log(`wrote ${path.relative(process.cwd(), outBase)}.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
