"use client";

import type { Session } from "../../../sdk/src/observe";
import type { DraftDoc } from "../../../sdk/src/draft";
import { useEffect, useState } from "react";
import { CLOUD, dropSession, pullWorkspace, pushDraft, pushSession, why } from "./cloud";

/**
 * What this browser keeps: observation sessions and drafts the user started or opened. A
 * session or draft travels to someone else as a link or an exported file. Every access is
 * guarded: storage can be full, disabled or cleared, and the page must still work.
 *
 * When the person is signed in and has a workspace open, this store is that workspace's local
 * copy: entries are tagged with the workspace, every save is also written to it (see cloud.ts),
 * and opening the workspace pulls its entries in. Without a workspace, entries stay untagged
 * and belong to this browser alone until imported.
 */
const SESSIONS = "mandate.sessions.v1";
const DRAFTS = "mandate.drafts.v1";
const WORKSPACE = "mandate.workspace.v1";
const sessionKey = (id: string) => `mandate.session.v1.${id}`;
const CHANGED = "mandate:local";

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
  /** The workspace this belongs to; absent while it lives only in this browser. */
  ws?: string;
}

/** The open workspace, or null for "this browser only". */
export function currentWorkspace(): string | null {
  return CLOUD ? read<string | null>(WORKSPACE, null) : null;
}

export function setCurrentWorkspace(id: string | null) {
  if (id) write(WORKSPACE, id);
  else {
    try {
      localStorage.removeItem(WORKSPACE);
    } catch {
      /* nothing to do */
    }
  }
  changed();
}

function changed() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/** Re-render when the store changes (a save, a pull, a workspace switch, another tab). */
export function useLocalVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener(CHANGED, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(CHANGED, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return v;
}

const inScope = (e: { ws?: string }, ws = currentWorkspace()) => (ws ? e.ws === ws : !e.ws);

function allSessions(): SessionEntry[] {
  return read<SessionEntry[]>(SESSIONS, []);
}

/** Sessions of the open workspace (or of this browser alone), newest first. */
export function listSessions(): SessionEntry[] {
  return allSessions().filter((e) => inScope(e)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(id: string): Session | null {
  return read<Session | null>(sessionKey(id), null);
}

/** Save a session; returns false when the browser refused (storage full or blocked). */
export function saveSession(s: Session, label: string): boolean {
  // Keep the newest samples if storage is tight: older ones are the least useful for a live report.
  let ok = write(sessionKey(s.id), s);
  if (!ok && s.samples.length > 50) ok = write(sessionKey(s.id), { ...s, samples: s.samples.slice(-Math.floor(s.samples.length / 2)) });
  const prior = allSessions().find((e) => e.id === s.id);
  const ws = prior ? prior.ws : currentWorkspace() ?? undefined;
  const entry: SessionEntry = { id: s.id, pair: s.pair, owner: s.owner, label, cluster: s.cluster, startedAt: s.startedAt, updatedAt: Math.floor(Date.now() / 1000), samples: s.samples.length, ws };
  write(SESSIONS, [entry, ...allSessions().filter((e) => e.id !== s.id)]);
  if (ws) queuePush(s, label, ws);
  changed();
  return ok;
}

// A running observation saves on every sample; write it to the workspace at most once a minute.
const pending = new Map<string, { s: Session; label: string; ws: string; timer: ReturnType<typeof setTimeout> | null; last: number }>();
function queuePush(s: Session, label: string, ws: string) {
  const p = pending.get(s.id) ?? { s, label, ws, timer: null, last: 0 };
  Object.assign(p, { s, label, ws });
  pending.set(s.id, p);
  if (p.timer) return;
  const wait = Math.max(0, p.last + 60_000 - Date.now());
  p.timer = setTimeout(() => {
    p.timer = null;
    p.last = Date.now();
    pushSession(p.ws, p.s, p.label).then(() => report(null), (e) => report(`Couldn't save "${p.label}" to the workspace: ${why(e)}`));
  }, wait);
}

/** The workspace a saved session belongs to, if any. */
export function sessionWorkspace(id: string): string | null {
  return allSessions().find((e) => e.id === id)?.ws ?? null;
}

/** Stop any queued write of this session to its workspace (the server has taken it over). */
export function cancelPush(id: string) {
  const p = pending.get(id);
  if (p?.timer) clearTimeout(p.timer);
  pending.delete(id);
}

/** Keep the workspace's copy of a session here without writing it back. */
export function storeSession(s: Session, label: string, ws: string, updatedAt: number) {
  write(sessionKey(s.id), s);
  const entry: SessionEntry = { id: s.id, pair: s.pair, owner: s.owner, label, cluster: s.cluster, startedAt: s.startedAt, updatedAt, samples: s.samples.length, ws };
  write(SESSIONS, [entry, ...allSessions().filter((e) => e.id !== s.id)]);
  changed();
}

export function deleteSession(id: string) {
  try {
    localStorage.removeItem(sessionKey(id));
  } catch {
    /* nothing to do */
  }
  const prior = allSessions().find((e) => e.id === id);
  write(SESSIONS, allSessions().filter((e) => e.id !== id));
  const p = pending.get(id);
  if (p?.timer) clearTimeout(p.timer);
  pending.delete(id);
  if (prior?.ws) dropSession(prior.ws, id).catch((e) => report(`Couldn't remove it from the workspace: ${why(e)}`));
  changed();
}

export interface DraftEntry {
  id: string;
  title: string;
  link: string;
  updatedAt: number;
  status: string;
  ws?: string;
}

function allDrafts(): DraftEntry[] {
  return read<DraftEntry[]>(DRAFTS, []);
}

export function listDrafts(): DraftEntry[] {
  return allDrafts().filter((e) => inScope(e)).sort((a, b) => b.updatedAt - a.updatedAt);
}

const draftTitle = (doc: DraftDoc) => doc.title ?? `${doc.market.base ?? "Token"}/${doc.market.quote ?? "quote"} agreement`;

export function rememberDraft(doc: DraftDoc, link: string, status: string) {
  const prior = allDrafts().find((d) => d.id === doc.id);
  const ws = prior ? prior.ws : currentWorkspace() ?? undefined;
  const entry: DraftEntry = { id: doc.id, title: draftTitle(doc), link, updatedAt: Math.floor(Date.now() / 1000), status, ws };
  write(DRAFTS, [entry, ...allDrafts().filter((d) => d.id !== doc.id)].slice(0, 100));
  if (ws) pushDraft(ws, doc, entry.title, link, status).then(() => report(null), (e) => report(`Couldn't save the draft to the workspace: ${why(e)}`));
  changed();
}

// --- Workspace sync -----------------------------------------------------------------------

let lastError: string | null = null;
function report(e: string | null) {
  if (e === lastError) return;
  lastError = e;
  changed();
}
/** The last failed write to the workspace, cleared by the next one that succeeds. */
export const syncError = () => lastError;

/** Bring a workspace's observations and drafts into this browser; the newer copy wins. */
export async function pullInto(ws: string): Promise<void> {
  const { sessions, drafts } = await pullWorkspace(ws);
  const ss = allSessions();
  for (const c of sessions) {
    const at = Math.floor(Date.parse(c.updated_at) / 1000);
    const mine = ss.find((e) => e.id === c.id);
    if (mine && mine.updatedAt >= at) continue;
    write(sessionKey(c.id), c.session);
    const s = c.session;
    const entry: SessionEntry = { id: s.id, pair: s.pair, owner: s.owner, label: c.label, cluster: s.cluster, startedAt: s.startedAt, updatedAt: at, samples: s.samples.length, ws };
    ss.splice(0, ss.length, entry, ...ss.filter((e) => e.id !== c.id));
  }
  write(SESSIONS, ss);
  const ds = allDrafts();
  for (const c of drafts) {
    const at = Math.floor(Date.parse(c.updated_at) / 1000);
    const mine = ds.find((e) => e.id === c.id);
    if (mine && mine.updatedAt >= at) continue;
    ds.splice(0, ds.length, { id: c.id, title: c.title, link: c.link, status: c.status, updatedAt: at, ws }, ...ds.filter((e) => e.id !== c.id));
  }
  write(DRAFTS, ds.slice(0, 100));
  changed();
}

/** What lives only in this browser, for "Import work from this browser". */
export function browserOnly(): { sessions: SessionEntry[]; drafts: DraftEntry[] } {
  return { sessions: allSessions().filter((e) => !e.ws), drafts: allDrafts().filter((e) => !e.ws) };
}

/**
 * Copy this browser's own observations and drafts into a workspace. Drafts are re-read from
 * their links so the workspace keeps the full document. Returns how many moved and what failed.
 */
export async function importInto(ws: string, decodeDraft: (link: string) => Promise<DraftDoc | null>): Promise<{ moved: number; failed: string[] }> {
  const { sessions, drafts } = browserOnly();
  let moved = 0;
  const failed: string[] = [];
  for (const e of sessions) {
    const s = loadSession(e.id);
    if (!s) continue;
    try {
      await pushSession(ws, s, e.label);
      write(SESSIONS, allSessions().map((x) => (x.id === e.id ? { ...x, ws } : x)));
      moved++;
    } catch (err) {
      failed.push(`${e.label}: ${why(err)}`);
    }
  }
  for (const d of drafts) {
    const doc = await decodeDraft(d.link).catch(() => null);
    if (!doc) {
      failed.push(`${d.title}: its link couldn't be read`);
      continue;
    }
    try {
      await pushDraft(ws, doc, d.title, d.link, d.status);
      write(DRAFTS, allDrafts().map((x) => (x.id === d.id ? { ...x, ws } : x)));
      moved++;
    } catch (err) {
      failed.push(`${d.title}: ${why(err)}`);
    }
  }
  changed();
  return { moved, failed };
}

/** On sign-out: drop every workspace's copy from this browser, keeping only its own work. */
export function forgetWorkspaces() {
  for (const e of allSessions()) {
    if (!e.ws) continue;
    try {
      localStorage.removeItem(sessionKey(e.id));
    } catch {
      /* nothing to do */
    }
  }
  write(SESSIONS, allSessions().filter((e) => !e.ws));
  write(DRAFTS, allDrafts().filter((e) => !e.ws));
  setCurrentWorkspace(null);
}
