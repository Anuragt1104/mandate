"use client";

import { PublicKey } from "@solana/web3.js";
import { statusName } from "../../../sdk/src";
import type { PeriodEntry } from "@/components/charts";
import type { StatusName } from "@/components/ui";
import { connection, fetchAllMandates, fetchBook, fetchTokenLabels, readClient, tokenAmounts, type TokenLabel } from "./chain";

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

export async function loadBoard(): Promise<{ rows: BoardRow[]; labels: Record<string, TokenLabel> }> {
  const all = await fetchAllMandates();
  const logs = all.length ? await connection().getMultipleAccountsInfo(all.map((r) => r.m.scoreLog as PublicKey)) : [];
  const rows = all.map((r, i) => ({ ...r, status: statusName(r.m.status) as StatusName, entries: decodeEntries(logs[i]?.data) }));
  const labels = await fetchTokenLabels(all.flatMap((r) => [r.m.baseMint as PublicKey, r.m.quoteMint as PublicKey]));
  return { rows, labels };
}

export async function loadMandate(key: PublicKey) {
  const info = await connection().getAccountInfo(key);
  if (!info) return null;
  const m = readClient().decodeMandate(info.data);
  const [logInfo, book, balances, labels] = await Promise.all([
    connection().getAccountInfo(m.scoreLog),
    fetchBook(m),
    tokenAmounts([m.baseVault, m.quoteVault, m.feeVault, m.bondVault]),
    fetchTokenLabels([m.baseMint, m.quoteMint]),
  ]);
  return { key, m, status: statusName(m.status) as StatusName, entries: decodeEntries(logInfo?.data), book, balances, labels };
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
  const bonded = rows.filter((r) => ["Active", "Breached", "Expired"].includes(r.status)).reduce((s, r) => s + Number(r.m.terms.bondAmount) / 1e6, 0);
  const slashed = rows.reduce((s, r) => s + Number(r.m.bondSlashed) / 1e6, 0);
  const fees = rows.reduce((s, r) => s + Number(r.m.feesEarned) / 1e6, 0);
  return { ok, failed, active, open, bonded, slashed, fees, compliance: ok + failed ? ok / (ok + failed) : null };
}

export function complianceOf(m: any): number | null {
  const ok = m.periodsOk as number;
  const failed = m.periodsFailed as number;
  return ok + failed ? ok / (ok + failed) : null;
}
