"use client";

import { readStanding, type ReadStanding, type VerifiedRead } from "../../../sdk/src/sentinel";
import type { PersonaBook } from "./personas";

/**
 * The watchtowers this site vouches for, by publisher key: the ones listed in
 * NEXT_PUBLIC_TRUSTED_WATCHTOWERS ("key:Name,key:Name") and, on the test network, the
 * simulated watchtower this site's own persona book names. A read signed by anyone else is
 * shown as unverified commentary. A listed signature proves who published a read, not that
 * a model produced it.
 */
export function trustedWatchtowers(book: PersonaBook): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, p] of Object.entries(book.parties)) if (p.role === "watchtower") out.set(key, `${p.name} (simulated)`);
  for (const entry of (process.env.NEXT_PUBLIC_TRUSTED_WATCHTOWERS ?? "").split(",").filter(Boolean)) {
    const [key, name] = entry.split(":");
    if (key) out.set(key.trim(), name?.trim() || "Listed watchtower");
  }
  return out;
}

export interface ShownRead {
  v: VerifiedRead;
  standing: ReadStanding;
  publisherName: string | null;
}

/** The newest read about `mandate` that is still current, trusted ones first. */
export function latestRead(events: { read: VerifiedRead | null; mandate: string }[] | null | undefined, mandate: string, trusted: Map<string, string>, now: number): ShownRead | null {
  let fallback: ShownRead | null = null;
  for (const e of events ?? []) {
    if (!e.read) continue;
    const standing = readStanding(e.read, { mandate, trusted, now });
    if (standing === "mismatch" || standing === "expired") continue;
    const shown = { v: e.read, standing, publisherName: trusted.get(e.read.publisher) ?? null };
    if (standing === "trusted") return shown;
    fallback ??= shown;
  }
  return fallback;
}
