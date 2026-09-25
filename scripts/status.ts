/** Print the live state of every mandate on a cluster.  RPC_URL=... npx tsx scripts/status.ts */
import { Connection, Keypair } from "@solana/web3.js";
import { statusName } from "../sdk/src";
import { RPC_URL, fetchMandates, makeClient } from "../keeper/common";

(async () => {
  const conn = new Connection(RPC_URL, "confirmed");
  const client = makeClient(conn, Keypair.generate());
  for (const { pubkey, m } of await fetchMandates(conn, client)) {
    console.log(
      pubkey.toBase58(),
      statusName(m.status).padEnd(9),
      `period=${m.currentPeriod} ok=${m.periodsOk} failed=${m.periodsFailed} unobserved=${m.periodsUnobserved} snaps=${m.snapshotsTotal}`,
      `last={ok:${m.last.ok}, spread:${m.last.spreadBps}bps, bid:${m.last.bidDepthQuote}, ask:${m.last.askDepthQuote}, dev:${m.last.refDeviationBps}bps}`,
    );
  }
})();
