/**
 * Shared drafts from the command line, for teams and operators who sign with keypairs (and
 * for the simulator). Links are the same as the app's Draft page.
 *
 *   npx tsx scripts/draft.ts show '<link>'
 *   npx tsx scripts/draft.ts approve --key <keypair.json> --as team|operator '<link>'
 *   npx tsx scripts/draft.ts fund --key <keypair.json> '<link>'
 */
import { approvalState, diffTerms } from "../sdk/src";
import { loadKeypair, makeClient, makeConnection } from "../keeper/common";
import { approveAs, docFrom, fundAs, linkFor } from "./lib/drafts";

const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const link = argv.find((a) => a.includes("#d="));

async function main() {
  const cmd = argv[0];
  if (!link) throw new Error("pass the draft link (quoted)");
  let doc = await docFrom(link);
  if (cmd === "show") {
    const st = await approvalState(doc);
    console.log(`${doc.title ?? "Draft"} · version ${st.latest.n} by the ${st.latest.by} · terms ${st.hash.slice(0, 12)}`);
    for (const [i, v] of doc.versions.entries()) {
      const changes = i ? diffTerms(doc.versions[i - 1].terms, v.terms) : [];
      console.log(`  v${v.n} (${v.by})${v.note ? ` "${v.note}"` : ""}${changes.map((c) => `\n     ${c.group} · ${c.label}: ${c.from} → ${c.to}`).join("")}`);
    }
    console.log(`  team ${st.team ? "approved" : "not yet"} · operator ${st.operator ? "approved" : "not yet"}${st.agreed ? " · AGREED" : ""}${doc.posted ? ` · posted ${doc.posted.mandate}` : ""}`);
    return;
  }
  const key = arg("key");
  if (!key) throw new Error("--key <keypair.json> is required");
  const kp = loadKeypair(key);
  if (cmd === "approve") {
    const party = arg("as") as "team" | "operator";
    if (party !== "team" && party !== "operator") throw new Error("--as team|operator");
    doc = await approveAs(doc, kp, party);
  } else if (cmd === "fund") {
    const st = await approvalState(doc);
    if (!st.agreed) throw new Error("both parties must approve the latest version first");
    const conn = makeConnection();
    const r = await fundAs(conn, makeClient(conn, kp), kp, doc);
    doc = r.doc;
    console.log(`posted ${r.mandate.toBase58()}`);
  } else throw new Error("commands: show | approve | fund");
  console.log(await linkFor(doc));
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
