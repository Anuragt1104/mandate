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
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { MANDATE_PROGRAM_ID, MandateClient, anchorState, decodeDammPool, decodeLbPair, decodeOracleLatest, projectAnchor } from "../sdk/src";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

export function loadKeypair(p = process.env.KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json")): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function makeClient(connection: Connection, wallet: Keypair): MandateClient {
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/mandate.json"), "utf8")) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  return new MandateClient(new Program(idl, provider));
}

export async function sendIxs(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: "confirmed", skipPreflight: false });
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
