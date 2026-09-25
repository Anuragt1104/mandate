"use client";

import { PublicKey } from "@solana/web3.js";
import { statusName } from "../../../sdk/src";
import type { PeriodEntry, StatusName } from "./sla";
import { connection, fetchAllMandates, fetchBook, fetchMakerProfiles, fetchTokenLabels, pda, readClient, tokenAmounts, type TokenLabel } from "./chain";
import type { PersonaBook } from "./personas";

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
  /** maker address → on-chain MakerProfile */
  profiles: Record<string, any>;
}

export async function loadBoard(): Promise<Board> {
  const all = await fetchAllMandates();
  const [logs, profiles] = await Promise.all([
    all.length ? connection().getMultipleAccountsInfo(all.map((r) => r.m.scoreLog as PublicKey)) : Promise.resolve([]),
    fetchMakerProfiles().catch(() => []),
  ]);
  const rows = all.map((r, i) => ({ ...r, status: statusName(r.m.status) as StatusName, entries: decodeEntries(logs[i]?.data) }));
  const labels = await fetchTokenLabels(all.flatMap((r) => [r.m.baseMint as PublicKey, r.m.quoteMint as PublicKey]));
  return { rows, labels, profiles: Object.fromEntries(profiles.map(({ p }) => [p.maker.toBase58(), p])) };
}

/** Names and terms per mandate, so feed events can be written as sentences. */
export function feedContext(board: Board | null, book: PersonaBook) {
  const mandates: Record<string, { symbol: string; quote: string; maker: PublicKey; issuer: PublicKey; terms: any }> = {};
  for (const r of board?.rows ?? []) {
    mandates[r.pubkey.toBase58()] = {
      symbol: board!.labels[r.m.baseMint.toBase58()]?.symbol ?? "token",
      quote: board!.labels[r.m.quoteMint.toBase58()]?.symbol ?? "USDC",
      maker: r.m.maker,
      issuer: r.m.issuer,
      terms: r.m.terms,
    };
  }
  return { book, mandates };
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
  const [logInfo, book, balances, labels, profileInfo] = await Promise.all([
    connection().getAccountInfo(m.scoreLog),
    fetchBook(m),
    tokenAmounts([m.baseVault, m.quoteVault, m.feeVault, m.bondVault]),
    fetchTokenLabels([m.baseMint, m.quoteMint]),
    hasMaker ? connection().getAccountInfo(pda.makerProfile(m.maker)) : Promise.resolve(null),
  ]);
  const profile = profileInfo ? readClient().decodeMakerProfile(profileInfo.data) : null;
  return { key, m, status: statusName(m.status) as StatusName, entries: decodeEntries(logInfo?.data), book, balances, labels, profile };
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

/** Aggregates across the board for KPI strips. */
export function summarize(rows: BoardRow[]) {
  const ok = rows.reduce((s, r) => s + r.m.periodsOk, 0);
  const failed = rows.reduce((s, r) => s + r.m.periodsFailed, 0);
  const active = rows.filter((r) => r.status === "Active").length;
  const open = rows.filter((r) => r.status === "Open").length;
  const bonded = rows.filter((r) => r.status === "Active").reduce((s, r) => s + Number(r.m.terms.bondAmount) / 1e6, 0);
  const slashed = rows.reduce((s, r) => s + Number(r.m.bondSlashed) / 1e6, 0);
  const fees = rows.reduce((s, r) => s + Number(r.m.feesEarned) / 1e6, 0);
  return { ok, failed, active, open, bonded, slashed, fees, compliance: ok + failed ? ok / (ok + failed) : null };
}

export function complianceOf(m: any): number | null {
  const ok = m.periodsOk as number;
  const failed = m.periodsFailed as number;
  return ok + failed ? ok / (ok + failed) : null;
}
