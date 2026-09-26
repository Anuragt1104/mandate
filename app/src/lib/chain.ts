"use client";

import { Buffer } from "buffer";
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
  failoverFetch,
  loadAccounts,
  measureAccounts,
  referenceQuality,
  PUBLIC_FALLBACKS,
  type BinInfo,
  type CommittedResult,
  type ReferenceQuality,
} from "../../../sdk/src";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "localnet";
const FALLBACKS = (process.env.NEXT_PUBLIC_RPC_FALLBACKS ?? "").split(",").filter(Boolean);

/**
 * HTTP requests go through a per-method hedged failover (sdk/src/rpc.ts). In the browser the
 * first endpoint is the app's own /api/rpc proxy, which reaches the cluster from Vercel's
 * network, so a throttled client IP doesn't stall the page; direct endpoints are fallbacks.
 * Websocket subscriptions still use the cluster's own endpoint.
 */
const DIRECT = [RPC_URL, ...(FALLBACKS.length ? FALLBACKS : (PUBLIC_FALLBACKS[CLUSTER] ?? []))];
const USE_PROXY = CLUSTER !== "localnet" && process.env.NEXT_PUBLIC_RPC_PROXY !== "off";
let _fetch: ReturnType<typeof failoverFetch> | null = null;
export const rpcFetch = (input: any, init?: any): Promise<Response> => {
  if (!_fetch) {
    const proxy = USE_PROXY && typeof window !== "undefined" ? [`${window.location.origin}/api/rpc`] : [];
    _fetch = failoverFetch([...proxy, ...DIRECT], { timeoutMs: 8_000, hedgeMs: proxy.length ? 2_500 : 1_500, rounds: 2 });
  }
  return _fetch(input, init);
};

let _conn: Connection | null = null;
export function connection(): Connection {
  // No automatic retries on 429: usePoll backs off instead, which avoids retry storms
  // against rate-limited public endpoints.
  if (!_conn) _conn = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: rpcFetch as any });
  return _conn;
}

/** Clusters the monitor can read. The app's own cluster uses connection(); mainnet goes through the proxy read-only. */
export type ReadCluster = "devnet" | "mainnet" | "localnet";
const _byCluster = new Map<string, Connection>();
export function connectionFor(cluster: ReadCluster): Connection {
  if (cluster === CLUSTER || cluster === "localnet") return connection();
  let c = _byCluster.get(cluster);
  if (!c) {
    const direct = cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
    const proxy = typeof window !== "undefined" && CLUSTER !== "localnet" ? [`${window.location.origin}/api/rpc?cluster=${cluster}`] : [];
    const f = failoverFetch([...proxy, direct], { timeoutMs: 10_000, hedgeMs: 3_000, rounds: 2 });
    c = new Connection(direct, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: f as any });
    _byCluster.set(cluster, c);
  }
  return c;
}

/**
 * For wallet actions: the same endpoints, but the proxy never answers from its cache, so a
 * transaction is built from the account state as it is now, not as a dashboard last saw it.
 */
let _freshFetch: ReturnType<typeof failoverFetch> | null = null;
export const freshFetch = (input: any, init?: any): Promise<Response> => {
  if (!_freshFetch) {
    const proxy = USE_PROXY && typeof window !== "undefined" ? [`${window.location.origin}/api/rpc?fresh=1`] : [];
    _freshFetch = failoverFetch([...proxy, ...DIRECT], { timeoutMs: 10_000, hedgeMs: 2_000, rounds: 2 });
  }
  return _freshFetch(input, init);
};

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

function explorerSuffix() {
  return CLUSTER === "localnet" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : CLUSTER === "devnet" ? "?cluster=devnet" : "";
}
export function explorerUrl(sig: string) {
  return `https://explorer.solana.com/tx/${sig}${explorerSuffix()}`;
}
export function explorerAddress(address: PublicKey | string) {
  return `https://explorer.solana.com/address/${typeof address === "string" ? address : address.toBase58()}${explorerSuffix()}`;
}

// ---------------------------------------------------------------------------
// Token labels (Metaplex metadata, with a few well-known mints)
// ---------------------------------------------------------------------------

export interface TokenLabel {
  symbol: string;
  name: string;
}

/** What the mint account says: exact decimals and who can still mint or freeze. */
export interface MintInfo {
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const KNOWN_TOKENS: Record<string, TokenLabel> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Wrapped SOL" },
  // Quote token minted by the devnet demo (scripts/demo.ts); it has no metadata account.
  "4qF4Q5Gj9R2k8Wyx9yspNRmj3APKFBQ4oTdGvhJE3Z4x": { symbol: "USDC", name: "Test USDC (devnet)" },
};
const labelCache = new Map<string, TokenLabel>(Object.entries(KNOWN_TOKENS));

/** Symbols for well-known mints, whichever cluster is being read. */
export function knownSymbol(mint: string): string | undefined {
  return KNOWN_TOKENS[mint]?.symbol;
}

function readBorshString(d: Uint8Array, o: number): [string, number] {
  const len = d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
  const bytes = d.subarray(o + 4, o + 4 + len);
  return [new TextDecoder().decode(bytes).replace(/\0/g, "").trim(), o + 4 + len];
}

/**
 * The test network's participant book (written by scripts/simulate.ts). Besides persona
 * names it labels the test quote token, which has no metadata account.
 */
let simBook: Promise<any> | null = null;
export function fetchSimBook(): Promise<any> {
  simBook ??= fetch(CLUSTER === "localnet" ? "/personas.json" : `/personas.${CLUSTER}.json`)
    .then((r): Promise<any> => (r.ok ? r.json() : Promise.resolve({})))
    .catch(() => ({}))
    .then((b: any) => {
      for (const [mint, label] of Object.entries((b?.tokens ?? {}) as Record<string, TokenLabel>)) labelCache.set(mint, label);
      return b;
    });
  return simBook;
}

/** Symbol and name for each mint; falls back to a shortened address. */
export async function fetchTokenLabels(mints: PublicKey[]): Promise<Record<string, TokenLabel>> {
  await fetchSimBook();
  const missing = [...new Set(mints.map((m) => m.toBase58()))].filter((m) => !labelCache.has(m));
  if (missing.length) {
    const pdas = missing.map(
      (m) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), new PublicKey(m).toBuffer()], MPL_TOKEN_METADATA)[0],
    );
    const { infos } = await loadAccounts(connection(), pdas, { partial: true });
    missing.forEach((m, i) => {
      const info = infos[i];
      let label: TokenLabel = { symbol: short(m, 3), name: m };
      if (info && info.data.length > 70) {
        try {
          const [name, next] = readBorshString(info.data, 65);
          const [symbol] = readBorshString(info.data, next);
          if (symbol) label = { symbol, name: name || symbol };
        } catch {
          /* keep the fallback */
        }
      }
      labelCache.set(m, label);
    });
  }
  return Object.fromEntries(mints.map((m) => [m.toBase58(), labelCache.get(m.toBase58())!]));
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
  const { infos } = await loadAccounts(connection(), accounts);
  return infos.map((i) => (i ? AccountLayout.decode(i.data).amount : 0n));
}

const mintCache = new Map<string, MintInfo>();
/**
 * Mint facts for every mint asked, read in chunks and cached. Decimals are never assumed:
 * a mint that can't be read is missing from the result, and callers show amounts as unknown.
 */
export async function fetchMints(mints: PublicKey[]): Promise<Record<string, MintInfo>> {
  const missing = [...new Set(mints.map((m) => m.toBase58()))].filter((m) => !mintCache.has(m));
  if (missing.length) {
    const { infos } = await loadAccounts(connection(), missing.map((m) => new PublicKey(m)), { partial: true });
    missing.forEach((m, i) => {
      const d = infos[i]?.data;
      if (!d || d.length < 82) return;
      const opt = (o: number) => (d.readUInt32LE(o) === 1 ? new PublicKey(d.subarray(o + 4, o + 36)).toBase58() : null);
      mintCache.set(m, { decimals: d[44], mintAuthority: opt(0), freezeAuthority: opt(46) });
    });
  }
  return Object.fromEntries(mints.flatMap((m) => (mintCache.has(m.toBase58()) ? [[m.toBase58(), mintCache.get(m.toBase58())!]] : [])));
}

export async function mintDecimals(mint: PublicKey): Promise<number> {
  const info = (await fetchMints([mint]))[mint.toBase58()];
  if (!info) throw new Error(`could not read the mint ${mint.toBase58()}`);
  return info.decimals;
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
  const { infos: [pairInfo, dammInfo, oracleInfo, posInfo], slot } = await loadAccounts(
    conn,
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
  const now = Math.floor(Date.now() / 1000);
  const projected = projectAnchor(anchorState(m), sample, m.terms, pair.binStep, now);
  const quality: ReferenceQuality = referenceQuality(anchorState(m), sample, m.terms, now);
  const refBin = projected.bin;
  const refUi = binUi(refBin);
  const bins: BookBin[] = [];
  // What the next check would record, with the program's own arithmetic (display bins below are for the chart).
  let committed: CommittedResult = hasPos ? { status: "unknown", reason: "the position could not be read" } : measureAccounts(m, pair.binStep, null, new Map(), refBin);
  if (hasPos) {
    if (posInfo) {
      const pos = decodePosition(posInfo.data);
      const { infos: arrays } = await loadAccounts(conn, binArraysCovering(m.lbPair, pos.lowerBinId, pos.upperBinId));
      const byIndex = new Map<number, ReturnType<typeof decodeBinArray>>();
      arrays.forEach((a) => {
        if (a) {
          const d = decodeBinArray(a.data);
          byIndex.set(d.index, d);
        }
      });
      committed = measureAccounts(m, pair.binStep, pos, new Map<number, BinInfo[]>([...byIndex].map(([i, d]) => [i, d.bins])), refBin);
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
  return { pair, bins, refBin, refUi, targetBin: projected.target, dammUi, activeUi, baseDecimals: bd, quoteDecimals: qd, committed, quality, slot, readAt: now };
}

export { pda };
