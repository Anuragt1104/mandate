"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Poll an async loader; returns { data, error, reload }. */
/**
 * Poll `load` every `intervalMs`, gently: never overlaps requests, pauses while the tab is
 * hidden, and backs off (up to 2 minutes) while the RPC is failing or rate-limiting.
 * The last good data stays on screen during errors.
 */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);
  const failures = useRef(0);
  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await loadRef.current());
      setError(null);
      failures.current = 0;
    } catch (e: any) {
      failures.current += 1;
      const msg = e?.message ?? String(e);
      setError(/429|Too many requests|rate limit/i.test(msg) ? "The RPC endpoint is rate-limiting requests; retrying shortly." : msg);
    } finally {
      inFlight.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || !document.hidden) await reload();
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
  return { data, error, reload };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
