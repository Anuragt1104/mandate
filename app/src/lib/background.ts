"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../sdk/src/observe";
import { backgroundJob, can, pullSession, pushSession, setBackground, why, type BackgroundJob } from "./cloud";
import { cancelPush, sessionWorkspace, storeSession, useLocalVersion } from "./local";
import { useAccount } from "@/components/account";

/**
 * Background observation of one session: whether the server is sampling it, and handing it
 * over or back. While the server observes, this browser only reads the workspace's copy
 * (polled), so a tab can never overwrite samples it didn't take.
 */
export function useBackground(id: string) {
  const acct = useAccount();
  useLocalVersion();
  const ws = sessionWorkspace(id);
  const member = ws ? acct.workspaces.find((w) => w.id === ws) : undefined;
  const [job, setJob] = useState<BackgroundJob | null>(null);
  const [remote, setRemote] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(!ws);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!ws) return setLoaded(true);
    try {
      const j = await backgroundJob(ws, id);
      setJob(j);
      if (j?.active || j?.stopped_reason) {
        const r = await pullSession(ws, id);
        if (r) {
          storeSession(r.session, r.label, ws, Math.floor(Date.parse(r.updated_at) / 1000));
          setRemote(r.session);
        }
      }
      setError(null);
    } catch (e) {
      setError(why(e));
    } finally {
      setLoaded(true);
    }
  }, [ws, id]);

  useEffect(() => {
    refresh();
    if (!ws) return;
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh, ws]);

  async function start(s: Session, label: string, days: number) {
    if (!ws) return;
    setBusy(true);
    setError(null);
    try {
      cancelPush(id);
      await pushSession(ws, s, label);
      await setBackground(ws, id, true, days);
      await refresh();
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!ws) return;
    setBusy(true);
    setError(null);
    try {
      await setBackground(ws, id, false);
      await refresh();
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  }

  return {
    /** The workspace this session is saved in, if any. */
    ws,
    workspaceName: member?.name ?? null,
    canManage: can(member?.role, "manager"),
    signedIn: !!acct.user,
    enabled: acct.enabled,
    job,
    serverOwned: !!job?.active,
    remote,
    loaded,
    error,
    busy,
    start,
    stop,
  };
}
