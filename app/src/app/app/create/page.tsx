"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CircleAlert, FileText } from "lucide-react";
import { useMandateActions } from "@/lib/actions";
import { CLUSTER, fetchTokenLabels, mintDecimals, type TokenLabel } from "@/lib/chain";
import { pda } from "../../../../../sdk/src";
import { WalletButton } from "@/components/wallet";
import { InfoTip, duration, fmtFull } from "@/components/ui";

type Form = Record<string, string>;

const MARKET: Form = { baseMint: "", quoteMint: "", lbPair: "", referencePool: "", designatedMaker: "" };
const FUNDING: Form = { baseDeposit: "0", quoteDeposit: "5000", feeBudget: "720" };
const PRESETS: { id: string; name: string; blurb: string; terms: Form }[] = [
  {
    id: "standard",
    name: "Standard",
    blurb: "Balanced terms for a freshly graduated token.",
    terms: { feePerPeriod: "1", periodMinutes: "60", durationPeriods: "720", bond: "250", maxSpreadBps: "100", minDepth: "500", depthWindowBps: "200", bandBps: "500", twapMinutes: "5", speedPctPerMin: "1", liquidityLockSecs: "30", maxConsecutiveFailures: "3", slashPct: "50" },
  },
  {
    id: "tight",
    name: "Tight book",
    blurb: "Deeper, tighter quotes and a stricter bond.",
    terms: { feePerPeriod: "3", periodMinutes: "60", durationPeriods: "720", bond: "1000", maxSpreadBps: "50", minDepth: "2000", depthWindowBps: "100", bandBps: "300", twapMinutes: "5", speedPctPerMin: "1", liquidityLockSecs: "60", maxConsecutiveFailures: "2", slashPct: "100" },
  },
  {
    id: "volatile",
    name: "Volatile launch",
    blurb: "Wider tolerances for a token that still moves fast.",
    terms: { feePerPeriod: "1", periodMinutes: "30", durationPeriods: "672", bond: "250", maxSpreadBps: "200", minDepth: "250", depthWindowBps: "300", bandBps: "1000", twapMinutes: "3", speedPctPerMin: "3", liquidityLockSecs: "30", maxConsecutiveFailures: "5", slashPct: "50" },
  },
];

const isKey = (s: string) => {
  try {
    new PublicKey(s);
    return s.length >= 32;
  } catch {
    return false;
  }
};

function Field({ id, label, hint, info, form, set, suffix, mono = false, error }: {
  id: string; label: string; hint?: string; info?: string; form: Form; set: (k: string, v: string) => void; suffix?: string; mono?: boolean; error?: string;
}) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}{info && <InfoTip>{info}</InfoTip>}</span>
      <span className="input-wrap">
        <input id={id} className={`input ${mono ? "mono" : ""} ${suffix ? "has-suffix" : ""}`} value={form[id]} onChange={(e) => set(id, e.target.value)} spellCheck={false}
          inputMode={mono ? "text" : "decimal"} aria-invalid={!!error} style={error ? { borderColor: "var(--fail)" } : undefined} />
        {suffix && <span className="input-suffix">{suffix}</span>}
      </span>
      {error ? <span className="field-hint" style={{ color: "var(--fail)" }}>{error}</span> : hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export default function CreateMandate() {
  const router = useRouter();
  const { run, busy, me } = useMandateActions();
  const [preset, setPreset] = useState("standard");
  const [form, setForm] = useState<Form>({ ...MARKET, ...FUNDING, ...PRESETS[0].terms });
  const [labels, setLabels] = useState<Record<string, TokenLabel>>({});
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    fetch(CLUSTER === "localnet" ? "/demo.json" : `/demo.${CLUSTER}.json`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d) setForm((f) => ({ ...f, baseMint: d.baseMint, quoteMint: d.quoteMint, lbPair: d.lbPair, referencePool: d.dammPool }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const mints = [form.baseMint, form.quoteMint].filter(isKey).map((m) => new PublicKey(m));
    if (mints.length) fetchTokenLabels(mints).then(setLabels).catch(() => {});
  }, [form.baseMint, form.quoteMint]);

  const baseSym = labels[form.baseMint]?.symbol ?? "base";
  const quoteSym = labels[form.quoteMint]?.symbol ?? "quote";
  const n = (k: string) => Number(form[k]);

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    for (const k of ["baseMint", "quoteMint", "lbPair", "referencePool"]) if (!isKey(form[k])) e[k] = "Enter a valid Solana address.";
    if (form.designatedMaker && !isKey(form.designatedMaker)) e.designatedMaker = "Enter a valid address or leave empty.";
    for (const k of ["feePerPeriod", "bond", "minDepth", "quoteDeposit", "feeBudget", "baseDeposit"]) if (!(n(k) >= 0)) e[k] = "Enter a number.";
    if (!(n("periodMinutes") >= 1)) e.periodMinutes = "At least 1 minute.";
    if (!(n("durationPeriods") >= 1)) e.durationPeriods = "At least 1 period.";
    if (!(n("maxSpreadBps") > 0)) e.maxSpreadBps = "Must be above 0.";
    if (!(n("twapMinutes") >= 0.5)) e.twapMinutes = "At least 30 seconds.";
    if (!(n("speedPctPerMin") > 0)) e.speedPctPerMin = "Must be above 0.";
    if (n("liquidityLockSecs") > n("periodMinutes") * 60) e.liquidityLockSecs = "Must not exceed the period length.";
    if (!(n("slashPct") >= 0 && n("slashPct") <= 100)) e.slashPct = "Between 0 and 100.";
    return e;
  }, [form]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = Object.keys(errors).length === 0;
  const maxPayout = n("feePerPeriod") * n("durationPeriods");
  const budgetPeriods = n("feePerPeriod") > 0 ? Math.floor(n("feeBudget") / n("feePerPeriod")) : Infinity;
  const underfunded = budgetPeriods < n("durationPeriods");

  function applyPreset(id: string) {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id)!;
    setForm((f) => ({ ...f, ...p.terms, feeBudget: String(Number(p.terms.feePerPeriod) * Number(p.terms.durationPeriods)) }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    let key: PublicKey | null = null;
    const ok = await run("Create mandate", async (c, me) => {
      const base = new PublicKey(form.baseMint);
      const quote = new PublicKey(form.quoteMint);
      const [bd, qd] = await Promise.all([mintDecimals(base), mintDecimals(quote)]);
      const B = (v: string) => new BN(Math.round(Number(v) * 10 ** bd).toString());
      const Q = (v: string) => new BN(Math.round(Number(v) * 10 ** qd).toString());
      const id = Math.floor(Date.now() / 1000);
      key = pda.mandate(me, base, id);
      return [
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(base, me, true), me, base),
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(quote, me, true), me, quote),
        await c.createMandate({
          issuer: me, baseMint: base, quoteMint: quote, lbPair: new PublicKey(form.lbPair), referencePool: new PublicKey(form.referencePool), id,
          terms: {
            feePerPeriod: Q(form.feePerPeriod), periodSecs: Math.round(n("periodMinutes") * 60), durationPeriods: n("durationPeriods"),
            bondAmount: Q(form.bond), maxSpreadBps: n("maxSpreadBps"), minDepthQuote: Q(form.minDepth), depthWindowBps: n("depthWindowBps"),
            bandBps: n("bandBps"), anchorTwapSecs: Math.round(n("twapMinutes") * 60), anchorSpeedBpsPerMin: Math.round(n("speedPctPerMin") * 100),
            liquidityLockSecs: n("liquidityLockSecs"), maxConsecutiveFailures: n("maxConsecutiveFailures"), slashBps: Math.round(n("slashPct") * 100),
          },
          baseDeposit: B(form.baseDeposit), quoteDeposit: Q(form.quoteDeposit), feeBudget: Q(form.feeBudget),
          designatedMaker: form.designatedMaker ? new PublicKey(form.designatedMaker) : undefined,
        }),
      ];
    }, { done: "Mandate created and funded. It is now open to market makers." });
    if (ok && key) router.push(`/app/mandate/${(key as PublicKey).toBase58()}`);
  }

  const f = { form, set };
  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <div>
          <h1 className="h1">New mandate</h1>
          <p className="sub">Fund a vault and set the terms. Any market maker, or the one you name, can accept by posting a bond. You can cancel and recover everything until someone accepts.</p>
        </div>
      </div>

      <div className="grid-main">
        <div className="card">
          <div className="form-section">
            <div className="form-section-head"><span className="h3">Start from a profile</span><span className="small muted">Every value can be adjusted below.</span></div>
            <div className="presets" role="group" aria-label="Presets">
              {PRESETS.map((p) => (
                <button type="button" key={p.id} className="preset" aria-pressed={preset === p.id} onClick={() => applyPreset(p.id)}>
                  <b>{p.name}</b><span className="small muted">{p.blurb}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-head"><span className="h3">Market</span><span className="small muted">The token&apos;s Meteora DLMM pair and the DAMM v2 pool it graduated into.{CLUSTER !== "mainnet" && " Prefilled with the devnet demo launch."}</span></div>
            <div className="form-grid">
              <Field id="baseMint" label="Base token mint" mono {...f} error={errors.baseMint} hint={labels[form.baseMint] ? labels[form.baseMint].name : undefined} />
              <Field id="quoteMint" label="Quote token mint" mono {...f} error={errors.quoteMint} hint={labels[form.quoteMint] ? labels[form.quoteMint].name : undefined} />
              <Field id="lbPair" label="Meteora DLMM pair" mono {...f} error={errors.lbPair} hint="Token X must be the base token." />
              <Field id="referencePool" label="Graduated pool (DAMM v2)" mono {...f} error={errors.referencePool} hint="Shown next to the reference price for comparison." />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-head"><span className="h3">Funding</span><span className="small muted">Deposited into a program-owned vault. Inventory can only be quoted, then returns to you.</span></div>
            <div className="form-grid">
              <Field id="baseDeposit" label="Base inventory" suffix={baseSym} {...f} error={errors.baseDeposit} hint="Use 0 if the inventory comes from a Mandated launch." />
              <Field id="quoteDeposit" label="Quote inventory" suffix={quoteSym} {...f} error={errors.quoteDeposit} />
              <Field id="feeBudget" label="Fee budget" suffix={quoteSym} {...f} error={errors.feeBudget} hint="Pays the maker for compliant periods." />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-head"><span className="h3">Obligations</span><span className="small muted">What the maker must keep quoted, measured around the reference price.</span></div>
            <div className="form-grid">
              <Field id="minDepth" label="Min liquidity each side" suffix={quoteSym} {...f} error={errors.minDepth} info="Committed bids below the reference, and asks above it, each valued in the quote token." />
              <Field id="depthWindowBps" label="Measured within" suffix="bps" {...f} info="Only liquidity within this distance of the reference counts toward the minimum." />
              <Field id="maxSpreadBps" label="Max spread" suffix="bps" {...f} error={errors.maxSpreadBps} info="Measured at a size of 10% of the minimum liquidity, so dust quotes don't count." />
              <Field id="bandBps" label="Allowed band" suffix="bps" {...f} info="The vault may only place liquidity within this distance of the reference." />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-head"><span className="h3">Reference price</span><span className="small muted">Follows the pair&apos;s time-weighted price, so a price pushed for one transaction moves nothing.</span></div>
            <div className="form-grid">
              <Field id="twapMinutes" label="Time-weighted over" suffix="min" {...f} error={errors.twapMinutes} />
              <Field id="speedPctPerMin" label="Max speed" suffix="%/min" {...f} error={errors.speedPctPerMin} info="Lower is harder to manipulate; higher keeps up with fast markets." />
              <Field id="liquidityLockSecs" label="Liquidity lock" suffix="sec" {...f} error={errors.liquidityLockSecs} info="Liquidity must stay deployed this long before it can be withdrawn." />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-head"><span className="h3">Economics and enforcement</span></div>
            <div className="form-grid">
              <Field id="feePerPeriod" label="Fee per compliant period" suffix={quoteSym} {...f} error={errors.feePerPeriod} />
              <Field id="periodMinutes" label="Period length" suffix="min" {...f} error={errors.periodMinutes} />
              <Field id="durationPeriods" label="Number of periods" {...f} error={errors.durationPeriods} />
              <Field id="bond" label="Maker bond" suffix={quoteSym} {...f} error={errors.bond} />
              <Field id="maxConsecutiveFailures" label="Slash after failed periods in a row" {...f} />
              <Field id="slashPct" label="Slash size" suffix="%" {...f} error={errors.slashPct} />
              <Field id="designatedMaker" label="Designated maker (optional)" mono {...f} error={errors.designatedMaker} hint="Leave empty to let any maker accept." />
            </div>
          </div>
        </div>

        <div className="stack sticky">
          <div className="card">
            <div className="card-head"><span className="h3"><FileText style={{ width: 16, height: 16, color: "var(--muted)" }} />Term sheet</span><span className="xs muted">Preview</span></div>
            <div className="card-body" style={{ display: "grid", gap: 14, fontSize: 14, lineHeight: 1.55 }}>
              <p style={{ margin: 0 }}>
                The maker keeps at least <b>{fmtFull(n("minDepth"))} {quoteSym}</b> of bids within {n("depthWindowBps") / 100}% below the reference price and the same of asks above it, quoted within <b>{n("maxSpreadBps")} bps</b>.
              </p>
              <p style={{ margin: 0 }}>
                Each compliant <b>{duration(n("periodMinutes") * 60)}</b> period pays <b>{fmtFull(n("feePerPeriod"))} {quoteSym}</b>, for {n("durationPeriods")} periods ({duration(n("periodMinutes") * 60 * n("durationPeriods"))}).
              </p>
              <p style={{ margin: 0 }}>
                <b>{n("maxConsecutiveFailures")}</b> failed periods in a row slash <b>{n("slashPct")}%</b> of the {fmtFull(n("bond"))} {quoteSym} bond and end the mandate.
              </p>
              <dl className="dl">
                <dt>Maximum payout</dt><dd>{fmtFull(maxPayout)} {quoteSym}</dd>
                <dt>Fee budget covers</dt><dd style={{ color: underfunded ? "var(--warn)" : undefined }}>{isFinite(budgetPeriods) ? `${Math.min(budgetPeriods, n("durationPeriods"))} of ${n("durationPeriods")} periods` : "all periods"}</dd>
                <dt>Inventory</dt><dd>{fmtFull(n("baseDeposit"))} {baseSym} · {fmtFull(n("quoteDeposit"))} {quoteSym}</dd>
              </dl>
              {underfunded && (
                <div className="notice"><CircleAlert />The fee budget runs out after {budgetPeriods} periods. Makers may not accept, or you can top it up later.</div>
              )}
            </div>
            <div className="card-foot" style={{ display: "grid", gap: 8 }}>
              {me ? (
                <button className="btn btn-primary btn-block" type="submit" disabled={!!busy || !valid}>{busy ? "Creating…" : "Create and fund mandate"}</button>
              ) : <WalletButton />}
              <span className="xs muted">{valid ? "You sign one transaction. Funds move into the mandate's vault." : "Fix the highlighted fields to continue."}</span>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
