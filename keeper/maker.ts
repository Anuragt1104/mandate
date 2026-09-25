/**
 * Reference market-maker bot for a mandate. Keeps a DLMM position centred on the
 * mandate's reference price and deploys idle vault inventory as bids at or below it and
 * asks at or above it, inside the allowed band. Deliberately simple: a real maker would
 * add inventory skew, volatility-aware widths and hedging with its own capital.
 *
 *   RPC_URL=... KEYPAIR=maker.json MANDATE=<pubkey> npx tsx keeper/maker.ts
 *
 * Env: HALF_WIDTH_BINS (default 8), DEPLOY_FRACTION (default 0.9), TICK_MS (default 20000),
 *      AUTO_ACCEPT=1 to accept an open mandate automatically.
 */
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { StrategyType, binArrayIndex, dlmmInitBinArrayIx, pda, statusName } from "../sdk/src";
import { RPC_URL, chainTime, fetchAnchor, fetchMandate, fetchPair, loadKeypair, log, makeClient, sendIxs, sleep } from "./common";

const MANDATE = new PublicKey(process.env.MANDATE ?? (() => { throw new Error("MANDATE env required"); })());
const HALF_WIDTH = Number(process.env.HALF_WIDTH_BINS ?? 8);
const DEPLOY_FRACTION = Number(process.env.DEPLOY_FRACTION ?? 0.9);
const TICK_MS = Number(process.env.TICK_MS ?? 20_000);
const POSITION_WIDTH = 70;
const RECENTER_MARGIN = 12;

const fraction = (amount: bigint) => new BN(((amount * BigInt(Math.round(DEPLOY_FRACTION * 1000))) / 1000n).toString());

async function tick(connection: Connection, maker: ReturnType<typeof loadKeypair>, client: ReturnType<typeof makeClient>) {
  let m = await fetchMandate(connection, client, MANDATE);
  const status = statusName(m.status);
  if (status === "Open" && process.env.AUTO_ACCEPT === "1") {
    await sendIxs(connection, maker, [await client.accept({ maker: maker.publicKey, mandate: MANDATE, m })]);
    log("maker", "accepted mandate");
    return;
  }
  if (status !== "Active" || !(m.maker as PublicKey).equals(maker.publicKey)) return;

  const pair = await fetchPair(connection, m.lbPair);
  const now = await chainTime(connection);
  const ref = await fetchAnchor(connection, m, pair.binStep, now);
  const bandBins = Math.floor(Math.log(1 + m.terms.bandBps / 10_000) / Math.log(1 + pair.binStep / 10_000)) - 1;
  const hasPosition = !(m.position as PublicKey).equals(PublicKey.default);

  // 1) Open a position centred on the reference price.
  if (!hasPosition) {
    const lower = ref - Math.floor(POSITION_WIDTH / 2);
    const missing: number[] = [];
    for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + POSITION_WIDTH - 1); i++) {
      if (!(await connection.getAccountInfo(pda.binArray(m.lbPair, i)))) missing.push(i);
    }
    if (missing.length) {
      await sendIxs(connection, maker, missing.map((i) => dlmmInitBinArrayIx(m.lbPair, i, maker.publicKey)));
      log("maker", `initialized bin arrays ${missing.join(", ")}`);
    }
    await sendIxs(connection, maker, [await client.openPosition({ maker: maker.publicKey, mandate: MANDATE, m, lowerBinId: lower, width: POSITION_WIDTH })]);
    log("maker", `opened position [${lower}, ${lower + POSITION_WIDTH - 1}] around reference ${ref}`);
    return;
  }

  // 2) Re-centre when the reference drifts toward the edge of the position.
  const lower = m.positionLowerBinId as number;
  const upper = lower + (m.positionWidth as number) - 1;
  if (ref < lower + RECENTER_MARGIN || ref > upper - RECENTER_MARGIN) {
    if (now - m.lastLiquidityAddTs.toNumber() < m.terms.liquidityLockSecs) return;
    await sendIxs(connection, maker, [
      await client.removeLiquidity({ authority: maker.publicKey, mandate: MANDATE, m, pair }),
      await client.closePosition({ authority: maker.publicKey, mandate: MANDATE, m }),
    ]);
    log("maker", `reference moved to ${ref}; closed position [${lower}, ${upper}] to re-centre`);
    return;
  }

  // 3) Deploy idle inventory. DLMM puts quote at or below the active bin and base at or
  // above it; the mandate additionally requires bids at or below the reference and asks
  // at or above it.
  const lo = Math.max(ref - Math.min(HALF_WIDTH, bandBins), lower);
  const hi = Math.min(ref + Math.min(HALF_WIDTH, bandBins), upper);
  const bids = { min: lo, max: Math.min(ref + 1, pair.activeId, hi) };
  const asks = { min: Math.max(ref, pair.activeId, lo), max: hi };
  const baseIdle = (await getAccount(connection, m.baseVault)).amount;
  const quoteIdle = (await getAccount(connection, m.quoteVault)).amount;
  const refPrice = Math.pow(1 + pair.binStep / 10_000, ref);
  const dust = m.terms.minDepthQuote.toNumber() / 50; // skip anything worth < 2% of the depth target
  m = await fetchMandate(connection, client, MANDATE);
  const ixs: TransactionInstruction[] = [];
  const placed: string[] = [];
  if (bids.min <= bids.max && Number(quoteIdle) >= dust) {
    const amountQuote = fraction(quoteIdle);
    ixs.push(await client.addLiquidity({
      authority: maker.publicKey, mandate: MANDATE, m, pair, amountBase: new BN(0), amountQuote,
      minBinId: bids.min, maxBinId: bids.max, strategy: StrategyType.SpotImBalanced,
    }));
    placed.push(`bids ${amountQuote} in [${bids.min}, ${bids.max}]`);
  }
  if (asks.min <= asks.max && Number(baseIdle) * refPrice >= dust) {
    const amountBase = fraction(baseIdle);
    ixs.push(await client.addLiquidity({
      authority: maker.publicKey, mandate: MANDATE, m, pair, amountBase, amountQuote: new BN(0),
      minBinId: asks.min, maxBinId: asks.max, strategy: StrategyType.SpotImBalanced,
    }));
    placed.push(`asks ${amountBase} in [${asks.min}, ${asks.max}]`);
  }
  if (!ixs.length) return;
  await sendIxs(connection, maker, ixs);
  log("maker", `${placed.join("; ")} (reference ${ref}, active ${pair.activeId})`);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const maker = loadKeypair();
  const client = makeClient(connection, maker);
  log("maker", `mandate=${MANDATE.toBase58()} maker=${maker.publicKey.toBase58()}`);
  for (;;) {
    try {
      await tick(connection, maker, client);
    } catch (e: any) {
      log("error", e.message?.split("\n")[0] ?? String(e));
    }
    await sleep(TICK_MS);
  }
}

main();
