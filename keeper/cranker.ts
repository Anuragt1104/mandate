/**
 * Mandate keeper: samples every active mandate at random times, finalizes elapsed
 * periods, and unwinds + settles breached/expired mandates. Fully permissionless —
 * issuers, makers or anyone can run it.
 *
 *   RPC_URL=https://api.devnet.solana.com KEYPAIR=~/.config/solana/id.json npx tsx keeper/cranker.ts
 *
 * Env: SAMPLES_PER_PERIOD (default 4), TICK_MS (default 10000), MANDATE (optional filter)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { statusName } from "../sdk/src";
import { RPC_URL, chainTime, fetchMandates, fetchPair, loadKeypair, log, makeClient, sendIxs, sleep } from "./common";

const SAMPLES_PER_PERIOD = Number(process.env.SAMPLES_PER_PERIOD ?? 4);
const TICK_MS = Number(process.env.TICK_MS ?? 10_000);
const ONLY = process.env.MANDATE ? new PublicKey(process.env.MANDATE) : null;

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const cranker = loadKeypair();
  const client = makeClient(connection, cranker);
  // Next sample time per mandate, drawn uniformly so makers cannot predict it.
  const nextSample = new Map<string, number>();
  log("cranker", `rpc=${RPC_URL} cranker=${cranker.publicKey.toBase58()}`);

  for (;;) {
    try {
      const now = await chainTime(connection);
      const mandates = (await fetchMandates(connection, client)).filter((x) => !ONLY || x.pubkey.equals(ONLY));
      for (const { pubkey, m } of mandates) {
        const key = pubkey.toBase58();
        const status = statusName(m.status);
        try {
          if (status === "Active") {
            const period = m.terms.periodSecs as number;
            const periodNow = Math.floor((now - m.startTs.toNumber()) / period);
            if (!nextSample.has(key)) nextSample.set(key, now + Math.random() * (period / SAMPLES_PER_PERIOD));
            if (now >= nextSample.get(key)!) {
              await sendIxs(connection, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: pubkey, m })]);
              nextSample.set(key, now + (Math.random() * 2 * period) / SAMPLES_PER_PERIOD);
              log("snapshot", `${key.slice(0, 8)} period=${periodNow}`);
            } else if (periodNow > m.currentPeriod) {
              await sendIxs(connection, cranker, [await client.finalize({ mandate: pubkey, m })]);
              log("finalize", `${key.slice(0, 8)} -> period ${periodNow}`);
            }
          } else if (status === "Breached" || status === "Expired") {
            if (!(m.position as PublicKey).equals(PublicKey.default)) {
              const pair = await fetchPair(connection, m.lbPair);
              await sendIxs(connection, cranker, [
                await client.removeLiquidity({ authority: cranker.publicKey, mandate: pubkey, m, pair }),
                await client.closePosition({ authority: cranker.publicKey, mandate: pubkey, m }),
              ]);
              log("unwind", `${key.slice(0, 8)} (${status})`);
            } else {
              await sendIxs(connection, cranker, [await client.settle({ mandate: pubkey, m })]);
              log("settle", `${key.slice(0, 8)} (${status})`);
            }
          }
        } catch (e: any) {
          log("error", `${key.slice(0, 8)}: ${e.message?.split("\n")[0]}`);
        }
      }
    } catch (e: any) {
      log("error", e.message ?? String(e));
    }
    await sleep(TICK_MS);
  }
}

main();
