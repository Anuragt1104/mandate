/**
 * Verify an existing liquidity arrangement, read-only: no escrow, no program, no keys.
 *
 * The cheapest way to find out which obligations a token team would trust enough to automate
 * is to monitor the operator it already pays. This samples the operator's DLMM position(s) on
 * a pair at random times and measures them against agreed terms with the exact committed-
 * liquidity arithmetic the Mandate program enforces (sdk/src/measure.ts), next to an estimate
 * of what a trader could execute at the agreed size, and writes a per-period report.
 *
 *   RPC_URL=https://api.mainnet-beta.solana.com npx tsx scripts/verify.ts \
 *     --pair <DLMM pair> --owner <operator wallet> --min-depth 5000 --window-bps 200 \
 *     --max-spread-bps 100 --period-min 60 --hours 24 [--position <pubkey>] [--trade-size 5000]
 *
 * Reference price. Like the program, the reference is the pair's own DLMM oracle TWAP: the
 * oracle is sampled every `--oracle-secs` (default 15) in the background, and a check has a
 * reference only when two oracle observations span at least `--twap-min` minutes (default 5)
 * ending at the latest one. Until then the reference is "warming" and the check's result is
 * unknown, not a pass or a miss. With no trade in the whole window (the oracle doesn't move)
 * the reference is the active bin, marked "quiet". Unlike the program, there is no speed
 * limit (nothing is at stake here), so a sudden move shows as a move.
 *
 * Evidence. Positions are validated (DLMM-owned PositionV2 on this pair, owned by the
 * operator); anything that can't be measured exactly (a wider, extended position; a bin array
 * that couldn't be read) makes the check "unknown" with the reason. Each check records the
 * slot it read at, the reference and its state, and the raw depths in atoms. A period is met
 * only if every measured check passed and nothing was unknown, missed if any measured check
 * failed, and otherwise unknown. Reports go to reports/verify-<pair>-<start>.md and .json.
 */
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, binArraysCovering, decodeBinArray, decodeLbPair, decodeOracleLatest, decodePosition, loadAccounts, measureAccounts, type BinInfo, type OracleSample } from "../sdk/src";
import { executable, type Bin } from "../sdk/src/measure";
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
const MIN_DEPTH_UI = Number(arg("min-depth", "500"));
const WINDOW_BPS = Number(arg("window-bps", "200"));
const MAX_SPREAD_BPS = Number(arg("max-spread-bps", "100"));
const PERIOD_SECS = Number(arg("period-min", "60")) * 60;
const HOURS = Number(arg("hours", "24"));
const CHECKS = Number(arg("checks-per-period", "3"));
const TWAP_SECS = Number(arg("twap-min", "5")) * 60;
const ORACLE_SECS = Number(arg("oracle-secs", "15"));
const TRADE = Number(arg("trade-size", String(MIN_DEPTH_UI)));
const POSITION_V2 = Buffer.from([117, 176, 212, 199, 245, 180, 133, 182]);

const conn = makeConnection();

type RefState = "ready" | "quiet" | "warming";
interface Check {
  at: number;
  slot: number;
  result: "met" | "missed" | "unknown";
  reason?: string;
  bidDepth?: string;
  askDepth?: string;
  spreadBps?: number;
  reference: { state: RefState; bin?: number; from?: number; to?: number };
  activeBin: number;
  positions: string[];
  buyCost: number | null;
  sellCost: number | null;
  filled: number | null;
}
interface Period { index: number; start: number; checks: Check[] }

const started = Math.floor(Date.now() / 1000);
const periods: Period[] = [];
const outBase = path.resolve(__dirname, `../reports/verify-${PAIR.toBase58().slice(0, 8)}-${new Date(started * 1000).toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
let decimals: { base: number; quote: number } | null = null;
let oracleKey: PublicKey | null = null;
const oracle: OracleSample[] = [];

/** The pair's DLMM oracle, sampled in the background so a check's reference has coverage. */
async function sampleOracle() {
  if (!oracleKey) return;
  const info = await conn.getAccountInfo(oracleKey).catch(() => null);
  const s = info ? decodeOracleLatest(info.data) : null;
  if (s && (!oracle.length || s.ts > oracle[oracle.length - 1].ts)) oracle.push(s);
  while (oracle.length > 2 && oracle[1].ts < Date.now() / 1000 - 4 * TWAP_SECS) oracle.shift();
}

/** TWAP bin over at least TWAP_SECS ending at the latest oracle observation. */
function reference(activeBin: number, now: number): Check["reference"] {
  const last = oracle[oracle.length - 1];
  if (!last) return { state: "warming" };
  if (now - last.ts > TWAP_SECS && oracle.length && sampledSince(now - TWAP_SECS)) return { state: "quiet", bin: activeBin };
  const start = [...oracle].reverse().find((s) => s.ts <= last.ts - TWAP_SECS);
  if (!start) return { state: "warming" };
  const span = BigInt(last.ts - start.ts);
  const d = last.cumulative - start.cumulative;
  const avg = d >= 0n || d % span === 0n ? d / span : d / span - 1n;
  return { state: "ready", bin: Number(avg), from: start.ts, to: last.ts };
}
let firstSampleAt = 0;
const sampledSince = (t: number) => firstSampleAt > 0 && firstSampleAt <= t;

async function positions(): Promise<{ keys: PublicKey[]; problem?: string }> {
  if (POSITION) return { keys: [POSITION] };
  const accs = await conn.getProgramAccounts(DLMM_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 8, bytes: PAIR.toBase58() } }, { memcmp: { offset: 40, bytes: OWNER!.toBase58() } }],
    dataSlice: { offset: 0, length: 8 },
  });
  return { keys: accs.filter((a) => Buffer.from(a.account.data).equals(POSITION_V2)).map((a) => a.pubkey) };
}

async function sample(): Promise<Check> {
  const { keys } = await positions();
  const mints: PublicKey[] = [];
  const first = await loadAccounts(conn, [PAIR, ...keys]);
  const pairInfo = first.infos[0];
  if (!pairInfo) throw new Error("pair not found");
  const pair = decodeLbPair(pairInfo.data);
  oracleKey ??= pair.oracle;
  if (!decimals) {
    mints.push(pair.tokenX, pair.tokenY);
    const m = await loadAccounts(conn, mints);
    decimals = { base: m.infos[0]!.data[44], quote: m.infos[1]!.data[44] };
  }
  const at = Math.floor(Date.now() / 1000);
  const ref = reference(pair.activeId, at);
  const base: Omit<Check, "result"> = { at, slot: first.slot, reference: ref, activeBin: pair.activeId, positions: keys.map((k) => k.toBase58()), buyCost: null, sellCost: null, filled: null };
  const unknown = (reason: string): Check => ({ ...base, result: "unknown", reason });
  if (ref.state === "warming") return unknown(`reference warming: needs oracle observations spanning ${TWAP_SECS / 60} min`);
  if (!keys.length) return unknown("no position found for this operator on this pair");

  // Validate every position and merge them bin by bin (their shares add in the same bins).
  const decoded = [];
  for (const [i, k] of keys.entries()) {
    const info = first.infos[1 + i];
    if (!info) return unknown(`position ${k.toBase58()} not found`);
    if (!info.owner.equals(DLMM_PROGRAM_ID) || !Buffer.from(info.data.subarray(0, 8)).equals(POSITION_V2)) return unknown(`${k.toBase58()} is not a DLMM PositionV2 account`);
    const pos = decodePosition(info.data);
    if (!pos.lbPair.equals(PAIR)) return unknown(`position ${k.toBase58()} is on another pair`);
    if (OWNER && !pos.owner.equals(OWNER)) return unknown(`position ${k.toBase58()} is owned by ${pos.owner.toBase58()}, not the operator`);
    if (pos.upperBinId - pos.lowerBinId + 1 > 70) return unknown(`position ${k.toBase58()} spans more than 70 bins (extended layout): not supported`);
    decoded.push(pos);
  }
  const indexes = [...new Set(decoded.flatMap((p) => binArraysCovering(PAIR, p.lowerBinId, p.upperBinId).map((k) => k.toBase58())))].map((k) => new PublicKey(k));
  const arr = await loadAccounts(conn, indexes);
  const arrays = new Map<number, BinInfo[]>();
  arr.infos.forEach((a) => a && arrays.set(decodeBinArray(a.data).index, decodeBinArray(a.data).bins));

  // Measure each position exactly as the program would and add the results; spread is taken
  // from the merged book (one position, the usual case, gives exactly the program's verdict).
  const terms = { minDepthQuote: BigInt(Math.round(MIN_DEPTH_UI * 10 ** decimals!.quote)), depthWindowBps: WINDOW_BPS, maxSpreadBps: MAX_SPREAD_BPS };
  const m = { terms: { minDepthQuote: terms.minDepthQuote, depthWindowBps: WINDOW_BPS, maxSpreadBps: MAX_SPREAD_BPS }, anchor: { bin: ref.bin! } };
  let bid = 0n;
  let ask = 0n;
  let spread = 65535;
  for (const pos of decoded) {
    const r = measureAccounts(m, pair.binStep, pos, arrays, ref.bin!);
    if (r.status === "unknown") return unknown(r.reason);
    bid += r.bidDepth;
    ask += r.askDepth;
    spread = Math.min(spread, r.spreadBps);
  }
  const met = spread <= MAX_SPREAD_BPS && bid >= terms.minDepthQuote && ask >= terms.minDepthQuote;

  // Display-only estimate of execution at the trade size, from the same bins.
  const ui = (b: number) => Math.pow(1 + pair.binStep / 10_000, b) * 10 ** (decimals!.base - decimals!.quote);
  const book = new Map<number, Bin>();
  for (const pos of decoded)
    for (let b = pos.lowerBinId; b <= pos.upperBinId; b++) {
      const share = pos.shares[b - pos.lowerBinId];
      const idx = Math.floor(b / 70);
      const bin = arrays.get(idx)?.[b - idx * 70];
      if (!bin || share === 0n || bin.liquiditySupply === 0n) continue;
      const prev = book.get(b);
      book.set(b, {
        binId: b,
        base: (prev?.base ?? 0) + Number((bin.amountX * share) / bin.liquiditySupply) / 10 ** decimals!.base,
        quote: (prev?.quote ?? 0) + Number((bin.amountY * share) / bin.liquiditySupply) / 10 ** decimals!.quote,
        price: ui(b),
      });
    }
  const ex = executable([...book.values()], pair.activeId, ui(ref.bin!), TRADE);
  return {
    ...base,
    at: Math.floor(Date.now() / 1000),
    result: met ? "met" : "missed",
    bidDepth: bid.toString(),
    askDepth: ask.toString(),
    spreadBps: spread,
    buyCost: ex.buy.cost,
    sellCost: ex.sell.cost,
    filled: Math.min(ex.buy.filled, ex.sell.filled),
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
const money = (x: number) => Math.round(x).toLocaleString("en-US");
const qui = (atoms?: string) => (atoms === undefined || !decimals ? NaN : Number(atoms) / 10 ** decimals.quote);
const verdict = (p: Period) => {
  if (!p.checks.length) return "not checked";
  if (p.checks.some((c) => c.result === "missed")) return "missed";
  if (p.checks.some((c) => c.result === "unknown")) return "unknown";
  return "met";
};

function write() {
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const scored = periods.filter((p) => p.checks.length);
  const count = (v: string) => scored.filter((p) => verdict(p) === v).length;
  const decided = count("met") + count("missed");
  const poorWhileMet = scored.flatMap((p) => p.checks).filter((c) => c.result === "met" && ((c.filled ?? 1) < 0.999 || (c.buyCost ?? 1) > 0.05 || (c.sellCost ?? 1) > 0.05));
  let run = 0;
  let longest = 0;
  for (const p of scored) {
    const v = verdict(p);
    run = v === "missed" ? run + 1 : v === "met" ? 0 : run;
    longest = Math.max(longest, run);
  }
  const reasons = [...new Set(scored.flatMap((p) => p.checks).filter((c) => c.result === "unknown").map((c) => c.reason))];
  const lines = [
    `# Liquidity verification: ${PAIR.toBase58()}`,
    ``,
    `Operator ${OWNER?.toBase58() ?? "(position)"} · from ${new Date(started * 1000).toISOString()} · ${scored.length} periods of ${PERIOD_SECS / 60} min checked`,
    ``,
    `Terms: at least ${money(MIN_DEPTH_UI)} quote of committed bids in the reference bin and the whole bins within ${WINDOW_BPS} bps below it, the same of asks in the whole bins within ${WINDOW_BPS} bps above it, and a spread of at most ${MAX_SPREAD_BPS} bps at a tenth of that size, measured with the Mandate program's own arithmetic. Reference: the pair's DLMM oracle TWAP over ${TWAP_SECS / 60} min.`,
    ...(periods.some((p) => p.checks.some((c) => c.positions.length > 1)) ? [``, `Note: the operator has several positions on this pair. Depths are exact sums; the spread shown is the tightest single position's, an approximation of the combined book.`] : []),
    ``,
    `- Periods met: **${count("met")} of ${decided}** decided${decided ? ` (${((100 * count("met")) / decided).toFixed(1)}%)` : ""}; ${count("unknown")} unknown (incomplete evidence, not counted either way)`,
    `- Longest run of missed periods: ${longest}`,
    `- Checks where the terms were met but a ${money(TRADE)} trade cost over 5% or couldn't fill (estimate, before swap fees): ${poorWhileMet.length}`,
    ...(reasons.length ? [`- Why some checks are unknown: ${reasons.join("; ")}`] : []),
    ``,
    `| Period start (UTC) | Checks | Result | Lowest bids | Lowest asks | Widest spread | Reference | Worst buy cost | Worst sell cost |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...periods.map((p) => {
      const start = new Date(p.start * 1000).toISOString().slice(0, 16);
      if (!p.checks.length) return `| ${start} | 0 | not checked | | | | | | |`;
      const measured = p.checks.filter((c) => c.result !== "unknown");
      const v = verdict(p);
      const worst = (f: (c: Check) => number | null) => (measured.length ? Math.max(...measured.map((c) => f(c) ?? Infinity)) : NaN);
      const spread = worst((c) => c.spreadBps ?? null);
      const low = (f: (c: Check) => string | undefined) => (measured.length ? money(Math.min(...measured.map((c) => qui(f(c))))) : "");
      const refs = [...new Set(p.checks.map((c) => c.reference.state))].join(", ");
      return `| ${start} | ${p.checks.length} | ${v === "missed" ? "**missed**" : v} | ${low((c) => c.bidDepth)} | ${low((c) => c.askDepth)} | ${!measured.length ? "" : spread >= 65535 ? "one side empty" : `${spread} bps`} | ${refs} | ${pct(isFinite(worst((c) => c.buyCost)) ? worst((c) => c.buyCost) : null)} | ${pct(isFinite(worst((c) => c.sellCost)) ? worst((c) => c.sellCost) : null)} |`;
    }),
    ``,
    `Committed liquidity is measured bin by bin at each bin's price, as the Mandate program does, so trades against the book don't change it. Trade costs are an estimate from the operator's current book only, before swap fees; they are shown, not part of the terms. Raw evidence (slots, reference windows, depths in atoms) is in the .json file.`,
  ];
  fs.writeFileSync(`${outBase}.md`, lines.join("\n") + "\n");
  fs.writeFileSync(
    `${outBase}.json`,
    JSON.stringify({ pair: PAIR.toBase58(), owner: OWNER?.toBase58(), position: POSITION?.toBase58(), terms: { minDepthUi: MIN_DEPTH_UI, windowBps: WINDOW_BPS, maxSpreadBps: MAX_SPREAD_BPS }, twapSecs: TWAP_SECS, periodSecs: PERIOD_SECS, decimals, periods }, null, 2),
  );
}

async function main() {
  const found = await positions();
  console.log(`verifying ${PAIR.toBase58()} for ${HOURS} h; positions: ${found.keys.map((p) => p.toBase58().slice(0, 8)).join(", ") || "none found"}`);
  const endAt = started + HOURS * 3600;
  let next = started + Math.random() * (PERIOD_SECS / CHECKS);
  let oracleAt = 0;
  while (Math.floor(Date.now() / 1000) < endAt) {
    const now = Math.floor(Date.now() / 1000);
    if (now - oracleAt >= ORACLE_SECS) {
      oracleAt = now;
      await sampleOracle();
      if (oracle.length && !firstSampleAt) firstSampleAt = now;
    }
    if (now >= next) {
      try {
        const c = await sample();
        // The period is decided by when the observation was made, after the reads.
        const index = Math.floor((c.at - started) / PERIOD_SECS);
        while (periods.length <= index) periods.push({ index: periods.length, start: started + periods.length * PERIOD_SECS, checks: [] });
        periods[index].checks.push(c);
        write();
        const detail = c.result === "unknown" ? c.reason : `bids ${money(qui(c.bidDepth))} asks ${money(qui(c.askDepth))} spread ${c.spreadBps === 65535 ? "—" : c.spreadBps} bps · ${money(TRADE)} buy ${pct(c.buyCost)} sell ${pct(c.sellCost)}`;
        console.log(`${new Date().toISOString().slice(11, 19)} ${c.result.toUpperCase().padEnd(7)} ref ${c.reference.state}${c.reference.bin !== undefined ? ` bin ${c.reference.bin}` : ""} · ${detail}`);
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
