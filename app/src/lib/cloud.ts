"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "../../../sdk/src/observe";
import type { DraftDoc } from "../../../sdk/src/draft";

/**
 * Accounts and workspaces, backed by Supabase. Optional: without its two public settings the
 * app works exactly as before, keeping drafts and observations in this browser only.
 *
 * All access runs in the browser as the signed-in user; the database enforces who may read and
 * write what (row-level security, see supabase/migrations). Nothing here holds funds or keys:
 * agreements and money stay on chain.
 */
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const CLOUD = Boolean(URL && KEY);

let client: SupabaseClient | null = null;
export function cloud(): SupabaseClient | null {
  if (!CLOUD || typeof window === "undefined") return null;
  client ??= createClient(URL!, KEY!, { auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true } });
  return client;
}

/** Which OAuth providers are turned on for this project (Supabase reports these publicly). */
export async function oauthProviders(): Promise<Record<string, boolean>> {
  if (!CLOUD) return {};
  try {
    const r = await fetch(`${URL}/auth/v1/settings`, { headers: { apikey: KEY! } });
    return r.ok ? ((await r.json()).external ?? {}) : {};
  } catch {
    return {};
  }
}

export type Role = "viewer" | "manager" | "admin" | "owner";
export const RANK: Record<Role, number> = { viewer: 1, manager: 2, admin: 3, owner: 4 };
export const can = (role: Role | undefined, at: Role) => !!role && RANK[role] >= RANK[at];

export interface Workspace {
  id: string;
  name: string;
  kind: "team" | "operator";
  role: Role;
}

export async function myWorkspaces(): Promise<Workspace[]> {
  const sb = cloud();
  if (!sb) return [];
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return [];
  const { data, error } = await sb.from("memberships").select("role, workspaces(id, name, kind)").eq("user_id", auth.user.id);
  if (error) throw error;
  return (data ?? [])
    .filter((m: any) => m.workspaces)
    .map((m: any) => ({ id: m.workspaces.id, name: m.workspaces.name, kind: m.workspaces.kind, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The error message Postgres or Auth gave, for showing to the person. */
export function why(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

// --- Writes from the browser store --------------------------------------------------------

export async function pushSession(ws: string, s: Session, label: string) {
  const sb = cloud();
  if (!sb) return;
  const { error } = await sb.from("observations").upsert({
    workspace_id: ws,
    id: s.id,
    label,
    pair: s.pair,
    owner: s.owner,
    cluster: s.cluster,
    samples: s.samples.length,
    session: s,
    started_at: new Date(s.startedAt * 1000).toISOString(),
  });
  if (error) throw error;
}

export async function dropSession(ws: string, id: string) {
  const { error } = (await cloud()?.from("observations").delete().eq("workspace_id", ws).eq("id", id)) ?? {};
  if (error) throw error;
}

export async function pushDraft(ws: string, doc: DraftDoc, title: string, link: string, status: string) {
  const sb = cloud();
  if (!sb) return;
  const { error } = await sb.from("drafts").upsert({ workspace_id: ws, id: doc.id, title, status, doc, link });
  if (error) throw error;
}

// --- Reads into the browser store ---------------------------------------------------------

export interface CloudSession {
  id: string;
  label: string;
  updated_at: string;
  session: Session;
}
export interface CloudDraft {
  id: string;
  title: string;
  status: string;
  link: string;
  updated_at: string;
}

export async function pullWorkspace(ws: string): Promise<{ sessions: CloudSession[]; drafts: CloudDraft[] }> {
  const sb = cloud();
  if (!sb) return { sessions: [], drafts: [] };
  const [s, d] = await Promise.all([
    sb.from("observations").select("id, label, updated_at, session").eq("workspace_id", ws).order("updated_at", { ascending: false }).limit(100),
    sb.from("drafts").select("id, title, status, link, updated_at").eq("workspace_id", ws).order("updated_at", { ascending: false }).limit(100),
  ]);
  if (s.error) throw s.error;
  if (d.error) throw d.error;
  return { sessions: (s.data ?? []) as CloudSession[], drafts: (d.data ?? []) as CloudDraft[] };
}

// --- Background observation -----------------------------------------------------------------

export interface BackgroundJob {
  active: boolean;
  next_at: string;
  ends_at: string;
  runs: number;
  failures: number;
  last_sample_at: string | null;
  last_error: string | null;
  stopped_reason: string | null;
}

export async function backgroundJob(ws: string, id: string): Promise<BackgroundJob | null> {
  const sb = cloud();
  if (!sb) return null;
  const { data, error } = await sb.from("observation_jobs").select("active, next_at, ends_at, runs, failures, last_sample_at, last_error, stopped_reason").eq("workspace_id", ws).eq("observation_id", id).maybeSingle();
  if (error) throw error;
  return data as BackgroundJob | null;
}

export async function setBackground(ws: string, id: string, on: boolean, days = 30) {
  const { error } = (await cloud()?.rpc("set_background_observation", { ws, obs: id, turn_on: on, days })) ?? {};
  if (error) throw error;
}

export async function pullSession(ws: string, id: string): Promise<{ session: Session; label: string; updated_at: string } | null> {
  const sb = cloud();
  if (!sb) return null;
  const { data, error } = await sb.from("observations").select("session, label, updated_at").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (error) throw error;
  return data as { session: Session; label: string; updated_at: string } | null;
}
