"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { CLOUD, cloud, myWorkspaces, why, type Workspace } from "@/lib/cloud";
import { currentWorkspace, forgetWorkspaces, pullInto, setCurrentWorkspace } from "@/lib/local";

interface Account {
  /** Accounts are available on this deployment. */
  enabled: boolean;
  /** Still finding out whether someone is signed in. */
  loading: boolean;
  user: User | null;
  workspaces: Workspace[];
  /** The signed-in person's workspaces have been loaded. */
  ready: boolean;
  /** The open workspace; null means "this browser only". */
  current: Workspace | null;
  open: (id: string | null) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  error: string | null;
}

const INVITE = "mandate.invite";
/** Read, set or clear an invitation token waiting for sign-in (the email link may open in a new tab, so this outlives the tab). */
export function pendingInvite(set?: string | null): string | null {
  try {
    if (set === null) localStorage.removeItem(INVITE);
    else if (set) localStorage.setItem(INVITE, set);
    return localStorage.getItem(INVITE);
  } catch {
    return null;
  }
}

const Ctx = createContext<Account>({
  enabled: false,
  loading: false,
  user: null,
  workspaces: [],
  ready: false,
  current: null,
  open: () => {},
  refresh: async () => {},
  signOut: async () => {},
  error: null,
});
export const useAccount = () => useContext(Ctx);

/** Who is signed in, their workspaces, and which one is open; pulls the open one into this browser. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(CLOUD);
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // An invitation opened before signing in is accepted once there is an account.
      let joined: string | null = null;
      let inviteError: string | null = null;
      const token = pendingInvite();
      if (token) {
        const { data, error } = await cloud()!.rpc("accept_invitation", { token });
        pendingInvite(null);
        if (error) inviteError = `Couldn't accept the invitation: ${why(error)}`;
        else joined = data as string;
      }
      if (joined) setCurrentWorkspace(joined);
      const list = await myWorkspaces();
      setWorkspaces(list);
      // A remembered workspace the person no longer belongs to falls back to their first one.
      const saved = currentWorkspace();
      const next = saved && list.some((w) => w.id === saved) ? saved : list[0]?.id ?? null;
      setCurrentWorkspace(next);
      setCurrentId(next);
      setError(inviteError);
    } catch (e) {
      setError(`Couldn't load your workspaces: ${why(e)}`);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    const sb = cloud();
    if (!sb) return;
    sb.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data } = sb.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!CLOUD || loading) return;
    if (user) refresh();
    else {
      setWorkspaces([]);
      setReady(false);
      setCurrentId(null);
      setCurrentWorkspace(null);
    }
  }, [user?.id, loading, refresh]);

  useEffect(() => {
    if (!currentId) return;
    pullInto(currentId).catch((e) => setError(`Couldn't load the workspace's work: ${why(e)}`));
  }, [currentId]);

  const open = useCallback((id: string | null) => {
    setCurrentWorkspace(id);
    setCurrentId(id);
  }, []);

  const signOut = useCallback(async () => {
    await cloud()?.auth.signOut();
    forgetWorkspaces();
    setCurrentId(null);
  }, []);

  const current = workspaces.find((w) => w.id === currentId) ?? null;
  return <Ctx.Provider value={{ enabled: CLOUD, loading, user, workspaces, ready, current, open, refresh, signOut, error }}>{children}</Ctx.Provider>;
}
