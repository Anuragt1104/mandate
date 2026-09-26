"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll `load` every `intervalMs`, gently: never overlaps requests, loads once and then pauses
 * while the tab is hidden, and backs off (up to 2 minutes) while the RPC is failing or
 * rate-limiting. The last good data stays on screen during errors, but only for the same
 * resource: when `deps` change (another agreement, say) the data resets, and a response to a
 * request made for the old deps is ignored, so it can never land on the new page.
 */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 10_000) {
  const identity = JSON.stringify(deps);
  const [state, setState] = useState<{ id: string; data: T | null; error: string | null; updatedAt: number | null }>({ id: identity, data: null, error: null, updatedAt: null });
  const [since] = useState(() => Date.now());
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);
  const inFlight = useRef<number | null>(null);
  const failures = useRef(0);

  // A new resource starts empty (without waiting for an effect, so no frame shows old data).
  const current = state.id === identity ? state : { id: identity, data: null, error: null, updatedAt: null };

  const reload = useCallback(async () => {
    const gen = generation.current;
    if (inFlight.current === gen) return;
    inFlight.current = gen;
    try {
      const data = await loadRef.current();
      if (gen !== generation.current) return; // answered for deps that no longer apply
      setState({ id: identity, data, error: null, updatedAt: Date.now() });
      failures.current = 0;
    } catch (e: any) {
      if (gen !== generation.current) return;
      failures.current += 1;
      const msg = e?.message ?? String(e);
      const error = /429|Too many requests|rate limit/i.test(msg) ? "The RPC endpoint is rate-limiting requests; retrying shortly." : msg;
      setState((s) => (s.id === identity ? { ...s, error } : { id: identity, data: null, error, updatedAt: null }));
    } finally {
      if (inFlight.current === gen) inFlight.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  useEffect(() => {
    generation.current += 1;
    failures.current = 0;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let first = true;
    const tick = async () => {
      if (stopped) return;
      // Always load once; after that, skip polls while the tab is hidden.
      if (first || typeof document === "undefined" || !document.hidden) await reload();
      first = false;
      const delay = Math.min(120_000, intervalMs * 2 ** failures.current);
      timer = setTimeout(tick, delay);
    };
    const onVisible = () => {
      if (!document.hidden) reload();
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, intervalMs]);
  /** updatedAt: when the shown data was loaded (ms); since: when this resource started loading. */
  return { data: current.data, error: current.error, updatedAt: current.updatedAt, since, reload };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
