/**
 * Demo trader: random small buys and sells on a mandate's DLMM pair, so the book moves
 * and the maker has something to do.   RPC_URL=... KEYPAIR=.keys/trader.json MANDATE=... npx tsx keeper/trader.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { tradeOnce } from "./agents";
import { RPC_URL, loadKeypair, log, makeClient, makeConnection, sleep } from "./common";

const MANDATE = new PublicKey(process.env.MANDATE!);
const TICK_MS = Number(process.env.TICK_MS ?? 15_000);
const MAX_QUOTE = Number(process.env.MAX_QUOTE ?? 300); // per trade, UI units

async function main() {
  const conn = makeConnection();
  const trader = loadKeypair();
  const client = makeClient(conn, trader);
  for (;;) {
    try {
      log("trader", (await tradeOnce(conn, trader, client, MANDATE, { maxQuote: MAX_QUOTE })).text);
    } catch (e: any) {
      log("error", `${e.message?.split("\n")[0] ?? e} ${(e.logs ?? e.transactionLogs ?? []).filter((l: string) => /Error|error/.test(l)).slice(-2).join(" | ")}`);
    }
    await sleep(TICK_MS + Math.random() * TICK_MS);
  }
}
main();
