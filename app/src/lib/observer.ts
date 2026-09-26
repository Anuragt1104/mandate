"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nextSampleIn, sampleOracle, takeSample, type Session } from "../../../sdk/src/observe";
import { connectionFor, type ReadCluster } from "./chain";
import { saveSession } from "./local";

/**
 * Runs an observation session while the page is open: the pair's oracle every 15 s (for the
 * reference) and the operator's book at random times, persisting after every sample. It
 * pauses when the page closes; the CLI verifier (scripts/verify.ts) is the unattended version.
 */
export function useObserver(initial: Session | null, label: string) {
  const [session, setSession] = useState<Session | null>(initial);
  const [running, setRunning] = useState(false);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const ref = useRef<Session | null>(initial);
  const busy = useRef(false);

  useEffect(() => {
    ref.current = initial;
    setSession(initial);
  }, [initial]);

  const persist = useCallback(() => {
    if (ref.current) setSaved(saveSession(ref.current, label));
    setSession(ref.current ? { ...ref.current } : null);
  }, [label]);

  useEffect(() => {
    if (!running || !ref.current) return;
    const s = ref.current;
    const conn = connectionFor(s.cluster as ReadCluster);
    let stopped = false;
    let oracleAt = 0;
    let next = Math.floor(Date.now() / 1000) + Math.min(10, nextSampleIn(s) / 2);
    setNextAt(next);
    const tick = async () => {
      if (stopped || busy.current) return;
      busy.current = true;
      const now = Math.floor(Date.now() / 1000);
      try {
        if (now - oracleAt >= 15) {
          oracleAt = now;
          await sampleOracle(conn, s, now);
        }
        if (now >= next) {
          const sample = await takeSample(conn, s);
          s.samples.push(sample);
          next = Math.floor(Date.now() / 1000) + nextSampleIn(s);
          setNextAt(next);
          setLastError(null);
          persist();
        }
      } catch (e: any) {
        setLastError(e?.message?.split("\n")[0] ?? String(e));
        next = Math.floor(Date.now() / 1000) + 20;
        setNextAt(next);
      } finally {
        busy.current = false;
      }
    };
    const t = setInterval(tick, 1_000);
    tick();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [running, persist]);

  return { session, running, start: () => setRunning(true), pause: () => setRunning(false), nextAt, lastError, saved, persist };
}
