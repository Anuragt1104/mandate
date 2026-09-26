/**
 * Why was this operator paid (or not) for a period? Recompute it yourself.
 *
 *   # from an evidence bundle downloaded from the app — no network needed
 *   npx tsx scripts/explain.ts --bundle mandate-evidence.json
 *
 *   # or collect the evidence independently, from an RPC of your choice
 *   npx tsx scripts/explain.ts --cluster devnet --mandate <address> --period <n> [--rpc <url>] [--out bundle.json]
 *
 *   # re-fetch every transaction a bundle cites from another RPC and compare
 *   npx tsx scripts/explain.ts --bundle mandate-evidence.json --recheck --rpc <url>
 *
 * Exits non-zero if the recomputation disagrees with what the program recorded. Periods are
 * numbered from 1, as in the app.
 */
import fs from "fs";
import path from "path";
import { AnchorProvider, EventParser, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { collectEvidence, endpointLabel, failoverFetch, MandateClient, verifyEvidence, STATUS_WORD, type EvidenceBundle } from "../sdk/src";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (k: string) => process.argv.includes(`--${k}`);

function client(conn: Connection) {
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../sdk/idl/mandate.json"), "utf8")) as Idl;
  return new MandateClient(new Program(idl, new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" })));
}

function connect(cluster: string): Connection {
  const url = arg("rpc") ?? (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : `https://api.${cluster}.solana.com`);
  return new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: failoverFetch([url], { timeoutMs: 15_000, rounds: 4 }) as any });
}

const when = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().replace(".000Z", "Z") : "unknown time");

function amount(v: string | bigint, b: EvidenceBundle) {
  if (b.quoteDecimals === null) return `${v} (atoms)`;
  return `${(Number(v) / 10 ** b.quoteDecimals).toLocaleString(undefined, { maximumFractionDigits: b.quoteDecimals })}`;
}

function print(b: EvidenceBundle) {
  const { explanation: x, results, ok } = verifyEvidence(b, (a) => amount(a, b));
  const t = b.terms;
  console.log(`Agreement ${b.mandate} (${b.cluster}), period ${b.period + 1} of ${t.durationPeriods}`);
  console.log(`  window ${when(x.window.from)} → ${when(x.window.to)}   evidence from ${b.source}`);
  console.log(`\n1. Terms (fixed when the agreement was created)`);
  console.log(`   each side: at least ${amount(t.minDepthQuote, b)} quote committed within ${t.depthWindowBps} bps; spread at most ${t.maxSpreadBps} bps`);
  console.log(`   fee ${amount(t.feePerPeriod, b)} per met period; ${t.maxConsecutiveFailures} failed periods in a row slash ${t.slashBps / 100}% of the ${amount(t.bondAmount, b)} bond`);
  console.log(`\n2. Checks recorded in the period (measured by the program inside each transaction)`);
  if (!x.verdicts.length) console.log("   none found");
  for (const v of x.verdicts) {
    const c = v.check;
    console.log(`   ${when(c.blockTime)}  bids ${amount(c.bidDepthQuote, b)} ${v.bids ? "✓" : "✗"}  asks ${amount(c.askDepthQuote, b)} ${v.asks ? "✓" : "✗"}  spread ${c.spreadBps === 65535 ? "one side empty" : `${c.spreadBps} bps`} ${v.spread ? "✓" : "✗"}  → ${v.ok ? "pass" : "FAIL"}   ${c.sig}`);
  }
  console.log(`\n3. The rule: a period is paid only if it was checked at least once and every check passed.`);
  console.log(`   ${x.statusReason}`);
  console.log(`\n4. Outcome`);
  console.log(`   ${x.status === null ? "undetermined from this evidence" : STATUS_WORD[x.status]}; fee ${amount(x.fee, b)}${x.consecutiveFailed !== null ? `; ${x.consecutiveFailed}${x.consecutiveKnown ? "" : "+"} failed in a row of ${t.maxConsecutiveFailures} allowed` : ""}${x.breach?.reached ? `; breach: slash ${amount(x.breach.slash, b)}` : ""}`);
  if (b.finalized) console.log(`   recorded by the program at ${when(b.finalized.blockTime)} in ${b.finalized.sig}`);
  console.log(`\n5. Settlement`);
  if (b.payout) console.log(`   ${b.payout.first ? "paid out in" : "paid out no later than"} a ${b.payout.kind} of ${amount(b.payout.amount, b)} (all fees owed at that point) at ${when(b.payout.blockTime)} in ${b.payout.sig}`);
  else if (b.finalized?.status === 1) console.log("   accrued; no payout found yet");
  else console.log("   nothing to pay");
  if (b.search.note) console.log(`\n   note: ${b.search.note}`);
  console.log(`\nVerification`);
  for (const r of results) console.log(`   ${r.pass === null ? "?" : r.pass ? "✓" : "✗"} [${r.basis}] ${r.name}: ${r.detail}`);
  console.log(`\n   Recomputed here: each check's verdict, the period's status, the fee and any slash.`);
  console.log(`   Not recomputed: the liquidity measurements themselves (computed on chain by the program; historical pool state isn't available from RPC).`);
  console.log(`   Trusted: the RPC that served the transactions. Re-check with --recheck --rpc <another RPC>.`);
  return ok;
}

/**
 * Re-fetch every transaction the bundle cites from another RPC and compare the program's logged
 * events with the bundle's values. This is what catches a bundle edited consistently (say, a
 * measurement and its verdict changed together), which recomputation alone cannot.
 */
async function recheck(b: EvidenceBundle): Promise<boolean> {
  const conn = connect(b.cluster);
  const c = client(conn);
  const parser = new EventParser(c.program.programId, c.program.coder);
  const n = (v: any) => (v?.toString?.() ?? String(v)) as string;
  const expect = new Map<string, { name: string; want: Record<string, string> }[]>();
  const add = (sig: string, name: string, want: Record<string, string>) => expect.set(sig, [...(expect.get(sig) ?? []), { name, want }]);
  for (const k of b.checks) add(k.sig, "snapshotTaken", { period: String(b.period), ok: String(k.ok), spreadBps: String(k.spreadBps), bidDepthQuote: k.bidDepthQuote, askDepthQuote: k.askDepthQuote });
  if (b.finalized) add(b.finalized.sig, "periodFinalized", { period: String(b.period), status: String(b.finalized.status), snapshots: String(b.finalized.snapshots), feeAccrued: b.finalized.feeAccrued });
  if (b.slash) add(b.slash.sig, "makerSlashed", { amount: b.slash.amount });
  if (b.payout) add(b.payout.sig, b.payout.kind === "claim" ? "makerFeesClaimed" : "mandateSettled", b.payout.kind === "claim" ? { amount: b.payout.amount } : { toMakerQuote: b.payout.amount });

  let ok = true;
  for (const [sig, wants] of expect) {
    let tx = null;
    let failed = false;
    for (let attempt = 0; attempt < 4 && !tx; attempt++) {
      try {
        tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx) break;
      } catch {
        failed = true;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!tx) {
      ok = false;
      console.log(`   ✗ ${sig} ${failed ? "couldn't be fetched (the RPC kept failing): try again or use another RPC" : "not found on this RPC"}`);
      continue;
    }
    const evs = tx.meta?.err ? [] : [...parser.parseLogs(tx.meta?.logMessages ?? [])].filter((e) => (e.data as any)?.mandate?.toBase58?.() === b.mandate);
    const problems: string[] = [];
    for (const w of wants) {
      const match = evs.find((e) => e.name === w.name && Object.entries(w.want).every(([k, v]) => n((e.data as any)[k]) === v));
      if (!match) problems.push(`no ${w.name} event with the bundle's values`);
    }
    if (tx.meta?.err) problems.push("the transaction failed");
    if (problems.length) ok = false;
    console.log(`   ${problems.length ? "✗" : "✓"} ${sig} slot ${tx.slot}${problems.length ? `: ${problems.join("; ")}` : ": events match the bundle"}`);
  }
  return ok;
}

async function main() {
  let b: EvidenceBundle;
  const file = arg("bundle");
  if (file) {
    b = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    const cluster = arg("cluster") ?? "devnet";
    const mandate = new PublicKey(arg("mandate") ?? "");
    const period = Number(arg("period")) - 1;
    if (!Number.isInteger(period) || period < 0) throw new Error("--period is a number from 1");
    const conn = connect(cluster);
    b = await collectEvidence(conn, client(conn), mandate, period, { cluster, source: endpointLabel(arg("rpc") ?? conn.rpcEndpoint), quoteDecimals: arg("decimals") ? Number(arg("decimals")) : null, onProgress: (t) => process.stderr.write(`\r${t.padEnd(70)}`) });
    process.stderr.write("\r".padEnd(72) + "\r");
    const out = arg("out");
    if (out) fs.writeFileSync(out, JSON.stringify(b, null, 2));
  }
  let ok = print(b);
  if (flag("recheck")) {
    console.log(`\nRe-fetching every cited transaction from ${endpointLabel(arg("rpc") ?? "public RPC")}`);
    ok = (await recheck(b)) && ok;
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(2);
});
