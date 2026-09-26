"use client";

import { Activity } from "lucide-react";
import { usePoll } from "@/lib/hooks";
import { fetchMakerProfiles } from "@/lib/chain";
import { loadBoard, type Board } from "@/lib/loaders";
import { usePersonas } from "@/lib/personas";
import { rating } from "@/lib/sla";
import { Grade, Party } from "@/components/sla";
import { InfoTip, Skeleton, fmt } from "@/components/ui";

const LADDER = [
  ["AAA", "99.5% or more of scored periods met, no breaches"],
  ["AA", "98% or more"],
  ["A", "95% or more"],
  ["BBB", "90% or more"],
  ["BB", "80% or more, or any breach"],
  ["B", "below 80%"],
  ["D", "breached at least half of its agreements"],
  ["NR", "fewer than 10 scored periods"],
];

export default function Makers() {
  const book = usePersonas();
  const { data, error } = usePoll(fetchMakerProfiles, [], 20_000);
  const { data: board } = usePoll(loadBoard, [], 30_000);
  const rows = (data ?? [])
    .map(({ p }) => {
      const ok = Number(p.periodsOk);
      const failed = Number(p.periodsFailed);
      return { p, ok, failed, rate: ok + failed ? ok / (ok + failed) : null, r: rating(p) };
    })
    .sort((a, b) => {
      const order = (g: string) => ["AAA", "AA", "A", "BBB", "BB", "B", "NR", "D"].indexOf(g);
      return order(a.r.grade) - order(b.r.grade) || (b.rate ?? -1) - (a.rate ?? -1) || b.ok - a.ok;
    });

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Computed from on-chain records</span>
          <h1 className="h1">Maker ratings</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "66ch" }}>
            The program writes every closed period to the maker&apos;s profile. Nobody self-reports, and the record follows the maker&apos;s wallet across every SLA it takes.
          </p>
          <p className="small muted" style={{ margin: "6px 0 0", maxWidth: "66ch" }}>
            Read it as service history, not an endorsement: a grade counts periods, not how much was at stake or who the counterparties were, so a maker could build one with friendly issuers and easy terms. The counterparties column shows how many different issuers it served.
          </p>
        </div>
      </div>

      <div className="card">
        {!data && !error && <div style={{ padding: 20, display: "grid", gap: 14 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}</div>}
        {!data && error && <div className="empty-state"><span>Could not reach the cluster: {error}</span></div>}
        {data && rows.length === 0 && (
          <div className="empty-state">
            <Activity />
            <span className="h3" style={{ color: "var(--ink)" }}>No market maker has taken an SLA yet</span>
            <span className="small">Ratings appear the moment a maker posts its first bond.</span>
          </div>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rating</th>
                  <th>Market maker</th>
                  <th>Periods met <InfoTip>Share of scored periods in which every check passed.</InfoTip></th>
                  <th className="r">Scored</th>
                  <th className="r">SLAs taken</th>
                  <th className="r">Completed</th>
                  <th className="r">Breached</th>
                  <th className="r">Counterparties <InfoTip>Distinct issuers across its agreements. More is harder to fake.</InfoTip></th>
                  <th className="r">Fees earned</th>
                  <th className="r">Bond slashed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, ok, failed, rate, r }) => (
                  <tr key={p.maker.toBase58()}>
                    <td><Grade r={r} large /></td>
                    <td><Party address={p.maker} book={book} /></td>
                    <td style={{ minWidth: 190 }}>
                      <div className="row" style={{ gap: 10 }}>
                        <span className="meter" style={{ width: 110 }}>
                          <span style={{ width: `${(rate ?? 0) * 100}%`, background: rate !== null && rate < 0.9 ? "var(--down)" : undefined }} />
                        </span>
                        <span className="num" style={{ fontWeight: 650 }}>{rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}</span>
                      </div>
                    </td>
                    <td className="r num">{(ok + failed).toLocaleString("en-US")}</td>
                    <td className="r num">{p.mandatesAccepted}</td>
                    <td className="r num">{p.mandatesCompleted}</td>
                    <td className="r num" style={{ color: p.mandatesBreached ? "var(--down)" : undefined, fontWeight: p.mandatesBreached ? 650 : undefined }}>{p.mandatesBreached}</td>
                    <td className="r num">{board ? counterparties(board, p.maker.toBase58()) : "…"}</td>
                    <td className="r num">{board ? perQuote(board, p.maker.toBase58(), "feesEarned") : "…"}</td>
                    <td className="r num" style={{ color: Number(p.bondSlashed) ? "var(--down)" : undefined }}>{board ? perQuote(board, p.maker.toBase58(), "bondSlashed") : "…"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 16, display: "grid", gap: 14 }}>
        <span className="h3">How ratings work</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "10px 24px" }}>
          {LADDER.map(([g, why]) => (
            <div key={g} className="row" style={{ gap: 10, alignItems: "baseline" }}>
              <span className="mono" style={{ fontWeight: 700, width: 34 }}>{g}</span>
              <span className="small muted">{why}</span>
            </div>
          ))}
        </div>
        <span className="xs muted">A rule applied to public data, not an opinion: anyone can recompute it from the maker profiles on-chain.</span>
      </div>
    </>
  );
}

/** Distinct issuers a maker has served. */
function counterparties(board: Board, maker: string) {
  return new Set(board.rows.filter((r) => r.m.maker.toBase58() === maker).map((r) => r.m.issuer.toBase58())).size;
}

/**
 * A money field summed over the maker's agreements, per quote token in its own decimals. The
 * on-chain profile adds raw amounts across quote mints, so it isn't used for money.
 */
function perQuote(board: Board, maker: string, field: "feesEarned" | "bondSlashed") {
  const totals = new Map<string, number>();
  for (const r of board.rows) {
    if (r.m.maker.toBase58() !== maker) continue;
    const mint = r.m.quoteMint.toBase58();
    const d = board.mints[mint]?.decimals;
    if (d === undefined) continue;
    totals.set(mint, (totals.get(mint) ?? 0) + Number(r.m[field]) / 10 ** d);
  }
  const parts = [...totals].filter(([, v]) => v > 0).map(([mint, v]) => `${fmt(v)} ${board.labels[mint]?.symbol ?? mint.slice(0, 4)}`);
  return parts.length ? parts.join(" + ") : "0";
}
