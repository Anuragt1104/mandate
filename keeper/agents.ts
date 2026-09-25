/**
 * Reusable behaviours for Mandate participants, used by the single-purpose bots in this
 * folder and by the network simulator (scripts/simulate.ts).
 *
 *   makerTick        a diligent market maker: open a position, deploy inventory as bids at or
 *                    below the reference and asks at or above it, re-centre as it moves
 *   withdrawAll      a negligent maker pulling every bin back into the vault
 *   tradeOnce        a trader swapping on the mandate's DLMM pair
 *   crankOnce        a watchtower: random-time checks, finalization, unwind and settle
 *   sandwichCheck    an attacker buying out the asks, checking, and selling back
 */
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MandateClient, StrategyType, binArrayIndex, binArraysCovering, dlmmInitBinArrayIx, dlmmSwapIx, pda, statusName } from "../sdk/src";
import { chainTime, fetchAnchor, fetchMandate, fetchMandates, fetchPair, sendIxs } from "./common";

const POSITION_WIDTH = 70;
const RECENTER_MARGIN = 12;

export interface MakerOptions {
  halfWidth?: number;
  deployFraction?: number;
  autoAccept?: boolean;
}

/** One step of a diligent maker. Returns a short description of what it did, or null. */
export async function makerTick(
  conn: Connection,
  maker: Keypair,
  client: MandateClient,
  mandate: PublicKey,
  opts: MakerOptions = {},
): Promise<string | null> {
  const halfWidth = opts.halfWidth ?? 8;
  const deployFraction = opts.deployFraction ?? 0.9;
  // Deploy a share of idle inventory; small remainders go in whole rather than in shrinking slices.
  const share = (amount: bigint, value: number, dust: number) =>
    new BN((value < dust * 20 ? amount : (amount * BigInt(Math.round(deployFraction * 1000))) / 1000n).toString());
  let m = await fetchMandate(conn, client, mandate);
  const status = statusName(m.status);
  if (status === "Open" && opts.autoAccept) {
    const quoteAta = getAssociatedTokenAddressSync(m.quoteMint, maker.publicKey, true);
    await sendIxs(conn, maker, [
      createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, quoteAta, maker.publicKey, m.quoteMint),
      await client.accept({ maker: maker.publicKey, mandate, m }),
    ]);
    return "accepted the mandate and posted its bond";
  }
  if (status !== "Active" || !(m.maker as PublicKey).equals(maker.publicKey)) return null;

  const pair = await fetchPair(conn, m.lbPair);
  const now = await chainTime(conn);
  const ref = await fetchAnchor(conn, m, pair.binStep, now);
  const bandBins = Math.floor(Math.log(1 + m.terms.bandBps / 10_000) / Math.log(1 + pair.binStep / 10_000)) - 1;
  const hasPosition = !(m.position as PublicKey).equals(PublicKey.default);

  if (!hasPosition) {
    const lower = ref - Math.floor(POSITION_WIDTH / 2);
    const missing: number[] = [];
    for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + POSITION_WIDTH - 1); i++) {
      if (!(await conn.getAccountInfo(pda.binArray(m.lbPair, i)))) missing.push(i);
    }
    if (missing.length) await sendIxs(conn, maker, missing.map((i) => dlmmInitBinArrayIx(m.lbPair, i, maker.publicKey)));
    await sendIxs(conn, maker, [await client.openPosition({ maker: maker.publicKey, mandate, m, lowerBinId: lower, width: POSITION_WIDTH })]);
    return `opened a position around reference bin ${ref}`;
  }

  const lower = m.positionLowerBinId as number;
  const upper = lower + (m.positionWidth as number) - 1;
  if (ref < lower + RECENTER_MARGIN || ref > upper - RECENTER_MARGIN) {
    if (now - m.lastLiquidityAddTs.toNumber() < m.terms.liquidityLockSecs) return null;
    await sendIxs(conn, maker, [
      await client.removeLiquidity({ authority: maker.publicKey, mandate, m, pair }),
      await client.closePosition({ authority: maker.publicKey, mandate, m }),
    ]);
    return `re-centring: the reference moved to bin ${ref}`;
  }

  const lo = Math.max(ref - Math.min(halfWidth, bandBins), lower);
  const hi = Math.min(ref + Math.min(halfWidth, bandBins), upper);
  const bids = { min: lo, max: Math.min(ref + 1, pair.activeId, hi) };
  const asks = { min: Math.max(ref, pair.activeId, lo), max: hi };
  const baseIdle = (await getAccount(conn, m.baseVault)).amount;
  const quoteIdle = (await getAccount(conn, m.quoteVault)).amount;
  const refPrice = Math.pow(1 + pair.binStep / 10_000, ref);
  const dust = m.terms.minDepthQuote.toNumber() / 50;
  m = await fetchMandate(conn, client, mandate);
  const ixs: TransactionInstruction[] = [];
  const placed: string[] = [];
  if (bids.min <= bids.max && Number(quoteIdle) >= dust) {
    ixs.push(await client.addLiquidity({ authority: maker.publicKey, mandate, m, pair, amountBase: new BN(0), amountQuote: share(quoteIdle, Number(quoteIdle), dust), minBinId: bids.min, maxBinId: bids.max, strategy: StrategyType.SpotImBalanced }));
    placed.push("bids");
  }
  if (asks.min <= asks.max && Number(baseIdle) * refPrice >= dust) {
    ixs.push(await client.addLiquidity({ authority: maker.publicKey, mandate, m, pair, amountBase: share(baseIdle, Number(baseIdle) * refPrice, dust), amountQuote: new BN(0), minBinId: asks.min, maxBinId: asks.max, strategy: StrategyType.SpotImBalanced }));
    placed.push("asks");
  }
  if (!ixs.length) return null;
  await sendIxs(conn, maker, ixs);
  return `deployed ${placed.join(" and ")} around reference bin ${ref}`;
}

/** A negligent maker: pull all liquidity back into the vault (after the lock). */
export async function withdrawAll(conn: Connection, maker: Keypair, client: MandateClient, mandate: PublicKey): Promise<string | null> {
  const m = await fetchMandate(conn, client, mandate);
  if (statusName(m.status) !== "Active" || (m.position as PublicKey).equals(PublicKey.default)) return null;
  const now = await chainTime(conn);
  if (now - m.lastLiquidityAddTs.toNumber() < m.terms.liquidityLockSecs) return null;
  const pair = await fetchPair(conn, m.lbPair);
  await sendIxs(conn, maker, [
    await client.removeLiquidity({ authority: maker.publicKey, mandate, m, pair }),
    await client.closePosition({ authority: maker.publicKey, mandate, m }),
  ]);
  return "pulled all liquidity back into the vault";
}

async function existingBinArrays(conn: Connection, lbPair: PublicKey, activeId: number, direction: "up" | "down" | "both") {
  const lo = direction === "up" ? activeId - 70 : activeId - 210;
  const hi = direction === "down" ? activeId + 70 : activeId + 210;
  let candidates = binArraysCovering(lbPair, lo, hi);
  if (direction === "down") candidates = candidates.reverse();
  const infos = await conn.getMultipleAccountsInfo(candidates);
  return candidates.filter((_, i) => infos[i]);
}

/** Instructions for one swap on the mandate's pair. `quoteSize` is in quote UI units (6 decimals). */
async function swapIxs(conn: Connection, trader: Keypair, m: any, side: "buy" | "sell" | "random", quoteSize: number) {
  const pair = await fetchPair(conn, m.lbPair);
  const userX = getAssociatedTokenAddressSync(pair.tokenX, trader.publicKey);
  const userY = getAssociatedTokenAddressSync(pair.tokenY, trader.publicKey);
  const baseBal = await conn.getTokenAccountBalance(userX).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  let buy = side === "buy" ? true : side === "sell" ? false : Math.random() < 0.5;
  const quoteIn = BigInt(Math.floor(quoteSize * 1e6));
  const price = Math.pow(1 + pair.binStep / 10_000, pair.activeId); // quote atomic per base atomic
  let amountIn = buy ? quoteIn : BigInt(Math.floor(Number(quoteIn) / price));
  if (!buy && amountIn > baseBal) {
    if (baseBal > 0n && side === "sell") amountIn = baseBal;
    else {
      buy = true; // nothing to sell yet
      amountIn = quoteIn;
    }
  }
  const binArrays = await existingBinArrays(conn, m.lbPair, pair.activeId, buy ? "up" : "down");
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, userX, trader.publicKey, pair.tokenX),
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, userY, trader.publicKey, pair.tokenY),
    dlmmSwapIx({ lbPair: m.lbPair, pair, user: trader.publicKey, userTokenIn: buy ? userY : userX, userTokenOut: buy ? userX : userY, amountIn, binArrays }),
  ];
  return { ixs, buy, pair, userX, userY };
}

/** A trader swapping on the mandate's pair: `quoteSize` in quote UI units, or random up to `maxQuote`. */
export async function tradeOnce(
  conn: Connection,
  trader: Keypair,
  client: MandateClient,
  mandate: PublicKey,
  opts: { side?: "buy" | "sell" | "random"; quoteSize?: number; maxQuote?: number } = {},
): Promise<{ buy: boolean; quoteSize: number; text: string }> {
  const m = await fetchMandate(conn, client, mandate);
  const quoteSize = opts.quoteSize ?? (0.2 + Math.random() * 0.8) * (opts.maxQuote ?? 300);
  const { ixs, buy } = await swapIxs(conn, trader, m, opts.side ?? "random", quoteSize);
  await sendIxs(conn, trader, ixs);
  return { buy, quoteSize, text: `${buy ? "bought" : "sold"} ${Math.round(quoteSize).toLocaleString("en-US")} USDC worth` };
}

/** Watchtower state: next check time per mandate, drawn at random so makers can't predict it. */
export type CrankState = Map<string, number>;

export async function crankOnce(
  conn: Connection,
  cranker: Keypair,
  client: MandateClient,
  state: CrankState,
  opts: { samplesPerPeriod?: number; only?: (key: string) => boolean; onEvent?: (key: string, what: string) => void | Promise<void> } = {},
) {
  const samples = opts.samplesPerPeriod ?? 3;
  const now = await chainTime(conn);
  for (const { pubkey, m } of await fetchMandates(conn, client)) {
    const key = pubkey.toBase58();
    if (opts.only && !opts.only(key)) continue;
    const status = statusName(m.status);
    try {
      if (status === "Active") {
        const period = m.terms.periodSecs as number;
        const periodNow = Math.floor((now - m.startTs.toNumber()) / period);
        if (!state.has(key)) state.set(key, now + Math.random() * (period / samples));
        if (now >= state.get(key)!) {
          await sendIxs(conn, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: pubkey, m })]);
          state.set(key, now + (Math.random() * 2 * period) / samples);
          await opts.onEvent?.(key, `checked (period ${periodNow + 1})`);
        } else if (periodNow > m.currentPeriod) {
          await sendIxs(conn, cranker, [await client.finalize({ mandate: pubkey, m })]);
          await opts.onEvent?.(key, `closed out periods through ${periodNow}`);
        }
      } else if (status === "Breached" || status === "Expired") {
        if (!(m.position as PublicKey).equals(PublicKey.default)) {
          const pair = await fetchPair(conn, m.lbPair);
          await sendIxs(conn, cranker, [
            await client.removeLiquidity({ authority: cranker.publicKey, mandate: pubkey, m, pair }),
            await client.closePosition({ authority: cranker.publicKey, mandate: pubkey, m }),
          ]);
          await opts.onEvent?.(key, `unwound the ${status.toLowerCase()} mandate`);
        } else {
          const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
          await sendIxs(conn, cranker, [
            createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, ata(m.baseMint, m.issuer), m.issuer, m.baseMint),
            createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, ata(m.quoteMint, m.issuer), m.issuer, m.quoteMint),
            createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, ata(m.quoteMint, m.maker), m.maker, m.quoteMint),
            await client.settle({ mandate: pubkey, m }),
          ]);
          await opts.onEvent?.(key, `settled the ${status.toLowerCase()} mandate`);
        }
      }
    } catch (e: any) {
      await opts.onEvent?.(key, `error: ${e.message?.split("\n")[0] ?? e}`);
    }
  }
}

/**
 * The attack the scoring is built to survive: buy out the maker's asks and force a check in
 * the same transaction, while the book is lopsided, then sell back. Returns whether the
 * check still passed and how far the buy pushed the price.
 */
export async function sandwichCheck(
  conn: Connection,
  attacker: Keypair,
  client: MandateClient,
  mandate: PublicKey,
  quoteSize: number,
): Promise<{ passed: boolean; movedBins: number }> {
  const m = await fetchMandate(conn, client, mandate);
  if (statusName(m.status) !== "Active") return { passed: true, movedBins: 0 };
  const buy = await swapIxs(conn, attacker, m, "buy", quoteSize);
  const baseBefore = await conn.getTokenAccountBalance(buy.userX).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  await sendIxs(conn, attacker, [...buy.ixs, await client.snapshot({ cranker: attacker.publicKey, mandate, m })]);
  const [after, pushed] = await Promise.all([fetchMandate(conn, client, mandate), fetchPair(conn, m.lbPair)]);
  const bought = (await conn.getTokenAccountBalance(buy.userX).then((b) => BigInt(b.value.amount)).catch(() => 0n)) - baseBefore;
  if (bought > 0n) {
    const binArrays = await existingBinArrays(conn, m.lbPair, pushed.activeId, "down");
    await sendIxs(conn, attacker, [dlmmSwapIx({ lbPair: m.lbPair, pair: pushed, user: attacker.publicKey, userTokenIn: buy.userX, userTokenOut: buy.userY, amountIn: bought, binArrays })]);
  }
  return { passed: !!after.last.ok, movedBins: pushed.activeId - buy.pair.activeId };
}
