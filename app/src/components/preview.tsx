/**
 * Static, clearly labelled example fragments of the product for the landing page: what a
 * team sees, not live data and not customer traction.
 */
import { Check, CircleDashed } from "lucide-react";

const PATTERN = "mmmmmmmmmmmmmm-mmmmmmmmmxxmmmmmmmmmmmmmmmmmmmmmmm".split("");

export function ExampleTicks({ codes = PATTERN, size = "lg" }: { codes?: string[]; size?: "md" | "lg" }) {
  return (
    <div className={`ticks ${size}`} role="img" aria-label={`Example: ${codes.filter((c) => c === "m").length} periods met, ${codes.filter((c) => c === "x").length} missed, ${codes.filter((c) => c === "-").length} not checked`}>
      {codes.map((c, i) => <span key={i} className={`tick ${c === "m" ? "up" : c === "x" ? "down" : "idle"}`} />)}
    </div>
  );
}

/** The hero preview: one agreement, its latest verified state, and the next action. */
export function ProductPreview() {
  const row = (k: string, v: string, target: string) => (
    <div className="pv-row">
      <span className="pv-k"><Check aria-hidden="true" />{k}</span>
      <span className="pv-v num">{v}</span>
      <span className="pv-t">{target}</span>
    </div>
  );
  return (
    <div className="preview" aria-label="Example agreement, illustrative data">
      <div className="pv-card">
        <div className="pv-head">
          <div style={{ display: "grid", gap: 2 }}>
            <span className="pv-title">KITE/USDC</span>
            <span className="xs muted">Operator: your current market maker</span>
          </div>
          <span className="chip up"><span className="dot" />Operational</span>
        </div>
        <ExampleTicks />
        <div className="xs muted row-between"><span>Last 48 hourly periods</span><span>46 of 47 checked periods met</span></div>
        <div className="pv-rows">
          {row("Committed bids", "2,640 USDC", "at least 500 within 2%")}
          {row("Committed asks", "3,105 USDC", "at least 500 within 2%")}
          {row("Spread", "10 bps", "at most 100")}
        </div>
        <div className="pv-next">
          <span className="small"><b>Next:</b> the term ends in 3 days. The renewal report is ready.</span>
          <span className="btn btn-sm btn-primary" aria-hidden="true">Review renewal</span>
        </div>
      </div>
      <span className="pv-label">Example data</span>
    </div>
  );
}

export function ObserveFragment() {
  return (
    <div className="frag">
      <ExampleTicks size="md" codes={"mmmmmmmmm---".split("")} />
      <div className="row-between xs"><span className="row" style={{ gap: 6 }}><CircleDashed style={{ width: 13 }} />Collecting evidence</span><span className="muted">9 of 12 periods</span></div>
      <span className="meter" aria-hidden="true"><span style={{ width: "75%" }} /></span>
    </div>
  );
}

export function AgreeFragment() {
  return (
    <div className="frag">
      <span className="xs muted">Version 2, proposed by the operator</span>
      <span className="xs">Operator bond: 250 → <b>200</b></span>
      <span className="xs">Failed periods before breach: 3 → <b>4</b></span>
      <span className="xs row" style={{ gap: 10 }}><span className="row" style={{ gap: 4 }}><Check style={{ width: 13, color: "var(--up)" }} />Team</span><span className="row" style={{ gap: 4 }}><Check style={{ width: 13, color: "var(--up)" }} />Operator</span><span className="mono muted">terms 7a68…</span></span>
    </div>
  );
}

export function RenewFragment() {
  return (
    <div className="frag">
      <div className="row-between xs"><span className="muted">Paid to the operator</span><b>712 USDC</b></div>
      <div className="row-between xs"><span className="muted">Unused budget, returned</span><b>8 USDC</b></div>
      <div className="row-between xs"><span className="muted">Penalties</span><b>none</b></div>
      <span className="xs">Proposed: ask for the depth that was delivered</span>
    </div>
  );
}
