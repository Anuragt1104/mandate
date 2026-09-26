"use client";

import { PublicKey } from "@solana/web3.js";
import { statusName } from "../../../sdk/src";
import type { PeriodEntry, StatusName } from "./sla";
import { loadAccounts } from "../../../sdk/src";
import { connection, fetchAllMandates, fetchBook, fetchMakerProfiles, fetchMints, fetchTokenLabels, pda, readClient, tokenAmounts, type MintInfo, type TokenLabel } from "./chain";
import type { PersonaBook } from "./personas";
import { trustedWatchtowers } from "./trust";

export interface BoardRow {
  pubkey: PublicKey;
  m: any;
  status: StatusName;
  entries: PeriodEntry[];
}

function decodeEntries(data: Buffer | Uint8Array | undefined | null): PeriodEntry[] {
  if (!data) return [];
  const log = readClient().decodeScoreLog(data);
  const n = log.count as number;
  const len = log.entries.length as number;
  const out: PeriodEntry[] = [];
  for (let k = 0; k < n; k++) out.push(log.entries[(log.head - n + k + len) % len]);
  return out;
}

export interface Board {
  rows: BoardRow[];
  labels: Record<string, TokenLabel>;
  /** mint → decimals and authorities (missing when the mint couldn't be read) */
  mints: Record<string, MintInfo>;
  /** maker address → on-chain MakerProfile */
  profiles: Record<string, any>;
}

export async function loadBoard(): Promise<Board> {
  const all = await fetchAllMandates();
  const mintKeys = all.flatMap((r) => [r.m.baseMint as PublicKey, r.m.quoteMint as PublicKey]);
  const [logs, profiles, mints] = await Promise.all([
    loadAccounts(connection(), all.map((r) => r.m.scoreLog as PublicKey), { partial: true }).then((r) => r.infos),
    fetchMakerProfiles().catch(() => []),
    fetchMints(mintKeys),
  ]);
  const rows = all.map((r, i) => ({ ...r, status: statusName(r.m.status) as StatusName, entries: decodeEntries(logs[i]?.data) }));
  const labels = await fetchTokenLabels(mintKeys);
  return { rows, labels, mints, profiles: Object.fromEntries(profiles.map(({ p }) => [p.maker.toBase58(), p])) };
}

/** Names and terms per mandate, so feed events can be written as sentences. */
export function feedContext(board: Board | null, book: PersonaBook) {
  const mandates: Record<string, { symbol: string; quote: string; maker: PublicKey; issuer: PublicKey; terms: any; baseDecimals?: number; quoteDecimals?: number }> = {};
  for (const r of board?.rows ?? []) {
    mandates[r.pubkey.toBase58()] = {
      symbol: board!.labels[r.m.baseMint.toBase58()]?.symbol ?? "token",
      quote: board!.labels[r.m.quoteMint.toBase58()]?.symbol ?? "quote",
      maker: r.m.maker,
      issuer: r.m.issuer,
      terms: r.m.terms,
      baseDecimals: board!.mints[r.m.baseMint.toBase58()]?.decimals,
      quoteDecimals: board!.mints[r.m.quoteMint.toBase58()]?.decimals,
    };
  }
  return { book, mandates, trusted: trustedWatchtowers(book) };
}

/** Live SLAs sort first, then open offers, then closed ones; newest first within each. */
export function boardOrder(rows: BoardRow[]) {
  const rank = (r: BoardRow) => (r.status === "Active" ? 0 : r.status === "Open" ? 1 : r.status === "Breached" ? 2 : 3);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.m.createdAt.toNumber() - a.m.createdAt.toNumber());
}

export async function loadMandate(key: PublicKey) {
  const info = await connection().getAccountInfo(key);
  if (!info) return null;
  const m = readClient().decodeMandate(info.data);
  const hasMaker = !(m.maker as PublicKey).equals(PublicKey.default);
  const [logInfo, book, balances, labels, profileInfo, mints] = await Promise.all([
    connection().getAccountInfo(m.scoreLog),
    fetchBook(m),
    tokenAmounts([m.baseVault, m.quoteVault, m.feeVault, m.bondVault]),
    fetchTokenLabels([m.baseMint, m.quoteMint]),
    hasMaker ? connection().getAccountInfo(pda.makerProfile(m.maker)) : Promise.resolve(null),
    fetchMints([m.baseMint, m.quoteMint]),
  ]);
  const base = mints[m.baseMint.toBase58()];
  const quote = mints[m.quoteMint.toBase58()];
  if (!base || !quote) throw new Error("Could not read the token mints, so amounts can't be shown correctly. Retrying.");
  const profile = profileInfo ? readClient().decodeMakerProfile(profileInfo.data) : null;
  return { key, m, status: statusName(m.status) as StatusName, entries: decodeEntries(logInfo?.data), book, balances, labels, profile, mints: { base, quote } };
}

export type MandateView = NonNullable<Awaited<ReturnType<typeof loadMandate>>>;

/** The mandate shown live on the landing page: the active one with the longest record. */
export async function loadFeatured(): Promise<MandateView | null> {
  const all = await fetchAllMandates();
  const active = all
    .filter((r) => statusName(r.m.status) === "Active")
    .sort((a, b) => b.m.snapshotsTotal - a.m.snapshotsTotal);
  const pick = active[0] ?? all[0];
  return pick ? loadMandate(pick.pubkey) : null;
}

export interface QuoteTotals {
  mint: string;
  symbol: string;
  bonded: number;
  slashed: number;
  fees: number;
}

/**
 * Aggregates across the board for KPI strips. Money is totalled per quote mint, in that
 * mint's own decimals: amounts in different tokens are never added together. Mandates
 * whose quote mint couldn't be read are left out of the money totals and counted.
 */
export function summarize(board: Board) {
  const rows = board.rows;
  const ok = rows.reduce((s, r) => s + r.m.periodsOk, 0);
  const failed = rows.reduce((s, r) => s + r.m.periodsFailed, 0);
  const active = rows.filter((r) => r.status === "Active").length;
  const open = rows.filter((r) => r.status === "Open").length;
  const byQuote = new Map<string, QuoteTotals>();
  let unread = 0;
  for (const r of rows) {
    const mint = r.m.quoteMint.toBase58();
    const d = board.mints[mint]?.decimals;
    if (d === undefined) {
      unread++;
      continue;
    }
    const t = byQuote.get(mint) ?? { mint, symbol: board.labels[mint]?.symbol ?? mint.slice(0, 4), bonded: 0, slashed: 0, fees: 0 };
    const q = (v: any) => Number(v) / 10 ** d;
    if (r.status === "Active") t.bonded += q(r.m.terms.bondAmount);
    t.slashed += q(r.m.bondSlashed);
    t.fees += q(r.m.feesEarned);
    byQuote.set(mint, t);
  }
  const quotes = [...byQuote.values()].sort((a, b) => b.bonded + b.fees - (a.bonded + a.fees));
  return { ok, failed, active, open, quotes, unread, compliance: ok + failed ? ok / (ok + failed) : null };
}

export function complianceOf(m: any): number | null {
  const ok = m.periodsOk as number;
  const failed = m.periodsFailed as number;
  return ok + failed ? ok / (ok + failed) : null;
}
