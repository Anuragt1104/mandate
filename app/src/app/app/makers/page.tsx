"use client";

import { Activity } from "lucide-react";
import { usePoll } from "@/lib/hooks";
import { fetchMakerProfiles } from "@/lib/chain";
import { Address, InfoTip, Skeleton, fmt } from "@/components/ui";

export default function Makers() {
  const { data, error } = usePoll(fetchMakerProfiles, [], 20_000);
  const rows = (data ?? [])
    .map(({ p }) => {
      const ok = Number(p.periodsOk);
      const failed = Number(p.periodsFailed);
      return { p, ok, failed, rate: ok + failed ? ok / (ok + failed) : null };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.ok - a.ok);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="h1">Maker records</h1>
          <p className="sub">
            Every figure is written by the Mandate program when a scoring period closes. Nobody self-reports, and a maker&apos;s record
            follows its wallet across every mandate it accepts.
          </p>
        </div>
      </div>

      <div className="card">
        {!data && !error && <div style={{ padding: 20, display: "grid", gap: 14 }}>{[0, 1].map((i) => <Skeleton key={i} h={44} />)}</div>}
        {!data && error && <div className="empty-state"><span>Could not reach the cluster: {error}</span></div>}
        {data && rows.length === 0 && (
          <div className="empty-state">
            <Activity />
            <span className="h3" style={{ color: "var(--ink)" }}>No market maker has accepted a mandate yet</span>
            <span className="small">Records appear here the moment a maker posts its first bond.</span>
          </div>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th>Market maker</th>
                  <th>Compliance <InfoTip>Share of observed periods in which every check passed.</InfoTip></th>
                  <th className="r">Periods passed</th>
                  <th className="r">Periods failed</th>
                  <th className="r">Mandates</th>
                  <th className="r">Completed</th>
                  <th className="r">Breached</th>
                  <th className="r">Fees earned</th>
                  <th className="r">Bond slashed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, ok, failed, rate }, i) => (
                  <tr key={p.maker.toBase58()}>
                    <td className="num muted">{i + 1}</td>
                    <td><Address value={p.maker} glyph chars={6} /></td>
                    <td style={{ minWidth: 180 }}>
                      <div className="row" style={{ gap: 10 }}>
                        <span className="meter" style={{ width: 110, marginTop: 0 }}>
                          <span style={{ width: `${(rate ?? 0) * 100}%`, background: rate !== null && rate < 0.9 ? "var(--fail)" : undefined }} />
                        </span>
                        <span className="num" style={{ fontWeight: 620 }}>{rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}</span>
                      </div>
                    </td>
                    <td className="r num">{ok}</td>
                    <td className="r num" style={{ color: failed ? "var(--fail)" : undefined }}>{failed}</td>
                    <td className="r num">{p.mandatesAccepted}</td>
                    <td className="r num">{p.mandatesCompleted}</td>
                    <td className="r num" style={{ color: p.mandatesBreached ? "var(--fail)" : undefined }}>{p.mandatesBreached}</td>
                    <td className="r num">{fmt(Number(p.feesEarned) / 1e6)}</td>
                    <td className="r num">{fmt(Number(p.bondSlashed) / 1e6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="xs faint" style={{ marginTop: 14 }}>Fees and bonds are shown in quote-token units (6 decimals).</p>
    </>
  );
}
