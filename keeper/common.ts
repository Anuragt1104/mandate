import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { redact } from "../sdk/src/rpc";
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

/** Local secrets (API keys) live in the repo's gitignored .env; real environment variables win. */
function loadDotEnv() {
  const p = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

/** Extra endpoints of the same cluster to fail over to (comma-separated RPC_FALLBACKS). */
const FALLBACKS =
  process.env.RPC_FALLBACKS !== undefined
    ? process.env.RPC_FALLBACKS.split(",").filter(Boolean)
    : RPC_URL.includes("api.devnet.solana.com")
      ? PUBLIC_FALLBACKS.devnet
      : [];

/** A keyed endpoint from .env (HELIUS_API_KEY) goes first on devnet and mainnet. */
const KEYED = !process.env.HELIUS_API_KEY
  ? null
  : RPC_URL.includes("devnet")
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : RPC_URL.includes("mainnet")
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : null;

/** A connection that fails over between RPC endpoints per method (see sdk/src/rpc.ts). */
export function makeConnection(url = RPC_URL): Connection {
  const endpoints = KEYED && url === RPC_URL ? [KEYED, url, ...FALLBACKS] : [url, ...FALLBACKS];
  return new Connection(endpoints[0], { commitment: "confirmed", fetch: failoverFetch(endpoints, { hedgeMs: 2_500, rounds: 4 }) as any, disableRetryOnRateLimit: true });
}

export function loadKeypair(p = process.env.KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json")): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function makeClient(connection: Connection, wallet: Keypair): MandateClient {
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../sdk/idl/mandate.json"), "utf8")) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  return new MandateClient(new Program(idl, provider));
}

export interface SendOptions {
  /**
   * The instructions are safe to execute twice (checks, finalizes, unwinds, settlement):
   * an expired attempt whose outcome is unknown may be rebuilt with a fresh blockhash.
   * Otherwise (deposits, trades, adds) an unknown outcome is thrown as `UnknownOutcome`.
   */
  idempotent?: boolean;
  /** Give up after this long, in ms (default 90 s), so one stuck transaction can't stall a worker. */
  deadlineMs?: number;
  /** Called with each signature before it is sent, so a caller can persist it. */
  onSigned?: (sig: string) => void;
}

export async function sendIxs(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = [], opts: SendOptions = {}) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  return sendAndConfirm(connection, tx, [payer, ...signers], opts);
}

/** A signed transaction whose fate could not be established: it may or may not have executed. */
export class UnknownOutcome extends Error {
  constructor(public signature: string) {
    super(`transaction ${signature} expired without a known outcome; re-read state before retrying`);
  }
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
 * Sign once, send and confirm by polling (no websocket), backing off on rate limits.
 *
 * The same signed bytes are re-sent while their blockhash is valid, so a slow network can't
 * turn one intent into two transactions. When the blockhash has expired, the signature's
 * status is looked up in history (several times, since failover endpoints can disagree on
 * block height and status) before anything else happens: landed means done, failed means
 * failed, and still unknown means `UnknownOutcome`, unless the instructions are idempotent,
 * in which case a fresh attempt is built.
 */
export async function sendAndConfirm(connection: Connection, tx: Transaction, signers: Keypair[], opts: SendOptions = {}): Promise<string> {
  tx.feePayer = tx.feePayer ?? signers[0].publicKey;
  const deadline = Date.now() + (opts.deadlineMs ?? 90_000);
  const status = async (sig: string, history: boolean) => (await withBackoff(() => connection.getSignatureStatuses([sig], { searchTransactionHistory: history }))).value[0];
  const settled = (st: Awaited<ReturnType<typeof status>>, sig: string) => {
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    return !!st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
  };
  let lastSig = "";
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    const { blockhash, lastValidBlockHeight } = await withBackoff(() => connection.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.signatures = [];
    tx.sign(...signers);
    const raw = tx.serialize();
    const sig = bs58.encode(tx.signature!);
    lastSig = sig;
    opts.onSigned?.(sig);
    // Preflight once, so a transaction that would fail says why; re-sends skip it.
    await withBackoff(() => connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 }));
    let sends = 1;
    while (Date.now() < deadline) {
      await sleep(1_500);
      if (settled(await status(sig, false), sig)) return sig;
      const height = await withBackoff(() => connection.getBlockHeight("confirmed"));
      if (height > lastValidBlockHeight) break;
      if (sends++ % 2 === 0) await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
    // Expired (or out of time): establish what happened before doing anything else.
    for (let look = 0; look < 3; look++) {
      if (settled(await status(sig, true), sig)) return sig;
      await sleep(2_000);
    }
    if (!opts.idempotent) throw new UnknownOutcome(sig);
  }
  throw lastSig ? new UnknownOutcome(lastSig) : new Error("transaction was not sent before its deadline");
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

/** Log lines never carry endpoint URLs or keys. */
export function log(tag: string, msg: string) {
  console.log(`${new Date().toISOString()} [${tag}] ${redact(msg)}`);
}
