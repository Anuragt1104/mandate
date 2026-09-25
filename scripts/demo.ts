/**
 * Runs the full Mandated-launch flow against a cluster and writes the resulting
 * addresses to app/public/demo.json (used by the web app) and .keys/ (bot keypairs). Off
 * localnet set CLUSTER (e.g. devnet): outputs go to app/public/demo.devnet.json and .keys/devnet/.
 *
 *   ./scripts/localnet.sh            # in another terminal
 *   npx tsx scripts/demo.ts          # RPC_URL defaults to http://127.0.0.1:8899
 *
 * Flow: router → DBC config (leftover_receiver = router) → token launch → buys to
 * graduation → DAMM v2 migration → withdraw leftover → DLMM pair at the graduated
 * price → mandate (register launch, route leftover) → maker accepts.
 * A second mandate is left open for the "accept" flow in the UI.
 */
import fs from "fs";
import path from "path";
import { BN } from "@coral-xyz/anchor";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { MandateTerms, pda } from "../sdk/src";
import { RPC_URL, loadKeypair, log, makeClient, sendIxs } from "../keeper/common";
import { IS_LOCAL, ROOT, SUFFIX, createMandatedConfig, ensureAta, fund, helperKey, launchAndGraduate, mintTo, newMint, pairAtGraduatedPrice } from "./lib/launch";

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const launchpad = loadKeypair();
  if (IS_LOCAL) {
    const sig = await conn.requestAirdrop(launchpad.publicKey, 1_000 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  log("demo", `rpc=${RPC_URL} launchpad=${launchpad.publicKey.toBase58()}`);
  const client = makeClient(conn, launchpad);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");

  const creator = helperKey("creator");
  const buyer = helperKey("buyer");
  const maker = helperKey("maker");
  const trader = helperKey("trader");
  // Off localnet, fund just enough: the maker pays for its position and bin arrays.
  const sol = IS_LOCAL ? [20, 20, 20, 20] : [0.1, 0.05, 0.4, 0.1];
  for (const [i, k] of [creator, buyer, maker, trader].entries()) await fund(conn, launchpad, k.publicKey, sol[i]);

  const quote = await newMint(conn, launchpad, 6); // demo "USDC"
  await mintTo(conn, launchpad, quote, buyer.publicKey, 1_000_000n * 1_000_000n);
  await mintTo(conn, launchpad, quote, launchpad.publicKey, 1_000_000n * 1_000_000n);
  await mintTo(conn, launchpad, quote, maker.publicKey, 10_000n * 1_000_000n);
  await mintTo(conn, launchpad, quote, trader.publicKey, 100_000n * 1_000_000n);
  log("demo", `quote mint ${quote.toBase58()}`);

  // 1) Router + Mandated DBC config
  const router = pda.router(launchpad.publicKey);
  if (!(await conn.getAccountInfo(router))) await sendIxs(conn, launchpad, [await client.initRouter({ authority: launchpad.publicKey })]);
  const config = await createMandatedConfig(conn, dbc, launchpad, router, quote);
  log("demo", `DBC config ${config.toBase58()} (leftover_receiver = router ${router.toBase58()})`);

  // 2) Launch + graduate
  const { baseMint, dbcPool, dammPool } = await launchAndGraduate({
    conn, dbc, launchpad, creator, buyer, config, quote, router, name: "Mandated Demo", symbol: "MAND", uri: "https://mandate.example/mand.json",
  });
  log("demo", `token ${baseMint.toBase58()} graduated to DAMM v2 ${dammPool.toBase58()}`);

  // 3) DLMM pair at the graduated price
  const { lbPair, binStep, activeId } = await pairAtGraduatedPrice(conn, launchpad, baseMint, quote, dammPool);
  log("demo", `DLMM pair ${lbPair.toBase58()} bin step ${binStep}, active bin ${activeId}`);

  // 4) Mandates
  await ensureAta(conn, launchpad, baseMint, launchpad.publicKey);
  const terms: MandateTerms = {
    feePerPeriod: new BN(1_000_000), periodSecs: 120, durationPeriods: 720, bondAmount: new BN(250_000_000),
    maxSpreadBps: 100, minDepthQuote: new BN(500_000_000), depthWindowBps: 200, bandBps: 500,
    anchorTwapSecs: 120, anchorSpeedBpsPerMin: 200, liquidityLockSecs: 20, maxConsecutiveFailures: 5, slashBps: 5_000,
  };
  const mandate = pda.mandate(launchpad.publicKey, baseMint, 1);
  await sendIxs(conn, launchpad, [
    await client.createMandate({ issuer: launchpad.publicKey, baseMint: baseMint, quoteMint: quote, lbPair, referencePool: dammPool, id: 1, terms, baseDeposit: new BN(0), quoteDeposit: new BN(5_000_000_000), feeBudget: new BN(720_000_000) }),
    await client.registerLaunch({ authority: launchpad.publicKey, baseMint: baseMint, mandate }),
  ]);
  const m0 = client.decodeMandate((await conn.getAccountInfo(mandate))!.data);
  await sendIxs(conn, launchpad, [await client.routeLeftover({ routerAuthority: launchpad.publicKey, mandate, m: m0 })]);
  const makerClient = makeClient(conn, maker);
  const m1 = client.decodeMandate((await conn.getAccountInfo(mandate))!.data);
  await sendIxs(conn, maker, [await makerClient.accept({ maker: maker.publicKey, mandate, m: m1 })]);
  log("demo", `mandate ${mandate.toBase58()} funded from DBC leftover and accepted by ${maker.publicKey.toBase58()}`);

  const openMandate = pda.mandate(launchpad.publicKey, baseMint, 2);
  await sendIxs(conn, launchpad, [
    await client.createMandate({ issuer: launchpad.publicKey, baseMint: baseMint, quoteMint: quote, lbPair, referencePool: dammPool, id: 2, terms: { ...terms, bondAmount: new BN(500_000_000), feePerPeriod: new BN(2_000_000) }, baseDeposit: new BN(0), quoteDeposit: new BN(2_000_000_000), feeBudget: new BN(1_440_000_000) }),
  ]);

  const out = {
    cluster: RPC_URL,
    launchpad: launchpad.publicKey.toBase58(),
    router: router.toBase58(),
    dbcConfig: config.toBase58(),
    dbcPool: dbcPool.toBase58(),
    baseMint: baseMint.toBase58(),
    quoteMint: quote.toBase58(),
    dammPool: dammPool.toBase58(),
    lbPair: lbPair.toBase58(),
    mandates: [mandate.toBase58(), openMandate.toBase58()],
    maker: maker.publicKey.toBase58(),
    trader: trader.publicKey.toBase58(),
  };
  const outPath = path.join(ROOT, `app/public/demo${SUFFIX}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  log("demo", `wrote ${outPath}`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
