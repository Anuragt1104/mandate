"use client";

import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import idl from "../../../sdk/idl/mandate.json";
import {
  MANDATE_PROGRAM_ID,
  MandateClient,
  decodeBinArray,
  anchorState,
  decodeDammPool,
  decodeOracleLatest,
  projectAnchor,
  decodeLbPair,
  decodePosition,
  pda,
  binArraysCovering,
} from "../../../sdk/src";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "localnet";

let _conn: Connection | null = null;
export function connection(): Connection {
  // No automatic retries on 429: usePoll backs off instead, which avoids retry storms
  // against rate-limited public endpoints.
  if (!_conn) _conn = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true });
  return _conn;
}

/** Read-only client (a throwaway wallet; never signs). */
let _ro: MandateClient | null = null;
export function readClient(): MandateClient {
  if (!_ro) {
    const wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t: Transaction) => t,
      signAllTransactions: async (t: Transaction[]) => t,
    };
    _ro = new MandateClient(new Program(idl as Idl, new AnchorProvider(connection(), wallet as any, {})));
  }
  return _ro;
}

export function explorerUrl(sig: string) {
  const custom = CLUSTER === "localnet" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : CLUSTER === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${sig}${custom}`;
}

export const short = (k: PublicKey | string, n = 4) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export interface MandateRow {
  pubkey: PublicKey;
  m: any;
}

export async function fetchAllMandates(): Promise<MandateRow[]> {
  const client = readClient();
  const disc = (idl as any).accounts.find((a: any) => a.name === "Mandate").discriminator as number[];
  const bs58 = (await import("bs58")).default;
  const accs = await connection().getProgramAccounts(MANDATE_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(disc)) } }],
  });
  return accs
    .map((a) => ({ pubkey: a.pubkey, m: client.decodeMandate(a.account.data) }))
    .sort((a, b) => b.m.createdAt.toNumber() - a.m.createdAt.toNumber());
}

export async function fetchMandate(pubkey: PublicKey) {
  const info = await connection().getAccountInfo(pubkey);
  return info ? readClient().decodeMandate(info.data) : null;
}

export async function fetchScoreLog(pubkey: PublicKey) {
  const info = await connection().getAccountInfo(pubkey);
  if (!info) return [];
  const log = readClient().decodeScoreLog(info.data);
  const n = log.count as number;
  const head = log.head as number;
  const len = log.entries.length as number;
  const out: any[] = [];
  for (let i = 0; i < n; i++) out.push(log.entries[(head - n + i + len) % len]);
  return out;
}

export async function fetchMakerProfiles() {
  const client = readClient();
  const disc = (idl as any).accounts.find((a: any) => a.name === "MakerProfile").discriminator as number[];
  const bs58 = (await import("bs58")).default;
  const accs = await connection().getProgramAccounts(MANDATE_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(disc)) } }],
  });
  return accs.map((a) => ({ pubkey: a.pubkey, p: client.decodeMakerProfile(a.account.data) }));
}

export async function tokenAmounts(accounts: PublicKey[]): Promise<bigint[]> {
  const infos = await connection().getMultipleAccountsInfo(accounts);
  return infos.map((i) => (i ? AccountLayout.decode(i.data).amount : 0n));
}

const decimalsCache = new Map<string, number>();
export async function mintDecimals(mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const info = await connection().getAccountInfo(mint);
  if (!info) return 6;
  decimalsCache.set(key, info.data[44]);
  return info.data[44];
}

export interface BookBin {
  binId: number;
  base: number; // UI units
  quote: number; // UI units
  priceUi: number;
}

/**
 * The mandate position's liquidity per bin, plus pair context: the reference bin the
 * next check will use (projected from the DLMM oracle), and the graduated pool's price.
 */
export async function fetchBook(m: any) {
  const conn = connection();
  const hasPos = !(m.position as PublicKey).equals(PublicKey.default);
  const [pairInfo, dammInfo, oracleInfo, posInfo] = await conn.getMultipleAccountsInfo(
    hasPos ? [m.lbPair, m.referencePool, m.oracle, m.position] : [m.lbPair, m.referencePool, m.oracle],
  );
  if (!pairInfo) return null;
  const pair = decodeLbPair(pairInfo.data);
  const [bd, qd] = await Promise.all([mintDecimals(m.baseMint), mintDecimals(m.quoteMint)]);
  const toUiPrice = (atomic: number) => atomic * Math.pow(10, bd - qd);
  const binUi = (b: number) => toUiPrice(Math.pow(1 + pair.binStep / 10_000, b));
  let dammUi = 0;
  if (dammInfo) {
    const p = decodeDammPool(dammInfo.data);
    const atomic = Number(p.sqrtPrice) ** 2 / 2 ** 128;
    dammUi = toUiPrice(p.tokenA.equals(m.baseMint) ? atomic : 1 / atomic);
  }
  const sample = oracleInfo ? decodeOracleLatest(oracleInfo.data) : null;
  const projected = projectAnchor(anchorState(m), sample, m.terms, pair.binStep, Math.floor(Date.now() / 1000));
  const refBin = projected.bin;
  const refUi = binUi(refBin);
  const bins: BookBin[] = [];
  if (hasPos) {
    if (posInfo) {
      const pos = decodePosition(posInfo.data);
      const arrays = await conn.getMultipleAccountsInfo(binArraysCovering(m.lbPair, pos.lowerBinId, pos.upperBinId));
      const byIndex = new Map<number, ReturnType<typeof decodeBinArray>>();
      arrays.forEach((a) => {
        if (a) {
          const d = decodeBinArray(a.data);
          byIndex.set(d.index, d);
        }
      });
      for (let b = pos.lowerBinId; b <= pos.upperBinId; b++) {
        const share = pos.shares[b - pos.lowerBinId];
        const idx = Math.floor(b / 70);
        const arr = byIndex.get(idx);
        if (!arr || share === 0n) continue;
        const bin = arr.bins[b - idx * 70];
        if (bin.liquiditySupply === 0n) continue;
        const x = Number((bin.amountX * share) / bin.liquiditySupply) / 10 ** bd;
        const y = Number((bin.amountY * share) / bin.liquiditySupply) / 10 ** qd;
        bins.push({ binId: b, base: x, quote: y, priceUi: binUi(b) });
      }
    }
  }
  const activeUi = binUi(pair.activeId);
  return { pair, bins, refBin, refUi, targetBin: projected.target, dammUi, activeUi, baseDecimals: bd, quoteDecimals: qd };
}

export { pda };
