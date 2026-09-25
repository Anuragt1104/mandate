"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useMandateActions } from "@/lib/actions";
import { CLUSTER, mintDecimals } from "@/lib/chain";
import { pda } from "../../../../sdk/src";

type Form = Record<string, string>;

const DEFAULTS: Form = {
  baseMint: "", quoteMint: "", lbPair: "", referencePool: "", designatedMaker: "",
  baseDeposit: "0", quoteDeposit: "5000", feeBudget: "720",
  feePerPeriod: "1", periodMinutes: "60", durationPeriods: "168", bond: "250",
  maxSpreadBps: "100", minDepth: "500", depthWindowBps: "200", bandBps: "500", twapMinutes: "5",
  speedPctPerMin: "1", liquidityLockSecs: "30", maxConsecutiveFailures: "3", slashPct: "50",
};

function Field({ id, label, hint, form, set, mono = false }: { id: string; label: string; hint?: string; form: Form; set: (k: string, v: string) => void; mono?: boolean }) {
  return (
    <label className="field" htmlFor={id}>
      {label}
      <input id={id} value={form[id]} onChange={(e) => set(id, e.target.value)} spellCheck={false} style={mono ? undefined : { fontFamily: "var(--font-body)" }} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export default function CreateMandate() {
  const router = useRouter();
  const { run, busy, me } = useMandateActions();
  const [form, setForm] = useState<Form>(DEFAULTS);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Prefill with the demo launch on local clusters.
  useEffect(() => {
    fetch(CLUSTER === "localnet" ? "/demo.json" : `/demo.${CLUSTER}.json`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d) setForm((f) => ({ ...f, baseMint: d.baseMint, quoteMint: d.quoteMint, lbPair: d.lbPair, referencePool: d.dammPool }));
    }).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let key: PublicKey | null = null;
    const ok = await run("Create mandate", async (c, me) => {
      const base = new PublicKey(form.baseMint);
      const quote = new PublicKey(form.quoteMint);
      const [bd, qd] = await Promise.all([mintDecimals(base), mintDecimals(quote)]);
      const B = (v: string) => new BN(Math.round(Number(v) * 10 ** bd).toString());
      const Qn = (v: string) => new BN(Math.round(Number(v) * 10 ** qd).toString());
      const id = Math.floor(Date.now() / 1000);
      key = pda.mandate(me, base, id);
      return [
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(base, me, true), me, base),
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(quote, me, true), me, quote),
        await c.createMandate({
          issuer: me, baseMint: base, quoteMint: quote, lbPair: new PublicKey(form.lbPair), referencePool: new PublicKey(form.referencePool), id,
          terms: {
            feePerPeriod: Qn(form.feePerPeriod), periodSecs: Math.round(Number(form.periodMinutes) * 60), durationPeriods: Number(form.durationPeriods),
            bondAmount: Qn(form.bond), maxSpreadBps: Number(form.maxSpreadBps), minDepthQuote: Qn(form.minDepth), depthWindowBps: Number(form.depthWindowBps),
            bandBps: Number(form.bandBps), anchorTwapSecs: Math.round(Number(form.twapMinutes) * 60),
            anchorSpeedBpsPerMin: Math.round(Number(form.speedPctPerMin) * 100), liquidityLockSecs: Number(form.liquidityLockSecs),
            maxConsecutiveFailures: Number(form.maxConsecutiveFailures), slashBps: Math.round(Number(form.slashPct) * 100),
          },
          baseDeposit: B(form.baseDeposit), quoteDeposit: Qn(form.quoteDeposit), feeBudget: Qn(form.feeBudget),
          designatedMaker: form.designatedMaker ? new PublicKey(form.designatedMaker) : undefined,
        }),
      ];
    }, { done: "Mandate created and funded." });
    if (ok && key) router.push(`/mandate/${(key as PublicKey).toBase58()}`);
  }

  const f = { form, set };
  return (
    <form className="stack" onSubmit={submit}>
      <section className="hero">
        <span className="eyebrow">For token issuers and launchpads</span>
        <h1>Hire a market maker on terms the chain enforces.</h1>
        <p className="lede">
          Fund the vault and fee budget, then set the terms. Any maker, or the one you name, can accept by posting a bond. Tokens can only
          leave the vault as quotes on your DLMM pair: bids at or below the reference price, asks at or above it, within the band you set.
        </p>
      </section>

      <section className="panel stack">
        <h2>Market</h2>
        <div className="form-grid">
          <Field id="baseMint" label="Base token mint" {...f} mono />
          <Field id="quoteMint" label="Quote token mint" {...f} mono />
          <Field id="lbPair" label="Meteora DLMM pair" hint="Token X must be the base token." {...f} mono />
          <Field id="referencePool" label="Graduated pool (Meteora DAMM v2)" hint="The pool the token graduated into. Shown next to the reference price." {...f} mono />
        </div>
      </section>

      <section className="panel stack">
        <h2>Funding</h2>
        <div className="form-grid">
          <Field id="baseDeposit" label="Base inventory" hint="0 if the inventory comes from DBC leftover via the router." {...f} />
          <Field id="quoteDeposit" label="Quote inventory" {...f} />
          <Field id="feeBudget" label="Fee budget" hint="Pays the maker for compliant periods." {...f} />
        </div>
      </section>

      <section className="panel stack">
        <h2>Terms</h2>
        <div className="form-grid">
          <Field id="feePerPeriod" label="Fee per compliant period" {...f} />
          <Field id="periodMinutes" label="Period length (minutes)" {...f} />
          <Field id="durationPeriods" label="Number of periods" {...f} />
          <Field id="bond" label="Maker bond" {...f} />
          <Field id="maxSpreadBps" label="Max spread (bps)" hint="Measured at 10% of the depth target." {...f} />
          <Field id="minDepth" label="Min liquidity each side (quote)" {...f} />
          <Field id="depthWindowBps" label="Depth window (bps from reference)" {...f} />
          <Field id="bandBps" label="Allowed band around reference (bps)" {...f} />
          <Field id="twapMinutes" label="Reference TWAP window (minutes)" hint="The reference follows the DLMM pair's time-weighted price." {...f} />
          <Field id="speedPctPerMin" label="Reference speed limit (% per minute)" hint="Lower is harder to manipulate; higher follows fast markets." {...f} />
          <Field id="liquidityLockSecs" label="Liquidity lock (seconds)" hint="How long added liquidity must stay before it can be pulled." {...f} />
          <Field id="maxConsecutiveFailures" label="Failed periods before slashing" {...f} />
          <Field id="slashPct" label="Slash size (% of bond)" {...f} />
          <Field id="designatedMaker" label="Designated maker (optional)" hint="Leave empty to let any maker accept." {...f} mono />
        </div>
      </section>

      <div className="actions">
        <button className="btn brass" type="submit" disabled={!!busy || !me}>Create and fund mandate</button>
        {!me && <span className="hint">Connect a wallet to create a mandate.</span>}
      </div>
    </form>
  );
}
