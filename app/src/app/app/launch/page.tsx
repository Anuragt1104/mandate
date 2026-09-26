"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { Check } from "lucide-react";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useMandateActions, describeError } from "@/lib/actions";
import { useToast } from "@/components/Providers";
import { CLUSTER, explorerUrl, fetchSimBook } from "@/lib/chain";
import { pda } from "../../../../../sdk/src";
import { WalletButton } from "@/components/wallet";
import { Address, InfoTip } from "@/components/ui";

function Step({ n, state, title, children }: { n: number; state: "done" | "current" | "todo"; title: string; children: React.ReactNode }) {
  return (
    <div className="stepper-item">
      <span className={`stepper-dot ${state === "done" ? "done" : state === "current" ? "current" : ""}`}>{state === "done" ? <Check /> : n}</span>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="card-head"><span className="h3">{title}</span>{state === "done" && <span className="tag pass">Done</span>}</div>
        <div className="card-body" style={{ display: "grid", gap: 16 }}>{children}</div>
      </div>
    </div>
  );
}

export default function Launch() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { run, busy } = useMandateActions();
  const toast = useToast();
  const [quoteMint, setQuoteMint] = useState("");
  const [supply, setSupply] = useState("1000000000");
  const [leftoverPct, setLeftoverPct] = useState("10");
  const [initialMc, setInitialMc] = useState("20000");
  const [migrationMc, setMigrationMc] = useState("100000");
  const [config, setConfig] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [launched, setLaunched] = useState<{ mint: string; pool: string } | null>(null);
  const [routerExists, setRouterExists] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const router = publicKey ? pda.router(publicKey) : null;

  useEffect(() => {
    fetchSimBook()
      .then(async (b) => b?.quoteMint ?? (await fetch(CLUSTER === "localnet" ? "/demo.json" : `/demo.${CLUSTER}.json`).then((r) => (r.ok ? r.json() : null)))?.quoteMint)
      .then((q) => q && setQuoteMint(q))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!router) return setRouterExists(false);
    connection.getAccountInfo(router).then((i) => setRouterExists(!!i)).catch(() => {});
  }, [router?.toBase58(), connection]); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendSdkTx(label: string, tx: Transaction, signers: Keypair[]) {
    setWorking(label);
    try {
      tx.feePayer = publicKey!;
      const sig = await sendTransaction(tx, connection, { signers });
      await connection.confirmTransaction(sig, "confirmed");
      toast({ kind: "info", text: `${label}: done.`, href: explorerUrl(sig) });
      return true;
    } catch (e) {
      toast({ kind: "error", text: `${label} failed. ${describeError(e)}` });
      return false;
    } finally {
      setWorking(null);
    }
  }

  async function setUpLaunchpad() {
    if (!publicKey || !router) return;
    if (!routerExists) {
      const ok = await run("Create router", async (c, me) => [await c.initRouter({ authority: me })], { done: "Mandate router created." });
      if (!ok) return;
      setRouterExists(true);
    }
    const total = Number(supply);
    const params = buildCurveWithMarketCap({
      token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 6, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: total, leftover: Math.floor((total * Number(leftoverPct)) / 100) },
      fee: {
        baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
        dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
      },
      migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps25, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
      liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
      lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
      activationType: ActivationType.Timestamp,
      initialMarketCap: Number(initialMc),
      migrationMarketCap: Number(migrationMc),
    });
    const cfg = Keypair.generate();
    const dbc = new DynamicBondingCurveClient(connection, "confirmed");
    const tx = await dbc.partner.createConfig({ ...params, config: cfg.publicKey, feeClaimer: publicKey, leftoverReceiver: router, payer: publicKey, quoteMint: new PublicKey(quoteMint) });
    if (await sendSdkTx("Create Mandated config", tx, [cfg])) setConfig(cfg.publicKey.toBase58());
  }

  async function launchToken() {
    if (!publicKey) return;
    const mint = Keypair.generate();
    const dbc = new DynamicBondingCurveClient(connection, "confirmed");
    const tx = await dbc.creator.createPool({ name, symbol, uri: "", payer: publicKey, poolCreator: publicKey, config: new PublicKey(config), baseMint: mint.publicKey });
    if (await sendSdkTx("Launch token", tx, [mint])) {
      const pool = deriveDbcPoolAddress(new PublicKey(quoteMint), mint.publicKey, new PublicKey(config));
      setLaunched({ mint: mint.publicKey.toBase58(), pool: pool.toBase58() });
    }
  }

  const b = !!busy || !!working;
  const s1 = config ? "done" : "current";
  const s2 = launched ? "done" : config ? "current" : "todo";
  const s3 = launched ? "current" : "todo";

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">For launchpads</span>
          <h1 className="h1">Fund liquidity agreements from your launches</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "70ch" }}>
            Your bonding-curve config (Meteora DBC) sends each token&apos;s unsold supply to your Mandate router, and at graduation it moves
            into an agreement&apos;s escrow as quoting inventory instead of into anyone&apos;s wallet. That covers the asks. A working agreement
            also needs quote tokens for bids, a fee budget, and a maker who accepts and posts a bond, so start with the tokens whose teams
            will fund those.
          </p>
        </div>
      </div>

      <div className="grid-main">
        <div className="stepper">
          <Step n={1} state={s1} title="Set up your launchpad">
            <p className="small muted" style={{ margin: 0 }}>
              Creates your router (once) and a DBC config whose <span className="code">leftover_receiver</span> is the router. Graduated
              liquidity is permanently locked, and tokens migrate to DAMM v2 with a 0.25% fee.
            </p>
            <div className="form-grid">
              <label className="field span-2"><span className="field-label">Quote token mint</span>
                <input className="input mono" value={quoteMint} onChange={(e) => setQuoteMint(e.target.value)} placeholder="e.g. USDC" /></label>
              <label className="field"><span className="field-label">Total supply per token</span>
                <input className="input" value={supply} onChange={(e) => setSupply(e.target.value)} inputMode="numeric" /></label>
              <label className="field"><span className="field-label">Reserved for the market maker<InfoTip>Held back from the curve and routed into the token&apos;s SLA escrow at graduation.</InfoTip></span>
                <span className="input-wrap"><input className="input has-suffix" value={leftoverPct} onChange={(e) => setLeftoverPct(e.target.value)} inputMode="decimal" /><span className="input-suffix">%</span></span></label>
              <label className="field"><span className="field-label">Starting market cap</span>
                <input className="input" value={initialMc} onChange={(e) => setInitialMc(e.target.value)} inputMode="numeric" /></label>
              <label className="field"><span className="field-label">Graduation market cap</span>
                <input className="input" value={migrationMc} onChange={(e) => setMigrationMc(e.target.value)} inputMode="numeric" /></label>
            </div>
            <div className="row wrap">
              {publicKey ? (
                <button className="btn btn-primary" disabled={b || !quoteMint} onClick={setUpLaunchpad}>{working === "Create Mandated config" || busy === "Create router" ? "Working…" : routerExists ? "Create Mandated config" : "Create router and Mandated config"}</button>
              ) : <WalletButton />}
              {router && <span className="small muted row" style={{ gap: 6 }}>Router <Address value={router} /></span>}
            </div>
            {config && <span className="small row" style={{ gap: 6 }}>Config <Address value={config} /></span>}
          </Step>

          <Step n={2} state={s2} title="Launch a token">
            <div className="form-grid">
              <label className="field span-2"><span className="field-label">Mandated config</span>
                <input className="input mono" value={config} onChange={(e) => setConfig(e.target.value)} placeholder="Created in step 1" /></label>
              <label className="field"><span className="field-label">Token name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mandated Demo" /></label>
              <label className="field"><span className="field-label">Symbol</span>
                <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. MAND" /></label>
            </div>
            <div className="row wrap">
              <button className="btn btn-primary" disabled={b || !publicKey || !config || !name || !symbol} onClick={launchToken}>{working === "Launch token" ? "Launching…" : "Launch on the bonding curve"}</button>
            </div>
            {launched && (
              <div className="row wrap small" style={{ gap: 16 }}>
                <span className="row" style={{ gap: 6 }}>Mint <Address value={launched.mint} /></span>
                <span className="row" style={{ gap: 6 }}>Curve <Address value={launched.pool} /></span>
              </div>
            )}
          </Step>

          <Step n={3} state={s3} title="At graduation">
            <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
              When the curve completes, anyone can run DBC&apos;s migration and <span className="code">withdraw_leftover</span>. Then create the
              token&apos;s SLA with its DAMM v2 pool, register the launch, and anyone can route the leftover into the SLA&apos;s escrow.
              The repository&apos;s <span className="code">scripts/demo.ts</span> runs this whole sequence end to end.
            </p>
            <div className="row wrap">
              <Link className="btn btn-secondary" href="/app/create">Draft the token&apos;s SLA</Link>
              <Link className="btn btn-ghost" href="/app">See the live demo launch</Link>
            </div>
          </Step>
        </div>

        <div className="stack sticky">
          <div className="card">
            <div className="card-head"><span className="h3">What changes for your launches</span></div>
            <div className="card-body" style={{ display: "grid", gap: 12 }}>
              {[
                ["Without one", "Unsold supply goes to a wallet. Graduated pools sit nearly empty, and holders can't trade without moving the price."],
                ["With an agreement", "Unsold supply sits in escrow that can only quote. Once the team adds quote tokens and a fee budget and a maker accepts, both sides of the book are under a bonded commitment with a public status page."],
              ].map(([t, d], i) => (
                <div key={t} style={{ display: "grid", gap: 4, paddingBottom: i === 0 ? 12 : 0, borderBottom: i === 0 ? "1px solid var(--line)" : undefined }}>
                  <span className={`tag ${i === 0 ? "fail" : "pass"}`} style={{ justifySelf: "start" }}>{t}</span>
                  <span className="small" style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>{d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
