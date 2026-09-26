/**
 * Shared drafts from the command line: the same documents and links as the app's Draft page,
 * signed with keypairs. Used by scripts/draft.ts and the simulator's scenes.
 */
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";
import { MandateClient, approvalMessage, base58Encode, draftToChain, loadAccounts, packLink, pda, termsHash, unpackLink, type DraftDoc, type Party } from "../../sdk/src";
import { sendIxs } from "../../keeper/common";

export const APP_URL = process.env.APP_URL ?? "https://mandate-lac-rho.vercel.app";

export async function linkFor(doc: DraftDoc) {
  return `${APP_URL}/app/draft#d=${await packLink(doc)}`;
}

export async function docFrom(link: string): Promise<DraftDoc> {
  const m = link.match(/[#&]d=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("not a draft link (#d=…)");
  const d = await unpackLink<DraftDoc>(m[1]);
  if (d?.kind !== "mandate-draft") throw new Error("not a Mandate draft");
  return d;
}

/** Sign the latest version as `party` with `kp` (which must be the wallet the draft names). */
export async function approveAs(doc: DraftDoc, kp: Keypair, party: Party): Promise<DraftDoc> {
  const expected = party === "team" ? doc.team : doc.operator;
  if (expected !== kp.publicKey.toBase58()) throw new Error(`the draft names ${expected ?? "no wallet"} as the ${party}, not ${kp.publicKey.toBase58()}`);
  const n = doc.versions[doc.versions.length - 1].n;
  const hash = await termsHash(doc, n);
  const sig = ed25519.sign(approvalMessage(hash, party), kp.secretKey.slice(0, 32));
  return { ...doc, approvals: [...doc.approvals, { n, party, signer: kp.publicKey.toBase58(), hash, sig: base58Encode(sig) }] };
}

/** Fund and post exactly the latest version as the team. Returns the agreement address. */
export async function fundAs(conn: Connection, client: MandateClient, team: Keypair, doc: DraftDoc): Promise<{ doc: DraftDoc; mandate: PublicKey }> {
  if (doc.team !== team.publicKey.toBase58()) throw new Error("only the team named in the draft funds it");
  if (!doc.operator) throw new Error("the draft names no operator");
  const t = doc.versions[doc.versions.length - 1].terms;
  const m = doc.market;
  const base = new PublicKey(m.baseMint);
  const quote = new PublicKey(m.quoteMint);
  const { infos } = await loadAccounts(conn, [base, quote]);
  const x = draftToChain(t, infos[0]!.data[44], infos[1]!.data[44]);
  const bn = (v: bigint) => new BN(v.toString());
  let id = Math.floor(Date.now() / 1000);
  while (await conn.getAccountInfo(pda.mandate(team.publicKey, base, id))) id++;
  const mandate = pda.mandate(team.publicKey, base, id);
  await sendIxs(conn, team, [
    createAssociatedTokenAccountIdempotentInstruction(team.publicKey, getAssociatedTokenAddressSync(base, team.publicKey, true), team.publicKey, base),
    createAssociatedTokenAccountIdempotentInstruction(team.publicKey, getAssociatedTokenAddressSync(quote, team.publicKey, true), team.publicKey, quote),
    await client.createMandate({
      issuer: team.publicKey, baseMint: base, quoteMint: quote, lbPair: new PublicKey(m.lbPair), referencePool: new PublicKey(m.referencePool), id,
      terms: { ...x.terms, feePerPeriod: bn(x.terms.feePerPeriod), bondAmount: bn(x.terms.bondAmount), minDepthQuote: bn(x.terms.minDepthQuote) },
      baseDeposit: bn(x.baseDeposit), quoteDeposit: bn(x.quoteDeposit), feeBudget: bn(x.feeBudget),
      designatedMaker: new PublicKey(doc.operator),
    }),
  ]);
  return { doc: { ...doc, posted: { mandate: mandate.toBase58(), sig: "" } }, mandate };
}
