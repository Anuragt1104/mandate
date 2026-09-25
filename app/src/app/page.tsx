"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, connection, fetchAllMandates, readClient, short } from "@/lib/chain";
import { usePoll } from "@/lib/hooks";
import { StatusChip, Tape, duration, fmt } from "@/components/ui";
import { statusName } from "../../../sdk/src";

async function loadBoard() {
  const rows = await fetchAllMandates();
  const logs = await connection().getMultipleAccountsInfo(rows.map((r) => r.m.scoreLog as PublicKey));
  const client = readClient();
  return rows.map((r, i) => {
    let entries: { status: number }[] = [];
    const info = logs[i];
    if (info) {
      const log = client.decodeScoreLog(info.data);
      const n = log.count as number;
      const len = log.entries.length as number;
      for (let k = 0; k < n; k++) entries.push(log.entries[(log.head - n + k + len) % len]);
    }
    return { ...r, entries };
  });
}

export default function Board() {
  const router = useRouter();
  const { data, error } = usePoll(loadBoard, [], 15_000);
  const [study, setStudy] = useState<any>(null);
  useEffect(() => {
    fetch("/study.json").then((r) => (r.ok ? r.json() : null)).then((d) => setStudy(d?.summary ?? null)).catch(() => {});
  }, []);
  const rows = data ?? [];
  const ok = rows.reduce((s, r) => s + r.m.periodsOk, 0);
  const failed = rows.reduce((s, r) => s + r.m.periodsFailed, 0);
  const active = rows.filter((r) => statusName(r.m.status) === "Active").length;
  const bonds = rows.filter((r) => ["Active", "Breached", "Expired"].includes(statusName(r.m.status))).reduce((s, r) => s + r.m.terms.bondAmount.toNumber() / 1e6, 0);
  const slashed = rows.reduce((s, r) => s + r.m.bondSlashed.toNumber() / 1e6, 0);

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Designated market making, enforced on-chain</span>
        <h1>Liquidity you can verify, not just promise.</h1>
        <p className="lede">
          Each mandate below is a market-making contract on Solana. The issuer&apos;s tokens sit in a vault that can only quote on
          Meteora DLMM: bids at or below a manipulation-resistant reference price, asks at or above it. Anyone can check the
          maker&apos;s quotes at any time. The maker is paid for every compliant period, and its bond is slashed if it stops quoting.
        </p>
      </section>

      <div className="stats" aria-label="Network totals">
        <div className="stat"><div className="label">Active mandates</div><div className="value">{active}</div></div>
        <div className="stat"><div className="label">Periods scored</div><div className="value">{ok + failed}</div></div>
        <div className="stat"><div className="label">Compliance</div><div className="value">{ok + failed ? `${Math.round((100 * ok) / (ok + failed))}%` : "—"}</div></div>
        <div className="stat"><div className="label">Bonds posted</div><div className="value">{fmt(bonds, 0)}</div></div>
        <div className="stat"><div className="label">Bonds slashed</div><div className="value">{fmt(slashed, 0)}</div></div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Mandates</h2>
          <Link className="btn ghost" href="/create">New mandate</Link>
        </div>
        {error && !data && <div className="empty">Could not reach the cluster: {error}</div>}
        {error && data && <p className="hint">Showing the last loaded data. {error}</p>}
        {!error && data && rows.length === 0 && (
          <div className="empty">No mandates on this cluster yet. Run <span className="mono">npx tsx scripts/demo.ts</span> or create one.</div>
        )}
        {rows.length > 0 && (
          <div className="board-wrap">
            <table className="board">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Status</th>
                  <th>Maker</th>
                  <th>Periods</th>
                  <th className="right">Last check</th>
                  <th className="right">Fee / period</th>
                  <th className="right">Bond</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ pubkey, m, entries }) => {
                  const status = statusName(m.status);
                  const last = m.last;
                  return (
                    <tr key={pubkey.toBase58()} onClick={() => router.push(`/mandate/${pubkey.toBase58()}`)}>
                      <td>
                        <Link href={`/mandate/${pubkey.toBase58()}`} onClick={(e) => e.stopPropagation()} style={{ textDecoration: "none" }}>
                          <div className="num">{short(m.baseMint)} / {short(m.quoteMint)}</div>
                          <div className="addr">{short(pubkey, 6)} · {duration(m.terms.periodSecs)} periods</div>
                        </Link>
                      </td>
                      <td><StatusChip status={status} /></td>
                      <td className="addr">{(m.maker as PublicKey).equals(PublicKey.default) ? "Open to any maker" : short(m.maker)}</td>
                      <td>
                        <Tape
                          entries={entries.slice(-24)}
                          live={status === "Active" && m.curSnapshots > 0 ? { failed: m.curFailedSnapshots > 0 } : null}
                          total={status === "Active" ? m.terms.durationPeriods : undefined}
                        />
                      </td>
                      <td className="right">
                        {m.snapshotsTotal > 0 ? (
                          <span className={`chip ${last.ok ? "ok" : "fail"}`} title={`spread ${last.spreadBps} bps`}>
                            {last.ok ? "Pass" : "Fail"} · {last.spreadBps === 65535 ? "no quotes" : `${last.spreadBps} bps`}
                          </span>
                        ) : (
                          <span className="muted">Not checked</span>
                        )}
                      </td>
                      <td className="right num">{fmt(m.terms.feePerPeriod.toNumber() / 1e6)}</td>
                      <td className="right num">{fmt(m.terms.bondAmount.toNumber() / 1e6, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Why this exists</h2>
          <Link href="/study" className="btn ghost">Read the liquidity study</Link>
        </div>
        <p className="lede" style={{ fontSize: 15 }}>
          {study ? (
            <>
              In our scan of the {study.poolsScanned.toLocaleString()} newest Meteora DAMM v2 pools, only {study.tvlAtLeast1k.pools} of{" "}
              {study.all.pools.toLocaleString()} still held $1,000 of liquidity, and the {study.volume24hAtLeast10k.pools} pools that traded
              $10,000+ in a day could absorb a median of ${study.volume24hAtLeast10k.medianDepth2pctUsd.toFixed(3)} before moving 2%.{" "}
            </>
          ) : null}
          Market makers exist to fix this. In crypto their contracts are private and cannot be verified. Mandate turns the contract into a program.
        </p>
      </section>
      <p className="foot">Amounts are shown in quote-token units (6 decimals). Data refreshes every 15 seconds from Solana {CLUSTER}.</p>
    </div>
  );
}
