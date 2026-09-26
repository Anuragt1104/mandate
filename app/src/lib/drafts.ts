"use client";

import { packLink, unpackLink } from "../../../sdk/src/report";
import type { DraftDoc, DraftMarket, DraftTerms } from "../../../sdk/src/draft";

/** Starting points for terms. Every value can be changed; the feasibility preview shows what each implies. */
export const PRESETS: { id: string; name: string; blurb: string; terms: DraftTerms }[] = [
  {
    id: "standard",
    name: "Standard",
    blurb: "Balanced terms for a freshly graduated token.",
    terms: { feePerPeriod: "1", periodMinutes: "60", durationPeriods: "720", bond: "250", maxSpreadBps: "100", minDepth: "500", depthWindowBps: "200", bandBps: "500", twapMinutes: "5", speedPctPerMin: "1", liquidityLockSecs: "30", maxConsecutiveFailures: "3", slashPct: "50", baseDeposit: "0", quoteDeposit: "5000" },
  },
  {
    id: "tight",
    name: "Tight book",
    blurb: "Deeper, tighter quotes and a stricter bond.",
    terms: { feePerPeriod: "3", periodMinutes: "60", durationPeriods: "720", bond: "1000", maxSpreadBps: "50", minDepth: "2000", depthWindowBps: "100", bandBps: "300", twapMinutes: "5", speedPctPerMin: "1", liquidityLockSecs: "60", maxConsecutiveFailures: "2", slashPct: "100", baseDeposit: "0", quoteDeposit: "10000" },
  },
  {
    id: "volatile",
    name: "Volatile launch",
    blurb: "Wider tolerances for a token that still moves fast.",
    terms: { feePerPeriod: "1", periodMinutes: "30", durationPeriods: "672", bond: "250", maxSpreadBps: "200", minDepth: "250", depthWindowBps: "300", bandBps: "1000", twapMinutes: "3", speedPctPerMin: "3", liquidityLockSecs: "30", maxConsecutiveFailures: "5", slashPct: "50", baseDeposit: "0", quoteDeposit: "3000" },
  },
];

/** What a new draft can start from: a report, an agreement being renewed, or nothing. */
export interface DraftPrefill {
  market: DraftMarket;
  terms: DraftTerms;
  team?: string;
  operator?: string;
  evidence?: string;
  renews?: string;
  title?: string;
  /** Why these terms: shown in the draft so both sides know where they came from. */
  basis?: string;
}

export async function draftLink(doc: DraftDoc): Promise<string> {
  return `/app/draft#d=${await packLink(doc)}`;
}

export async function prefillLink(p: DraftPrefill): Promise<string> {
  return `/app/draft#p=${await packLink(p)}`;
}

export async function readHash<T>(key: string): Promise<T | null> {
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(new RegExp(`[#&]${key}=([A-Za-z0-9_-]+)`));
  if (!m) return null;
  try {
    return await unpackLink<T>(m[1]);
  } catch {
    return null;
  }
}

/** Copy text, falling back to a prompt-free selection when the clipboard is refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
