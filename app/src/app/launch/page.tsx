"use client";

import { useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
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
import { explorerUrl, short } from "@/lib/chain";
import { pda } from "../../../../sdk/src";

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
  const router = publicKey ? pda.router(publicKey) : null;

  async function sendSdkTx(label: string, tx: Transaction, signers: Keypair[]) {
    try {
      tx.feePayer = publicKey!;
      const sig = await sendTransaction(tx, connection, { signers });
      await connection.confirmTransaction(sig, "confirmed");
      toast({ kind: "info", text: `${label}: done.`, href: explorerUrl(sig) });
      return true;
    } catch (e) {
      toast({ kind: "error", text: `${label} failed. ${describeError(e)}` });
      return false;
    }
  }

  async function setUpLaunchpad() {
    if (!publicKey || !router) return;
    if (!(await connection.getAccountInfo(router))) {
      const ok = await run("Create router", async (c, me) => [await c.initRouter({ authority: me })], { done: "Mandate router created." });
      if (!ok) return;
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

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">For launchpads on Meteora DBC</span>
        <h1>Every token you launch graduates with a market maker under contract.</h1>
        <p className="lede">
          A Mandated launch is a Meteora Dynamic Bonding Curve config whose <span className="mono">leftover_receiver</span> is your Mandate router.
          When a token graduates to DAMM v2, its unsold supply lands in the router and is routed into that token&apos;s mandate vault, where it
          can only be used as quotes around the graduated price.
        </p>
      </section>

      <section className="panel stack">
        <div className="panel-head"><h2>1. Set up your launchpad</h2>{router && <span className="addr">router {short(router, 6)}</span>}</div>
        <div className="form-grid">
          <label className="field" htmlFor="quote">Quote token mint<input id="quote" value={quoteMint} onChange={(e) => setQuoteMint(e.target.value)} placeholder="e.g. USDC" /></label>
          <label className="field" htmlFor="supply">Total supply per token<input id="supply" value={supply} onChange={(e) => setSupply(e.target.value)} /></label>
          <label className="field" htmlFor="leftover">Reserved for the market maker (%)<input id="leftover" value={leftoverPct} onChange={(e) => setLeftoverPct(e.target.value)} /><span className="hint">Held back from the curve and routed to the mandate at graduation.</span></label>
          <label className="field" htmlFor="imc">Starting market cap (quote)<input id="imc" value={initialMc} onChange={(e) => setInitialMc(e.target.value)} /></label>
          <label className="field" htmlFor="mmc">Graduation market cap (quote)<input id="mmc" value={migrationMc} onChange={(e) => setMigrationMc(e.target.value)} /></label>
        </div>
        <p className="hint">Graduated liquidity is 100% permanently locked, which keeps the DAMM v2 reference price hard to move. Tokens graduate to DAMM v2 with a 0.25% fee.</p>
        <div className="actions"><button className="btn brass" disabled={!publicKey || !quoteMint || !!busy} onClick={setUpLaunchpad}>Create router and Mandated config</button></div>
        {config && <p className="mono">config {config}</p>}
      </section>

      <section className="panel stack">
        <h2>2. Launch a token</h2>
        <div className="form-grid">
          <label className="field" htmlFor="cfg">Mandated config<input id="cfg" value={config} onChange={(e) => setConfig(e.target.value)} /></label>
          <label className="field" htmlFor="name">Token name<input id="name" value={name} onChange={(e) => setName(e.target.value)} style={{ fontFamily: "var(--font-body)" }} /></label>
          <label className="field" htmlFor="sym">Symbol<input id="sym" value={symbol} onChange={(e) => setSymbol(e.target.value)} style={{ fontFamily: "var(--font-body)" }} /></label>
        </div>
        <div className="actions"><button className="btn brass" disabled={!publicKey || !config || !name || !symbol} onClick={launchToken}>Launch on the bonding curve</button></div>
        {launched && <p className="mono">mint {launched.mint} · curve {launched.pool}</p>}
      </section>

      <section className="panel stack">
        <h2>3. At graduation</h2>
        <p className="lede" style={{ fontSize: 15 }}>
          When the curve completes, anyone can run DBC&apos;s migration and <span className="mono">withdraw_leftover</span>. Then create the token&apos;s mandate
          on <Link href="/create">New mandate</Link> with the DAMM v2 pool as the reference, register the launch and route the leftover into the vault.
          <span className="mono"> scripts/demo.ts</span> runs the whole sequence end to end.
        </p>
      </section>
    </div>
  );
}
