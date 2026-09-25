/**
 * Reference market-maker bot for a mandate. Keeps a DLMM position centred on the active
 * bin, deploys idle vault inventory inside the allowed band, and re-centres when the
 * price drifts. Deliberately simple: a real maker would add inventory skew, volatility-
 * aware widths and hedging with its own capital.
 *
 *   RPC_URL=... KEYPAIR=maker.json MANDATE=<pubkey> npx tsx keeper/maker.ts
 *
 * Env: HALF_WIDTH_BINS (default 8), DEPLOY_FRACTION (default 0.9), TICK_MS (default 20000),
 *      AUTO_ACCEPT=1 to accept an open mandate automatically.
 */
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { StrategyType, binArrayIndex, binIdForAtomicPrice, dlmmInitBinArrayIx, pda, statusName } from "../sdk/src";
import { RPC_URL, chainTime, fetchMandate, fetchPair, fetchReferencePrice, loadKeypair, log, makeClient, sendIxs, sleep } from "./common";

const MANDATE = new PublicKey(process.env.MANDATE ?? (() => { throw new Error("MANDATE env required"); })());
const HALF_WIDTH = Number(process.env.HALF_WIDTH_BINS ?? 8);
const DEPLOY_FRACTION = Number(process.env.DEPLOY_FRACTION ?? 0.9);
const TICK_MS = Number(process.env.TICK_MS ?? 20_000);
const POSITION_WIDTH = 70;
const RECENTER_MARGIN = 10;

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
  const ref = await fetchReferencePrice(connection, m.referencePool, m.baseMint);
  const bandLo = binIdForAtomicPrice(ref * (1 - m.terms.bandBps / 10_000), pair.binStep) + 1;
  const bandHi = binIdForAtomicPrice(ref * (1 + m.terms.bandBps / 10_000), pair.binStep) - 1;
  const hasPosition = !(m.position as PublicKey).equals(PublicKey.default);

  // 1) Open a position centred on the active bin.
  if (!hasPosition) {
    const lower = pair.activeId - Math.floor(POSITION_WIDTH / 2);
    const missing: number[] = [];
    for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + POSITION_WIDTH - 1); i++) {
      if (!(await connection.getAccountInfo(pda.binArray(m.lbPair, i)))) missing.push(i);
    }
    if (missing.length) {
      await sendIxs(connection, maker, missing.map((i) => dlmmInitBinArrayIx(m.lbPair, i, maker.publicKey)));
      log("maker", `initialized bin arrays ${missing.join(", ")}`);
    }
    await sendIxs(connection, maker, [await client.openPosition({ maker: maker.publicKey, mandate: MANDATE, m, lowerBinId: lower, width: POSITION_WIDTH })]);
    log("maker", `opened position [${lower}, ${lower + POSITION_WIDTH - 1}]`);
    return;
  }

  // 2) Re-centre when price drifts toward the edge of the position.
  const lower = m.positionLowerBinId as number;
  const upper = lower + (m.positionWidth as number) - 1;
  if (pair.activeId < lower + RECENTER_MARGIN || pair.activeId > upper - RECENTER_MARGIN) {
    const now = await chainTime(connection);
    if (now - m.lastLiquidityAddTs.toNumber() < m.terms.minSnapshotIntervalSecs) return;
    await sendIxs(connection, maker, [
      await client.removeLiquidity({ authority: maker.publicKey, mandate: MANDATE, m, pair }),
      await client.closePosition({ authority: maker.publicKey, mandate: MANDATE, m }),
    ]);
    log("maker", `price drifted to ${pair.activeId}; closed position [${lower}, ${upper}] to re-centre`);
    return;
  }

  // 3) Deploy idle inventory around the active bin, inside the band and the position.
  const minBin = Math.max(pair.activeId - HALF_WIDTH, bandLo, lower);
  const maxBin = Math.min(pair.activeId + HALF_WIDTH, bandHi, upper);
  if (minBin > maxBin) {
    log("maker", `no bins allowed: active=${pair.activeId} band=[${bandLo}, ${bandHi}]`);
    return;
  }
  const baseIdle = (await getAccount(connection, m.baseVault)).amount;
  const quoteIdle = (await getAccount(connection, m.quoteVault)).amount;
  const amountBase = new BN(((baseIdle * BigInt(Math.round(DEPLOY_FRACTION * 1000))) / 1000n).toString());
  const amountQuote = new BN(((quoteIdle * BigInt(Math.round(DEPLOY_FRACTION * 1000))) / 1000n).toString());
  // Skip dust: only deploy when idle inventory is worth at least 2% of the depth target.
  const minQuote = m.terms.minDepthQuote.toNumber() / 50;
  const idleValue = amountQuote.toNumber() + amountBase.toNumber() * ref;
  if (idleValue < minQuote) return;
  m = await fetchMandate(connection, client, MANDATE);
  await sendIxs(connection, maker, [
    await client.addLiquidity({
      authority: maker.publicKey,
      mandate: MANDATE,
      m,
      pair,
      amountBase,
      amountQuote,
      minBinId: minBin,
      maxBinId: maxBin,
      strategy: StrategyType.SpotImBalanced,
    }),
  ]);
  log("maker", `deployed base=${amountBase} quote=${amountQuote} into bins [${minBin}, ${maxBin}] (active ${pair.activeId})`);
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
