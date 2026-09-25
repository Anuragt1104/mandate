/**
 * Demo trader: random small buys and sells on a mandate's DLMM pair, so the book moves
 * and the maker has something to do.   RPC_URL=... KEYPAIR=.keys/trader.json MANDATE=... npx tsx keeper/trader.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { binArraysCovering, dlmmSwapIx } from "../sdk/src";
import { RPC_URL, fetchMandate, fetchPair, loadKeypair, log, makeClient, sendIxs, sleep } from "./common";

const MANDATE = new PublicKey(process.env.MANDATE!);
const TICK_MS = Number(process.env.TICK_MS ?? 15_000);
const MAX_QUOTE = Number(process.env.MAX_QUOTE ?? 300); // per trade, UI units

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const trader = loadKeypair();
  const client = makeClient(conn, trader);
  for (;;) {
    try {
      const m = await fetchMandate(conn, client, MANDATE);
      const pair = await fetchPair(conn, m.lbPair);
      const baseBal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(pair.tokenX, trader.publicKey)).then((b) => BigInt(b.value.amount)).catch(() => 0n);
      let buy = Math.random() < 0.5;
      const quoteIn = BigInt(Math.floor((0.2 + Math.random() * 0.8) * MAX_QUOTE * 1e6));
      const price = Math.pow(1 + pair.binStep / 10_000, pair.activeId); // quote atomic per base atomic
      let amountIn = buy ? quoteIn : BigInt(Math.floor(Number(quoteIn) / price));
      if (!buy && amountIn > baseBal) {
        buy = true; // nothing to sell yet
        amountIn = quoteIn;
      }
      const userX = getAssociatedTokenAddressSync(pair.tokenX, trader.publicKey);
      const userY = getAssociatedTokenAddressSync(pair.tokenY, trader.publicKey);
      const candidates = binArraysCovering(m.lbPair, pair.activeId - 140, pair.activeId + 140);
      const infos = await conn.getMultipleAccountsInfo(candidates);
      const binArrays = candidates.filter((_, i) => infos[i]);
      await sendIxs(conn, trader, [
        createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, userX, trader.publicKey, pair.tokenX),
        createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, userY, trader.publicKey, pair.tokenY),
        dlmmSwapIx({
          lbPair: m.lbPair, pair, user: trader.publicKey,
          userTokenIn: buy ? userY : userX, userTokenOut: buy ? userX : userY,
          amountIn, binArrays,
        }),
      ]);
      log("trader", `${buy ? "bought" : "sold"} ~${(Number(quoteIn) / 1e6).toFixed(2)} quote worth (active bin ${pair.activeId})`);
    } catch (e: any) {
      log("error", `${e.message?.split("\n")[0] ?? e} ${(e.logs ?? e.transactionLogs ?? []).filter((l: string) => /Error|error/.test(l)).slice(-2).join(" | ")}`);
    }
    await sleep(TICK_MS + Math.random() * TICK_MS);
  }
}
main();
