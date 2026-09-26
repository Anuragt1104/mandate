/**
 * Regression tests for the off-chain findings of docs/reviews/2026-09-26-system-review.md.
 * Mocked transports only: nothing here contacts an RPC or a model API. The one credential
 * that appears is the literal REVIEW_DUMMY.
 */
import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createDlmmPair, createMint, fundedKeypair, mandateProgram, mintTo, ONE_Q64, send, startSvm, warp, writeReferencePool } from "./helpers";
import { MandateClient, MEMO_PROGRAM_ID, loadAccounts, pda, type MandateTerms } from "../sdk/src";
import { decodeSentinelMemo, encodeSentinelMemo, readStanding, sentinelReadsFromTx, SENTINEL_POLICY, type PublishedRead } from "../sdk/src/sentinel";
import { decide, SystemOneError } from "../sdk/src/systemone";
import { failoverFetch, redact } from "../sdk/src/rpc";
import { ModelWorker, Watchtower } from "../keeper/watchtower";
import { KeeperStore } from "../keeper/store";
import { assessWithRules, describe as describeState, type Observation } from "../keeper/sentinel";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const U = (x: number) => new BN(Math.round(x * 1e6));

describe("RPC transport and proxy (R2, R8)", () => {
  it("failover errors never carry an endpoint's key", async () => {
    globalThis.fetch = async () => new Response("", { status: 503 });
    const f = failoverFetch(["https://rpc.invalid/v2/PATHKEY?api-key=REVIEW_DUMMY"], { rounds: 1, timeoutMs: 500, hedgeMs: 100 });
    let message = "";
    await f("", { body: '{"method":"getSlot"}' }).catch((e) => (message = String(e?.message ?? e)));
    expect(message).to.contain("rpc.invalid");
    expect(message).to.not.contain("REVIEW_DUMMY");
    expect(message).to.not.contain("PATHKEY");
  });

  it("redact() strips query, path and userinfo from any URL in a message", () => {
    const out = redact("fetch https://u:p@host.invalid/k/SECRET?api-key=REVIEW_DUMMY failed; token=REVIEW_DUMMY");
    expect(out).to.eq("fetch https://host.invalid failed; token=[redacted]");
  });

  describe("proxy", () => {
    let POST: (req: Request) => Promise<Response>;
    const req = (method: string, params: unknown[] = []) =>
      new Request("http://proxy.invalid/api/rpc", { method: "POST", headers: { "x-real-ip": `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });

    before(async () => {
      process.env.RPC_UPSTREAM = "https://rpc.invalid/?api-key=REVIEW_DUMMY";
      process.env.RPC_UPSTREAM_FALLBACKS = "";
      ({ POST } = await import("../app/src/app/api/rpc/route"));
    });

    it("does not cache a null getTransaction (not available yet)", async () => {
      let calls = 0;
      globalThis.fetch = async () => (calls++, Response.json({ jsonrpc: "2.0", id: 1, result: null }));
      await POST(req("getTransaction", ["SIG_A"]));
      globalThis.fetch = async () => (calls++, Response.json({ jsonrpc: "2.0", id: 1, result: { slot: 99 } }));
      const second = await POST(req("getTransaction", ["SIG_A"]));
      expect(((await second.json()) as any).result).to.deep.eq({ slot: 99 });
      expect(calls).to.eq(2);
    });

    it("answers upstream failures with a correlation id, not the upstream's details", async () => {
      globalThis.fetch = async () => new Response("", { status: 503 });
      const res = await POST(req("getSlot"));
      const text = await res.text();
      expect(res.status).to.eq(502);
      expect(text).to.not.contain("REVIEW_DUMMY");
      expect(text).to.not.contain("rpc.invalid");
      expect(text).to.match(/ref [0-9a-f]{8}/);
    });

    it("refuses calls over the cost bounds", async () => {
      const keys = Array.from({ length: 101 }, () => Keypair.generate().publicKey.toBase58());
      const body: any = await (await POST(req("getMultipleAccounts", [keys]))).json();
      expect(body.error.message).to.contain("100 accounts");
      const page: any = await (await POST(req("getSignaturesForAddress", ["x", { limit: 1000 }]))).json();
      expect(page.error.message).to.contain("100 signatures");
    });
  });
});

describe("System One answers are validated (R10)", () => {
  const ask = { p: { type: "noul" as const, instructions: "?" }, c: { type: "choice" as const, instructions: "?", criteria: { a: "A", b: "B" } } };
  const reply = (answers: unknown, model = "jev-1.13.0") => (globalThis.fetch = async () => Response.json({ model, answers }));
  const good = { p: { type: "noul", noul: 0.3 }, c: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.8 } };

  it("accepts a well-formed answer and reports the provider's model id", async () => {
    reply(good);
    const r = await decide({ url: "https://model.invalid" }, {}, ask);
    expect(r.model).to.eq("jev-1.13.0");
    expect(r.answers.p.noul).to.eq(0.3);
  });

  for (const [name, bad] of [
    ["a probability outside [0, 1]", { ...good, p: { type: "noul", noul: 17 } }],
    ["a non-numeric probability", { ...good, p: { type: "noul", noul: "0.3" } }],
    ["a choice that isn't an option", { ...good, c: { ...good.c, choice: "z" } }],
    ["a distribution that doesn't sum to 1", { ...good, c: { ...good.c, probabilities: { a: 0.9, b: 0.9 } } }],
    ["a missing confidence", { ...good, c: { type: "choice", choice: "a", probabilities: { a: 1, b: 0 } } }],
    ["a missing answer", { p: good.p }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      reply(bad);
      let err: unknown;
      await decide({ url: "https://model.invalid" }, {}, ask).catch((e) => (err = e));
      expect(err).to.be.instanceOf(SystemOneError);
    });
  }
});

describe("sentinel reads are bound and attributed (R4)", () => {
  const read = (over: Partial<PublishedRead> = {}): PublishedRead => ({
    mandate: Keypair.generate().publicKey.toBase58(), observedTs: 1_000, assessedAt: 1_005, expiresAt: 1_065,
    diagnosis: "withdrew_liquidity", confidence: 0.85, risk: 0.9, breach: 0.7, noRedeploy: NaN, source: "jev-1.13.0+rules",
    policy: SENTINEL_POLICY, inputHash: "0123456789ab", ...over,
  });

  it("round-trips, and rejects the unbound format 1 and malformed memos", () => {
    const r = read();
    const back = decodeSentinelMemo(encodeSentinelMemo(r))!;
    expect(back.mandate).to.eq(r.mandate);
    expect(Number.isNaN(back.noRedeploy)).to.eq(true);
    expect(decodeSentinelMemo("mandate-sentinel/1 r=0.99 b=0.99 d=withdrew_liquidity c=0.99 x=0.99 m=jev-1.13.0+rules")).to.eq(null);
    expect(decodeSentinelMemo(encodeSentinelMemo(read({ expiresAt: 900 })))).to.eq(null);
  });

  it("takes the publisher from the signed transaction, and only trusts listed publishers", async () => {
    const svm = startSvm();
    const client = new MandateClient(mandateProgram());
    const issuer = fundedKeypair(svm), maker = fundedKeypair(svm), impostor = fundedKeypair(svm);
    const base = createMint(svm, issuer, 6), quote = createMint(svm, issuer, 6);
    mintTo(svm, issuer, base, issuer.publicKey, 10n ** 12n);
    mintTo(svm, issuer, quote, issuer.publicKey, 10n ** 12n);
    mintTo(svm, issuer, quote, maker.publicKey, 10n ** 12n);
    const pair = createDlmmPair(svm, issuer, base, quote, 25, 0);
    const ref = Keypair.generate().publicKey;
    writeReferencePool(svm, ref, base, quote, ONE_Q64);
    const terms: MandateTerms = { feePerPeriod: U(1), periodSecs: 60, durationPeriods: 10, bondAmount: U(10), maxSpreadBps: 100, minDepthQuote: U(100),
      depthWindowBps: 200, bandBps: 500, anchorTwapSecs: 300, anchorSpeedBpsPerMin: 100, liquidityLockSecs: 10, maxConsecutiveFailures: 3, slashBps: 10_000 };
    const key = pda.mandate(issuer.publicKey, base, 1);
    send(svm, issuer, [await client.createMandate({ issuer: issuer.publicKey, baseMint: base, quoteMint: quote, lbPair: pair.lbPair, referencePool: ref, id: 1, terms, baseDeposit: U(10), quoteDeposit: U(10), feeBudget: U(10) })]);
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: client.decodeMandate(svm.getAccount(key)!.data) })]);
    warp(svm, 61);
    // Anyone can attach a memo claiming Jev; it is attributed to whoever signed it.
    const memo = encodeSentinelMemo(read({ mandate: key.toBase58(), source: "jev-1.13.0+rules" }));
    const ixs = [
      await client.snapshot({ cranker: impostor.publicKey, mandate: key, m: client.decodeMandate(svm.getAccount(key)!.data) }),
      new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: impostor.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo) }),
    ];
    send(svm, impostor, ixs); // it lands: the memo program checked the signer
    // The web3.js shape the feed reads, from the same instructions.
    const t = new Transaction().add(...ixs);
    t.feePayer = impostor.publicKey;
    t.recentBlockhash = svm.latestBlockhash();
    const reads = sentinelReadsFromTx({ transaction: { signatures: ["S"], message: t.compileMessage() }, meta: { err: null } } as any);
    expect(reads).to.have.length(1);
    expect(reads[0].publisher).to.eq(impostor.publicKey.toBase58());
    const trusted = new Set([Keypair.generate().publicKey.toBase58()]);
    expect(readStanding(reads[0], { mandate: key.toBase58(), trusted, now: 1_010 })).to.eq("unverified");
    expect(readStanding(reads[0], { mandate: key.toBase58(), trusted: new Set([impostor.publicKey.toBase58()]), now: 1_010 })).to.eq("trusted");
    expect(readStanding(reads[0], { mandate: Keypair.generate().publicKey.toBase58(), trusted, now: 1_010 })).to.eq("mismatch");
    expect(readStanding(reads[0], { mandate: key.toBase58(), trusted, now: 2_000 })).to.eq("expired");
  });
});

describe("sentinel facts (R10)", () => {
  const obs = (over: Partial<Observation> = {}): Observation => ({
    pair: "T/USDC", quote: "USDC", terms: { minDepth: 100, windowPct: 2, maxSpreadBps: 100, periodSecs: 3600, maxFailures: 3, binStep: 10 },
    scoringAgoSecs: 540, checks: [{ agoSecs: 1, ok: false, bids: 0, asks: 0, spreadBps: null }], failedPeriodsInARow: 0,
    makerActivity: [], activityComplete: true, position: { open: false }, escrowIdleShare: 1, record: null, ...over,
  });

  it("uses the program's scoring start, not the period length, for the setup window", () => {
    expect(String(describeState(obs()).scoring)).to.contain("Scoring started 9 minutes ago");
    const r = assessWithRules(obs());
    expect(r.diagnosis).to.eq("not_started");
    expect(r.risk).to.be.gte(0.9, "after setup, an empty book fails every check");
    expect(String(describeState(obs({ scoringAgoSecs: -30 })).scoring)).to.contain("setup window");
    expect(assessWithRules(obs({ scoringAgoSecs: -30 })).risk).to.be.lt(0.5);
  });

  it("abstains on redeployment when the event history is incomplete", () => {
    const r = assessWithRules(obs({ activityComplete: false, makerActivity: [{ agoSecs: 30, action: "withdrew all of its liquidity back to escrow" }] }));
    expect(r.diagnosis).to.eq("withdrew_liquidity");
    expect(Number.isNaN(r.noRedeploy)).to.eq(true);
    expect(r.confidence).to.be.lte(0.6);
  });
});

describe("account reads respect the RPC limit (R5)", () => {
  function fakeConn(failChunk = -1) {
    const sizes: number[] = [];
    let n = 0;
    return {
      sizes,
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        sizes.push(keys.length);
        if (keys.length > 100) throw new Error("maximum 100 accounts");
        if (n++ === failChunk) throw new Error("chunk failed");
        return { context: { slot: 50 }, value: keys.map((k) => ({ data: Buffer.from(k.toBytes()), owner: k, lamports: 1, executable: false })) };
      },
    };
  }
  const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);

  for (const n of [0, 1, 33, 34, 100, 101, 250]) {
    it(`loads ${n} accounts in chunks of at most 100, in order`, async () => {
      const c = fakeConn();
      const ks = keys(n);
      const { infos } = await loadAccounts(c as any, ks);
      expect(Math.max(0, ...c.sizes)).to.be.lte(100);
      expect(infos).to.have.length(n);
      infos.forEach((info, i) => expect(Buffer.from(info!.data).equals(Buffer.from(ks[i].toBytes()))).to.eq(true));
    });
  }

  it("deduplicates keys and reports one failing chunk without losing the others", async () => {
    const c = fakeConn(1);
    const ks = keys(150);
    const { infos, failed } = await loadAccounts(c as any, [...ks, ...ks.slice(0, 20)], { partial: true, concurrency: 1 });
    expect(c.sizes.reduce((a, b) => a + b, 0)).to.eq(150);
    expect(failed.length).to.be.greaterThan(0);
    expect(infos.slice(0, 100).every(Boolean)).to.eq(true);
    expect(infos[120]).to.eq(undefined);
  });

  it("a watchtower tick with 101 active agreements never asks for more than 100 accounts", async () => {
    const client = new MandateClient(mandateProgram());
    const quoteMint = Keypair.generate().publicKey;
    const baseMint = Keypair.generate().publicKey;
    const sizes: number[] = [];
    const conn = {
      getSlot: async () => 1,
      getBlockTime: async () => 10_000,
      getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => {
        sizes.push(ks.length);
        if (ks.length > 100) throw new Error("maximum 100 accounts");
        const mint = Buffer.alloc(82);
        mint[44] = 6;
        return { context: { slot: 1 }, value: ks.map((k) => (k.equals(quoteMint) || k.equals(baseMint) ? { data: mint } : null)) };
      },
      getSignaturesForAddress: async () => [],
    };
    const wt = new Watchtower(conn as any, Keypair.generate(), client) as any;
    const mandate = (i: number) => ({
      pubkey: Keypair.generate().publicKey,
      m: {
        status: { active: {} }, maker: Keypair.generate().publicKey, lbPair: Keypair.generate().publicKey, baseMint, quoteMint,
        startTs: new BN(20_000), terms: { periodSecs: 60, durationPeriods: 10, minDepthQuote: U(100), depthWindowBps: 200, maxSpreadBps: 100, maxConsecutiveFailures: 3 },
        currentPeriod: 0, curSnapshots: 0, consecutiveFailed: 0, position: PublicKey.default, positionLowerBinId: 0, positionWidth: 0, anchor: { bin: i },
        last: { ts: new BN(0) },
      },
    });
    wt.mandates = async () => Array.from({ length: 101 }, (_, i) => mandate(i));
    await wt.tick();
    expect(Math.max(...sizes)).to.be.lte(100);
    expect(wt.readAt.size).to.eq(101, "every agreement progressed");
  });
});

describe("activity ingestion (R8, R9)", () => {
  const client = new MandateClient(mandateProgram());
  const mandateA = Keypair.generate().publicKey;
  const mandateB = Keypair.generate().publicKey;
  const quoteMint = Keypair.generate().publicKey;
  const m = { quoteMint, baseMint: quoteMint, terms: { periodSecs: 60 } };

  function watch(conn: any) {
    const wt = new Watchtower(conn, Keypair.generate(), client) as any;
    wt.decimals.set(quoteMint.toBase58(), 6);
    return wt;
  }
  const tx = { blockTime: 100, meta: { err: null, logMessages: ["x"] } };

  it("ignores events about another mandate in the same transaction", async () => {
    const wt = watch({ getSignaturesForAddress: async () => [{ signature: "S1", err: null, blockTime: 100 }], getTransaction: async () => tx });
    wt.parser = { *parseLogs() { yield { name: "liquidityWithdrawn", data: { mandate: mandateB, bps: 10_000 } }; yield { name: "liquidityWithdrawn", data: { mandate: mandateA, bps: 5_000 } }; } };
    const rec = wt.store.get(mandateA.toBase58());
    await wt.readActivity(mandateA, m, rec, 200);
    expect(rec.activity.map((a: any) => a.action)).to.deep.eq(["withdrew 50% of its liquidity back to escrow"]);
  });

  it("keeps a transaction that isn't available yet, marks history incomplete, and picks it up later", async () => {
    let available = false;
    const conn = { getSignaturesForAddress: async (_: any, o: any) => (o.until ? [] : [{ signature: "S2", err: null, blockTime: 100 }]), getTransaction: async () => (available ? tx : null) };
    const wt = watch(conn);
    wt.parser = { *parseLogs() { yield { name: "liquidityWithdrawn", data: { mandate: mandateA, bps: 10_000 } }; } };
    const rec = wt.store.get(mandateA.toBase58());
    await wt.readActivity(mandateA, m, rec, 200);
    expect(rec.unresolved.map((u: any) => u.sig)).to.deep.eq(["S2"]);
    expect(rec.activity).to.have.length(0);
    available = true;
    await wt.readActivity(mandateA, m, rec, 210);
    expect(rec.unresolved).to.have.length(0);
    expect(rec.activity).to.have.length(1);
  });

  it("pages back to the saved cursor instead of dropping the middle", async () => {
    const sigs = Array.from({ length: 230 }, (_, i) => ({ signature: `N${229 - i}`, err: null, blockTime: 1_000 - i }));
    const conn = {
      getSignaturesForAddress: async (_: any, o: any) => {
        const from = o.before ? sigs.findIndex((s) => s.signature === o.before) + 1 : 0;
        const stop = o.until ? sigs.findIndex((s) => s.signature === o.until) : sigs.length;
        return sigs.slice(from, Math.min(stop, from + o.limit));
      },
      getTransaction: async () => tx,
    };
    const wt = watch(conn);
    wt.parser = { *parseLogs() {} };
    const rec = wt.store.get(mandateA.toBase58());
    rec.cursor = "N0"; // everything newer than the oldest one is new
    let fetched = 0;
    conn.getTransaction = async () => (fetched++, tx);
    await wt.readActivity(mandateA, m, rec, 2_000);
    expect(fetched).to.eq(229);
    expect(rec.cursor).to.eq("N229");
  });
});

describe("the model never delays a check (R6, R10)", () => {
  it("a hung model times out in its own queue and trips the breaker", async () => {
    globalThis.fetch = (_: any, init: any) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const store = new KeeperStore(null);
    const worker = new ModelWorker({ url: "https://model.invalid" }, store, { timeoutMs: 100, trip: 3, coolMs: 60_000 });
    const obs = { pair: "T/U", quote: "U", terms: { minDepth: 1, windowPct: 2, maxSpreadBps: 100, periodSecs: 60, maxFailures: 3 }, scoringAgoSecs: 100, checks: [], failedPeriodsInARow: 0, makerActivity: [], activityComplete: true, position: { open: false }, escrowIdleShare: 1, record: null };
    const started = Date.now();
    for (let i = 0; i < 3; i++) worker.submit({ key: `k${i}`, obs: obs as any, observedTs: 1, hash: `h${i}`, periodSecs: 60 });
    expect(Date.now() - started).to.be.lt(20, "submit doesn't wait for the model");
    await worker.idle(2_000);
    expect(worker.stats.failed).to.eq(3);
    expect(worker.open).to.eq(true);
    worker.submit({ key: "k9", obs: obs as any, observedTs: 1, hash: "h9", periodSecs: 60 });
    expect(worker.stats.skippedOpen).to.eq(1);
  });

  it("publishes a model read only for the exact observation it assessed, and only until it expires", async () => {
    const client = new MandateClient(mandateProgram());
    const wt = new Watchtower({} as any, Keypair.generate(), client) as any;
    const key = Keypair.generate().publicKey.toBase58();
    const rec = wt.store.get(key);
    const x = { key, m: { last: { ts: new BN(1_000) }, startTs: new BN(0), terms: { periodSecs: 60 } } };
    const o: Observation = { pair: "T/U", quote: "U", terms: { minDepth: 100, windowPct: 2, maxSpreadBps: 100, periodSecs: 60, maxFailures: 3 }, scoringAgoSecs: 900, checks: [{ agoSecs: 5, ok: false, bids: 0, asks: 0, spreadBps: null }], failedPeriodsInARow: 1, makerActivity: [{ agoSecs: 10, action: "withdrew all of its liquidity back to escrow" }], activityComplete: true, position: { open: false }, escrowIdleShare: 1, record: null };
    const hash = (await wt.readFor(x, rec, o, 1_010)).read.inputHash;
    rec.model = { observedTs: 1_000, inputHash: hash, assessedAt: 1_002, expiresAt: 1_062, a: { breach: 0.66, diagnosis: "withdrew_liquidity", confidence: 0.9, noRedeploy: 0.7, source: "jev-1.13.0", latencyMs: 5 } };
    const fresh = await wt.readFor(x, rec, o, 1_010);
    expect(fresh.read.source).to.eq("jev-1.13.0+rules");
    expect(fresh.read.assessedAt).to.eq(1_002);
    // An older observation's read is not republished against a newer check.
    const newer = { ...x, m: { ...x.m, last: { ts: new BN(1_030) } } };
    expect((await wt.readFor(newer, rec, o, 1_035)).read.source).to.eq("rules");
    // Nor after it expires.
    expect((await wt.readFor(x, rec, o, 1_100)).read.source).to.eq("rules");
  });
});

describe("transaction delivery never re-signs blindly", () => {
  const { sendAndConfirm, UnknownOutcome } = require("../keeper/common");
  const { Transaction, SystemProgram } = require("@solana/web3.js");
  function conn(o: { historyStatus: any }) {
    const sent: string[] = [];
    return {
      sent,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      sendRawTransaction: async (raw: Buffer) => (sent.push(raw.toString("base64")), "sig"),
      getSignatureStatuses: async (_: string[], cfg?: any) => ({ value: [cfg?.searchTransactionHistory ? o.historyStatus : null] }),
      getBlockHeight: async () => 101, // already past the blockhash's validity
    };
  }
  const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
  const payer = Keypair.generate();

  it("finds a transaction that landed after its blockhash expired, instead of sending it again", async () => {
    const c = conn({ historyStatus: { confirmationStatus: "confirmed", err: null } });
    const sig = await sendAndConfirm(c as any, tx(), [payer]);
    expect(sig).to.be.a("string");
    expect(c.sent).to.have.length(1);
  }).timeout(20_000);

  it("reports an unknown outcome for a non-idempotent transaction rather than rebuilding it", async () => {
    const c = conn({ historyStatus: null });
    let err: unknown;
    await sendAndConfirm(c as any, tx(), [payer]).catch((e: unknown) => (err = e));
    expect(err).to.be.instanceOf(UnknownOutcome);
    expect(new Set(c.sent).size).to.eq(1, "only ever the same signed bytes");
  }).timeout(20_000);
});
