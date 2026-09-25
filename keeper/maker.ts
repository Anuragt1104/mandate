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
import { Connection, PublicKey } from "@solana/web3.js";
import { makerTick } from "./agents";
import { RPC_URL, loadKeypair, log, makeClient, makeConnection, sleep } from "./common";

const MANDATE = new PublicKey(process.env.MANDATE ?? (() => { throw new Error("MANDATE env required"); })());
const TICK_MS = Number(process.env.TICK_MS ?? 20_000);

async function main() {
  const connection = makeConnection();
  const maker = loadKeypair();
  const client = makeClient(connection, maker);
  const opts = {
    halfWidth: Number(process.env.HALF_WIDTH_BINS ?? 8),
    deployFraction: Number(process.env.DEPLOY_FRACTION ?? 0.9),
    autoAccept: process.env.AUTO_ACCEPT === "1",
  };
  log("maker", `mandate=${MANDATE.toBase58()} maker=${maker.publicKey.toBase58()}`);
  for (;;) {
    try {
      const did = await makerTick(connection, maker, client, MANDATE, opts);
      if (did) log("maker", did);
    } catch (e: any) {
      log("error", e.message?.split("\n")[0] ?? String(e));
    }
    await sleep(TICK_MS);
  }
}

main();
