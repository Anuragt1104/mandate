import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { MANDATE_PROGRAM_ID, MandateClient, PUBLIC_FALLBACKS, anchorState, decodeDammPool, decodeLbPair, decodeOracleLatest, failoverFetch, projectAnchor } from "../sdk/src";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

/** Extra endpoints of the same cluster to fail over to (comma-separated RPC_FALLBACKS). */
const FALLBACKS =
  process.env.RPC_FALLBACKS !== undefined
    ? process.env.RPC_FALLBACKS.split(",").filter(Boolean)
    : RPC_URL.includes("api.devnet.solana.com")
      ? PUBLIC_FALLBACKS.devnet
      : [];

/** A connection that fails over between RPC endpoints per method (see sdk/src/rpc.ts). */
export function makeConnection(url = RPC_URL): Connection {
  return new Connection(url, { commitment: "confirmed", fetch: failoverFetch([url, ...FALLBACKS], { hedgeMs: 2_500, rounds: 4 }) as any, disableRetryOnRateLimit: true });
}

export function loadKeypair(p = process.env.KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json")): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function makeClient(connection: Connection, wallet: Keypair): MandateClient {
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../sdk/idl/mandate.json"), "utf8")) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  return new MandateClient(new Program(idl, provider));
}

export async function sendIxs(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  return sendAndConfirm(connection, tx, [payer, ...signers]);
}

const isRateLimited = (e: any) => /429|Too many requests/i.test(String(e?.message ?? e));

/** Retry an RPC call with exponential backoff while the node answers 429. */
export async function withBackoff<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || i >= tries - 1) throw e;
      await sleep(Math.min(16_000, 1_000 * 2 ** i));
    }
  }
}

/**
 * Sign, send and confirm by polling (no websocket), backing off on rate limits. Public
 * devnet RPC throttles hard; this keeps multi-transaction scripts moving.
 */
export async function sendAndConfirm(connection: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer = tx.feePayer ?? signers[0].publicKey;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await withBackoff(() => connection.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.signatures = [];
    tx.sign(...signers);
    const raw = tx.serialize();
    const sig = await withBackoff(() => connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 }));
    for (;;) {
      await sleep(1_500);
      const st = (await withBackoff(() => connection.getSignatureStatuses([sig]))).value[0];
      if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
      const height = await withBackoff(() => connection.getBlockHeight("confirmed"));
      if (height > lastValidBlockHeight) break; // expired: re-sign with a fresh blockhash
    }
  }
  throw new Error("transaction expired three times without confirming");
}

export interface MandateView {
  pubkey: PublicKey;
  m: any;
}

/** All mandate accounts (filtered by Anchor discriminator). */
export async function fetchMandates(connection: Connection, client: MandateClient): Promise<MandateView[]> {
  const disc = client.program.idl.accounts!.find((a: any) => a.name.toLowerCase() === "mandate")!.discriminator;
  const accs = await connection.getProgramAccounts(MANDATE_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(disc)) } }],
  });
  return accs.map((a) => ({ pubkey: a.pubkey, m: client.decodeMandate(a.account.data) }));
}

export async function fetchMandate(connection: Connection, client: MandateClient, pubkey: PublicKey) {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) throw new Error(`mandate ${pubkey.toBase58()} not found`);
  return client.decodeMandate(info.data);
}

export async function fetchPair(connection: Connection, lbPair: PublicKey) {
  const info = await connection.getAccountInfo(lbPair);
  if (!info) throw new Error("lb pair not found");
  return decodeLbPair(info.data);
}

/** Reference price (quote atomic per base atomic) from the DAMM v2 pool. */
export async function fetchReferencePrice(connection: Connection, pool: PublicKey, baseMint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(pool);
  if (!info) throw new Error("reference pool not found");
  const p = decodeDammPool(info.data);
  const price = Number(p.sqrtPrice) ** 2 / 2 ** 128;
  return p.tokenA.equals(baseMint) ? price : 1 / price;
}

/** The reference bin the next `add_liquidity` / `snapshot` will see. */
export async function fetchAnchor(connection: Connection, m: any, binStep: number, now: number): Promise<number> {
  const info = await connection.getAccountInfo(m.oracle);
  const sample = info ? decodeOracleLatest(info.data) : null;
  return projectAnchor(anchorState(m), sample, m.terms, binStep, now).bin;
}

export async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(tag: string, msg: string) {
  console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
}
