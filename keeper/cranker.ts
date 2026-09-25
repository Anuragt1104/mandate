/**
 * Mandate keeper: samples every active mandate at random times, finalizes elapsed
 * periods, and unwinds + settles breached/expired mandates. Fully permissionless —
 * issuers, makers or anyone can run it.
 *
 *   RPC_URL=https://api.devnet.solana.com KEYPAIR=~/.config/solana/id.json npx tsx keeper/cranker.ts
 *
 * Env: SAMPLES_PER_PERIOD (default 4), TICK_MS (default 10000), MANDATE (optional filter)
 */
import { Connection } from "@solana/web3.js";
import { CrankState, crankOnce } from "./agents";
import { RPC_URL, loadKeypair, log, makeClient, makeConnection, sleep } from "./common";

const SAMPLES_PER_PERIOD = Number(process.env.SAMPLES_PER_PERIOD ?? 4);
const TICK_MS = Number(process.env.TICK_MS ?? 10_000);
const ONLY = process.env.MANDATE ?? null;

async function main() {
  const connection = makeConnection();
  const cranker = loadKeypair();
  const client = makeClient(connection, cranker);
  // Next sample time per mandate, drawn uniformly so makers cannot predict it.
  const state: CrankState = new Map();
  log("cranker", `rpc=${RPC_URL} cranker=${cranker.publicKey.toBase58()}`);
  for (;;) {
    try {
      await crankOnce(connection, cranker, client, state, {
        samplesPerPeriod: SAMPLES_PER_PERIOD,
        only: ONLY ? (k) => k === ONLY : undefined,
        onEvent: (k, what) => log(what.startsWith("error") ? "error" : "cranker", `${k.slice(0, 8)} ${what}`),
      });
    } catch (e: any) {
      log("error", e.message ?? String(e));
    }
    await sleep(TICK_MS);
  }
}

main();
