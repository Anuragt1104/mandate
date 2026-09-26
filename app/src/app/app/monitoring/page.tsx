"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, FileUp, Radar } from "lucide-react";
import type { Session } from "../../../../../sdk/src/observe";
import { listSessions, saveSession, type SessionEntry } from "@/lib/local";
import { ago, shortAddr } from "@/components/ui";
import { useNow } from "@/lib/hooks";

/** Observations of existing arrangements kept in this browser, and importing the CLI verifier's files. */
export default function Monitoring() {
  const router = useRouter();
  const now = useNow(30_000);
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setSessions(listSessions()), []);

  async function importFile(f: File) {
    setError(null);
    try {
      const s = JSON.parse(await f.text()) as Session;
      if (s?.kind !== "mandate-observation" || s.version !== 1 || !Array.isArray(s.samples)) throw new Error("not a Mandate observation session");
      const label = `${s.pairFacts.baseSymbol ?? shortAddr(s.pairFacts.baseMint, 3)}/${s.pairFacts.quoteSymbol ?? "quote"} · ${s.operatorName ?? shortAddr(s.owner ?? s.position ?? "", 4)}`;
      if (!saveSession(s, label)) throw new Error("this browser refused to store it (storage full or blocked)");
      router.push(`/app/monitor?s=${s.id}`);
    } catch (e: any) {
      setError(`Couldn't import that file: ${e?.message ?? e}.`);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Read-only · no wallet needed</span>
          <h1 className="h1">Monitoring</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "66ch" }}>
            Observations of arrangements you already have. In the browser, observation runs only while its tab is open; for days of unattended monitoring, run the command-line verifier and import its file.
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => input.current?.click()}><FileUp />Import a session file</button>
          <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          <Link className="btn btn-primary" href="/app/monitor"><Radar />Monitor an arrangement</Link>
        </div>
      </div>
      {error && <div className="notice warn small" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="card">
        {sessions === null ? null : sessions.length === 0 ? (
          <div className="empty-state">
            <Activity />
            <span className="h3" style={{ color: "var(--ink)" }}>Nothing observed yet</span>
            <span className="small">Point Mandate at the pool your operator manages. You&apos;ll see evidence building within minutes.</span>
            <Link className="btn btn-primary btn-sm" href="/app/monitor">Monitor an arrangement</Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Market and operator</th><th>Network</th><th className="r">Samples</th><th className="r">Last update</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => router.push(`/app/monitor?s=${s.id}`)}>
                    <td><Link href={`/app/monitor?s=${s.id}`}><b>{s.label}</b></Link><div className="xs muted">started {ago(Math.max(0, now - s.startedAt))}</div></td>
                    <td className="small">{s.cluster}</td>
                    <td className="r num">{s.samples}</td>
                    <td className="r xs muted">{ago(Math.max(0, now - s.updatedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
