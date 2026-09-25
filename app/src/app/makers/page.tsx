"use client";

import { fetchMakerProfiles, short } from "@/lib/chain";
import { usePoll } from "@/lib/hooks";
import { fmt } from "@/components/ui";

export default function Makers() {
  const { data, error } = usePoll(fetchMakerProfiles, [], 8000);
  const rows = (data ?? [])
    .map(({ p }) => {
      const ok = Number(p.periodsOk);
      const failed = Number(p.periodsFailed);
      return { p, ok, failed, rate: ok + failed ? ok / (ok + failed) : null };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.ok - a.ok);

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Public track records</span>
        <h1>Market makers, ranked by what they actually did.</h1>
        <p className="lede">
          Every figure here is written by the Mandate program when a scoring period closes. Nobody self-reports. A maker&apos;s record follows
          its wallet across every mandate it accepts.
        </p>
      </section>
      <section className="panel">
        {error && <div className="empty">Could not reach the cluster ({error}).</div>}
        {!error && rows.length === 0 && <div className="empty">No market maker has accepted a mandate on this cluster yet.</div>}
        {rows.length > 0 && (
          <div className="board-wrap">
            <table className="board">
              <thead>
                <tr>
                  <th>Maker</th>
                  <th className="right">Compliance</th>
                  <th className="right">Periods passed</th>
                  <th className="right">Periods failed</th>
                  <th className="right">Mandates</th>
                  <th className="right">Completed</th>
                  <th className="right">Breached</th>
                  <th className="right">Fees earned</th>
                  <th className="right">Bond slashed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, ok, failed, rate }) => (
                  <tr key={p.maker.toBase58()} style={{ cursor: "default" }}>
                    <td className="addr">{short(p.maker, 6)}</td>
                    <td className="right num" style={{ color: rate === null ? undefined : rate >= 0.95 ? "var(--ok)" : rate < 0.8 ? "var(--fail)" : undefined }}>
                      {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
                    </td>
                    <td className="right num">{ok}</td>
                    <td className="right num">{failed}</td>
                    <td className="right num">{p.mandatesAccepted}</td>
                    <td className="right num">{p.mandatesCompleted}</td>
                    <td className="right num" style={{ color: p.mandatesBreached > 0 ? "var(--fail)" : undefined }}>{p.mandatesBreached}</td>
                    <td className="right num">{fmt(Number(p.feesEarned) / 1e6)}</td>
                    <td className="right num">{fmt(Number(p.bondSlashed) / 1e6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
