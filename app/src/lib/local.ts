"use client";

import type { Session } from "../../../sdk/src/observe";
import type { DraftDoc } from "../../../sdk/src/draft";

/**
 * What this browser keeps: observation sessions and drafts the user started or opened. Kept
 * locally because the app has no server of its own; a session or draft travels to someone
 * else as a link or an exported file. Every access is guarded: storage can be full,
 * disabled or cleared, and the page must still work.
 */
const SESSIONS = "mandate.sessions.v1";
const DRAFTS = "mandate.drafts.v1";
const sessionKey = (id: string) => `mandate.session.v1.${id}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export interface SessionEntry {
  id: string;
  pair: string;
  owner: string | null;
  label: string;
  cluster: string;
  startedAt: number;
  updatedAt: number;
  samples: number;
}

export function listSessions(): SessionEntry[] {
  return read<SessionEntry[]>(SESSIONS, []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(id: string): Session | null {
  return read<Session | null>(sessionKey(id), null);
}

/** Save a session; returns false when the browser refused (storage full or blocked). */
export function saveSession(s: Session, label: string): boolean {
  // Keep the newest samples if storage is tight: older ones are the least useful for a live report.
  let ok = write(sessionKey(s.id), s);
  if (!ok && s.samples.length > 50) ok = write(sessionKey(s.id), { ...s, samples: s.samples.slice(-Math.floor(s.samples.length / 2)) });
  const entry: SessionEntry = { id: s.id, pair: s.pair, owner: s.owner, label, cluster: s.cluster, startedAt: s.startedAt, updatedAt: Math.floor(Date.now() / 1000), samples: s.samples.length };
  write(SESSIONS, [entry, ...listSessions().filter((e) => e.id !== s.id)]);
  return ok;
}

export function deleteSession(id: string) {
  try {
    localStorage.removeItem(sessionKey(id));
  } catch {
    /* nothing to do */
  }
  write(SESSIONS, listSessions().filter((e) => e.id !== id));
}

export interface DraftEntry {
  id: string;
  title: string;
  link: string;
  updatedAt: number;
  status: string;
}

export function listDrafts(): DraftEntry[] {
  return read<DraftEntry[]>(DRAFTS, []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function rememberDraft(doc: DraftDoc, link: string, status: string) {
  const entry: DraftEntry = { id: doc.id, title: doc.title ?? `${doc.market.base ?? "Token"}/${doc.market.quote ?? "quote"} agreement`, link, updatedAt: Math.floor(Date.now() / 1000), status };
  write(DRAFTS, [entry, ...listDrafts().filter((d) => d.id !== doc.id)].slice(0, 50));
}
