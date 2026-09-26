/** Review-only probes of the behavior at e607bc4; assertions document defects, not desired behavior.
 * Run: npx tsx docs/reviews/robustness-probes.ts
 * Uses LiteSVM and mocked transports only; no live transactions or model API requests.
 */
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ata, createDlmmPair, createMint, fundedKeypair, mandateProgram, mintTo, ONE_Q64,
  send, sendExpectFail, startSvm, tokenBalance, warp, writeReferencePool } from "../../tests/helpers";
import { MandateClient, MandateTerms, MEMO_PROGRAM_ID, pda, statusName } from "../../sdk/src";
import { sentinelMemoFromLogs } from "../../sdk/src/sentinel";
import { decide } from "../../sdk/src/systemone";
import { failoverFetch } from "../../sdk/src/rpc";
import { Watchtower } from "../../keeper/watchtower";
import { describe, assessWithRules, type Observation } from "../../keeper/sentinel";

const results: { id: string; evidence: unknown }[] = [];
const record = (id: string, evidence: unknown) => results.push({ id, evidence });
const U = (x: number) => new BN(x * 1e6);

async function main() {
  const svm = startSvm();
  const client = new MandateClient(mandateProgram());
  const issuer = fundedKeypair(svm), maker = fundedKeypair(svm), cranker = fundedKeypair(svm);
  const base = createMint(svm, issuer, 6), quote = createMint(svm, issuer, 6);
  mintTo(svm, issuer, base, issuer.publicKey, 100000000000n);
  mintTo(svm, issuer, quote, issuer.publicKey, 100000000000n);
  mintTo(svm, issuer, quote, maker.publicKey, 100000000000n);
  const pair = createDlmmPair(svm, issuer, base, quote, 25, 0);
  const referencePool = Keypair.generate().publicKey;
  writeReferencePool(svm, referencePool, base, quote, ONE_Q64);
  const terms: MandateTerms = { feePerPeriod: U(2), periodSecs: 60, durationPeriods: 100,
    bondAmount: U(50), maxSpreadBps: 100, minDepthQuote: U(100), depthWindowBps: 200,
    bandBps: 500, anchorTwapSecs: 300, anchorSpeedBpsPerMin: 100, liquidityLockSecs: 30,
    maxConsecutiveFailures: 1, slashBps: 10000 };
  const load = (k: PublicKey) => client.decodeMandate(svm.getAccount(k)!.data);
  async function create(id: number, t = terms) {
    const key = pda.mandate(issuer.publicKey, base, id);
    send(svm, issuer, [await client.createMandate({ issuer: issuer.publicKey, baseMint: base,
      quoteMint: quote, lbPair: pair.lbPair, referencePool, id, terms: t,
      baseDeposit: U(1000), quoteDeposit: U(1000), feeBudget: U(0) })]);
    return key;
  }

  const key = await create(90001);
  send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: load(key) })]);
  record("unfunded-acceptance", { status: statusName(load(key).status), feeBalance: tokenBalance(svm, load(key).feeVault).toString(), promised: 200 });
  warp(svm, 61);
  send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: key, m: load(key) })]);
  const before = load(key).currentPeriod;
  warp(svm, 40 * 60);
  const logs = sendExpectFail(svm, cranker, [await client.finalize({ mandate: key, m: load(key) }), await client.finalize({ mandate: key, m: load(key) })]);
  assert(logs.some(l => l.includes("InvalidStatus")));
  assert.equal(load(key).currentPeriod, before);
  assert.equal(statusName(load(key).status), "Active");
  send(svm, cranker, [await client.finalize({ mandate: key, m: load(key) })]);
  assert.equal(statusName(load(key).status), "Breached");
  record("batched-finalize-rollback", { batchError: "InvalidStatus", batchPeriod: before, singleFinalize: "Breached" });

  const cancelled = await create(90002);
  send(svm, issuer, [await client.initRouter({ authority: issuer.publicKey })]);
  const router = pda.router(issuer.publicKey);
  send(svm, issuer, [await client.registerLaunch({ authority: issuer.publicKey, baseMint: base, mandate: cancelled })]);
  const routerAta = mintTo(svm, issuer, base, router, 1000000n);
  send(svm, issuer, [await client.cancel({ mandate: cancelled, m: load(cancelled) })]);
  const routeLogs = sendExpectFail(svm, cranker, [await client.routeLeftover({ routerAuthority: issuer.publicKey, mandate: cancelled, m: load(cancelled) })]);
  assert(routeLogs.some(l => l.includes("InvalidStatus")));
  assert.equal(tokenBalance(svm, routerAta), 1000000n);
  record("cancelled-route-stranding", { routerTokensRemaining: "1000000", error: "InvalidStatus" });

  const spoofKey = await create(90003);
  send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: spoofKey, m: load(spoofKey) })]);
  warp(svm, 61);
  const memo = 'mandate-sentinel/1 r=0.99 b=0.99 d=withdrew_liquidity c=0.99 x=0.99 m=jev-1.13.0+rules';
  const spoofTx = send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: spoofKey, m: load(spoofKey) }),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo) })]);
  const parsed = sentinelMemoFromLogs(spoofTx.logs());
  assert.equal(parsed?.source, "jev-1.13.0+rules");
  record("unauthenticated-jev-memo", { sourceAccepted: parsed?.source, modelWasCalled: false });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ model: "test", answers: { risk: { type: "noul", noul: 17 } } });
    const answer = await decide({ url: "https://mock.invalid" }, {}, { risk: { type: "noul", instructions: "test" } });
    assert.equal(answer.answers.risk.noul, 17);
    record("unvalidated-model-result", { acceptedProbability: 17 });
    globalThis.fetch = async () => new Response("", { status: 503 });
    try { await failoverFetch(["https://mock.invalid/?api-key=REVIEW_DUMMY"], { rounds: 1 })("", { body: '{"method":"getSlot"}' }); }
    catch (e) { assert(String(e).includes("REVIEW_DUMMY")); record("rpc-key-in-error", { dummyCredentialReflected: true }); }
  } finally { globalThis.fetch = originalFetch; }

  const o: Observation = { pair: "TOKEN/USDC", quote: "USDC", terms: { minDepth: 100, windowPct: 2, maxSpreadBps: 100, periodSecs: 3600, maxFailures: 3 },
    acceptedAgoSecs: 600, checks: [{ agoSecs: 1, ok: false, bids: 0, asks: 0, spreadBps: null }], failedPeriodsInARow: 0,
    makerActivity: [], position: { open: false }, escrowIdleShare: 1, record: null };
  assert(String(describe(o).maker_accepted).includes("still in its one-minute setup window"));
  assert.equal(assessWithRules(o).diagnosis, "not_started");
  record("wrong-setup-window", { ageSeconds: 600, actualGraceSeconds: 60, rules: assessWithRules(o).diagnosis });

  let queriedAccounts = 0;
  const fakeConn = { getSlot: async () => 1, getBlockTime: async () => 1800000000,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => { queriedAccounts = keys.length; if (keys.length > 100) throw Error("maximum 100 accounts"); return []; } };
  const wt = new Watchtower(fakeConn as any, cranker, client) as any;
  wt.mandates = async () => Array.from({ length: 34 }, () => ({ pubkey: spoofKey, m: load(spoofKey) }));
  await assert.rejects(() => wt.tick(), /maximum 100/);
  record("watchtower-account-limit", { activeMandates: 34, attemptedAccounts: queriedAccounts });

  const cached = { checks: [], events: { seen: new Set(), activity: [], readAt: 0 },
    model: { at: 0, diagnosis: "quoting_normally", a: { risk: .05, breach: .01, exit: .01, diagnosis: "quoting_normally", confidence: .9, source: "jev-test", latencyMs: 1 } } };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("offline"); };
  try {
    const modelWatch = new Watchtower(fakeConn as any, cranker, client, { sentinel: { url: "https://mock.invalid" } }) as any;
    const stale = await modelWatch.judge(cached, { ...o, acceptedAgoSecs: 100000, makerActivity: [{ agoSecs: 1, action: "withdrew all liquidity" }] }, 100000);
    assert.equal(stale.breach, .01);
    assert.equal(stale.diagnosis, "withdrew_liquidity");
    record("stale-model-republished", { modelAgeSeconds: 100000, diagnosis: stale.diagnosis, breach: stale.breach, source: stale.source });
  } finally { globalThis.fetch = oldFetch; }

  const activityConn = {
    getSignaturesForAddress: async () => [{ signature: "mock-signature", err: null, blockTime: 100 }],
    getTransaction: async () => ({ blockTime: 100, meta: { logMessages: [] }, transaction: {
      message: { getAccountKeys: () => ({ get: () => maker.publicKey }) } } }),
  };
  const activityWatch = new Watchtower(activityConn as any, cranker, client) as any;
  activityWatch.parser = { *parseLogs() { yield { name: "liquidityWithdrawn", data: { mandate: cancelled, bps: 10000 } }; } };
  const activityState = { checks: [], events: { seen: new Set(), activity: [] as any[], readAt: 0 } };
  await activityWatch.readActivity(spoofKey, load(spoofKey), activityState);
  assert.equal(activityState.events.activity.length, 1);
  record("cross-mandate-activity", { requestedMandate: "A", eventMandate: "B", attributedToA: true });

  const nullState = { checks: [], events: { seen: new Set(), activity: [] as any[], readAt: 0, newest: undefined as string | undefined } };
  activityConn.getTransaction = async () => null as any;
  await activityWatch.readActivity(spoofKey, load(spoofKey), nullState);
  assert(nullState.events.seen.has("mock-signature"));
  assert.equal(nullState.events.newest, "mock-signature");
  record("null-transaction-skipped", { markedSeen: true, cursorAdvanced: true });
  console.log(JSON.stringify({ reviewedCommit: "e607bc4", probes: results }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
