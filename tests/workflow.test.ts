/**
 * The agreement workflow's pure logic: replaying observations against terms, readiness,
 * what-ifs, suggestions, link packing, and shared drafts with signed approvals.
 */
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  approvalMessage,
  approvalState,
  base58Encode,
  diffTerms,
  economics,
  evaluate,
  forecastMoves,
  newDraft,
  packLink,
  priceQ64,
  propose,
  shareable,
  suggestTerms,
  termsHash,
  unpackLink,
  verifyApproval,
  type Approval,
  type DraftDoc,
  type DraftTerms,
  type Sample,
  type Session,
  applyProposals,
  gapsOf,
  incidentsOf,
  proposeChanges,
  type LogPeriod,
} from "../sdk/src";

const STEP = 10;
const T0 = 1_800_000_000;

/** A book around `ref`: `bid` quote atoms per bid bin (ref and 5 below), `askBase` base atoms per ask bin (5 above). */
function sample(at: number, ref: number | undefined, bid: bigint, askBase: bigint, extra: Partial<Sample> = {}): Sample {
  const bins: Sample["bins"] = [];
  const r = ref ?? 0;
  for (let b = r - 5; b <= r; b++) bins.push([b, bid.toString(), "0", bid.toString()]);
  for (let b = r + 1; b <= r + 5; b++) {
    const v = (askBase * priceQ64(b, STEP)!) >> 64n;
    bins.push([b, v.toString(), askBase.toString(), "0"]);
  }
  return { at, slot: 1, reference: ref === undefined ? { state: "warming" } : { state: "ready", bin: ref }, activeBin: r, positions: ["P"], bins, unknownBins: [], ...extra };
}

function session(samples: Sample[]): Session {
  return {
    kind: "mandate-observation", version: 1, id: "s", cluster: "devnet", pair: "PAIR", owner: "OWNER", position: null,
    startedAt: T0, periodSecs: 60, checksPerPeriod: 3, twapSecs: 60,
    pairFacts: { binStep: STEP, baseMint: "B", quoteMint: "Q", baseDecimals: 6, quoteDecimals: 6, oracle: "O" },
    oracle: [], oracleSince: T0, samples,
  };
}

const U = 1_000_000n; // one quote unit in atoms
const TERMS = { minDepth: 500, depthWindowBps: 50, maxSpreadBps: 30 };

describe("observation replay (report.ts)", () => {
  // 20 one-minute periods: 0-11 healthy, 12-13 bids thin, 14 unobserved, 15-19 healthy; the
  // first sample has no reference yet.
  const samples: Sample[] = [sample(T0 + 5, undefined, 200n * U, 200n * U)];
  for (let p = 0; p < 20; p++) {
    if (p === 14) continue;
    const thin = p === 12 || p === 13;
    samples.push(sample(T0 + p * 60 + 20, 0, (thin ? 50n : 200n) * U, 200n * U));
  }
  const s = session(samples);
  const e = evaluate(s, TERMS, { until: T0 + 20 * 60, tradeSizes: [1_000, 5_000] });

  it("scores each period from the exact per-bin values", () => {
    const code = { met: "m", missed: "x", unknown: "?", unobserved: "-" } as const;
    expect(e.periods.map((p) => code[p.verdict]).join("")).to.eq("?" + "m".repeat(11) + "xx" + "-" + "m".repeat(5));
    expect(e.summary).to.include({ met: 16, missed: 2, unknown: 1, unobserved: 1, decided: 18, longestMissRun: 2 });
    expect(e.failures).to.deep.eq({ bids: 2, asks: 0, spread: 0 });
  });

  it("counts a sample without a reference as missing evidence, not a miss", () => {
    const first = e.periods[0].checks[0];
    expect(first.result).to.eq("unknown");
    expect(e.periods[0].verdict).to.eq("unknown", "one unknown check in a period with no miss");
    expect(e.readiness.missing.join(" ")).to.contain("before the reference price had a full");
  });

  it("is ready once enough periods are decided, and says what is missing", () => {
    expect(e.readiness.ready).to.eq(true);
    expect(e.readiness.missing.join(" ")).to.contain("1 period without any sample");
    const early = evaluate(session(samples.slice(0, 4)), TERMS, { until: T0 + 3 * 60 });
    expect(early.readiness.ready).to.eq(false);
    expect(early.readiness.needs[0]).to.match(/more periods? with a usable check/);
    expect(early.readiness.progress).to.be.within(0, 0.5);
  });

  it("estimates execution at each size, separately from compliance", () => {
    const [small, big] = e.execution;
    expect(small.samples).to.eq(19);
    expect(small.unfilled).to.eq(2, "the two thin-bid samples can't fill a 1,000 sell");
    expect(big.unfilled).to.eq(19, "the book can't absorb 5,000 at all");
  });

  it("replays other terms on the same observations", () => {
    const loose = evaluate(s, { ...TERMS, minDepth: 40 }, { until: T0 + 20 * 60 });
    expect(loose.summary.missed).to.eq(0);
    const strict = evaluate(s, { ...TERMS, minDepth: 5_000 }, { until: T0 + 20 * 60 });
    expect(strict.summary.met).to.eq(0);
  });

  it("forecasts reference moves on the latest book, labelled by speed", () => {
    const f = forecastMoves(s, TERMS, 1, [1, -3]);
    expect(f.basedOn).to.eq(samples[samples.length - 1].at);
    const up = f.rows.find((r) => r.movePct === 1)!;
    expect(up.bins).to.eq(10);
    expect(up.passes).to.eq(false, "a 1% move leaves the 50 bps window with no asks");
    expect(up.minutesAtSpeedLimit).to.eq(1);
    expect(f.rows.find((r) => r.movePct === -3)!.minutesAtSpeedLimit).to.eq(3);
  });

  it("suggests terms the observed book met most of the time", () => {
    const sug = suggestTerms(s, 50)!;
    expect(sug.terms.minDepth).to.be.gt(0).and.lte(1_000);
    expect(sug.terms.maxSpreadBps % STEP).to.eq(0);
    expect(sug.basis).to.contain("measured samples");
  });

  it("packs a shareable report into a link and back", async () => {
    const r = shareable(s, e);
    const packed = await packLink(r);
    expect(packed).to.match(/^[A-Za-z0-9_-]+$/);
    expect(packed.length).to.be.lt(2_500);
    const back = await unpackLink<typeof r>(packed);
    expect(back.periods).to.eq(r.periods);
    expect(back.summary).to.deep.eq(r.summary);
  });
});

describe("shared drafts (draft.ts)", () => {
  const market = { cluster: "devnet", baseMint: "B".repeat(32), quoteMint: "Q".repeat(32), lbPair: "L".repeat(32), referencePool: "R".repeat(32) };
  const terms: DraftTerms = {
    feePerPeriod: "1", periodMinutes: "60", durationPeriods: "720", bond: "250", maxSpreadBps: "100", minDepth: "500", depthWindowBps: "200", bandBps: "500",
    twapMinutes: "5", speedPctPerMin: "1", liquidityLockSecs: "30", maxConsecutiveFailures: "3", slashPct: "50", baseDeposit: "0", quoteDeposit: "5000",
  };
  const team = Keypair.generate();
  const operator = Keypair.generate();
  const sign = async (doc: DraftDoc, kp: Keypair, party: "team" | "operator"): Promise<Approval> => {
    const n = doc.versions[doc.versions.length - 1].n;
    const hash = await termsHash(doc, n);
    const sig = ed25519.sign(approvalMessage(hash, party), kp.secretKey.slice(0, 32));
    return { n, party, signer: kp.publicKey.toBase58(), hash, sig: base58Encode(sig) };
  };

  it("hashes the terms canonically: formatting doesn't matter, values do", async () => {
    const d = newDraft(market, terms, "team", { team: team.publicKey.toBase58(), operator: operator.publicKey.toBase58() });
    const same = { ...d, versions: [{ ...d.versions[0], terms: { ...terms, bond: "250.0" } }] };
    const other = { ...d, versions: [{ ...d.versions[0], terms: { ...terms, bond: "300" } }] };
    expect(await termsHash(same, 1)).to.eq(await termsHash(d, 1));
    expect(await termsHash(other, 1)).to.not.eq(await termsHash(d, 1));
    expect(await termsHash({ ...d, operator: Keypair.generate().publicKey.toBase58() }, 1)).to.not.eq(await termsHash(d, 1), "the parties are part of what is signed");
    // A renewal with identical terms is a different thing to approve: no replaying old approvals.
    expect(await termsHash({ ...d, id: "other-draft" }, 1)).to.not.eq(await termsHash(d, 1));
    expect(await termsHash({ ...d, renews: "SomeAgreement" }, 1)).to.not.eq(await termsHash(d, 1));
  });

  it("lists what a proposal changed, grouped", () => {
    const changes = diffTerms(terms, { ...terms, bond: "400", maxConsecutiveFailures: "5", speedPctPerMin: "2" });
    expect(changes.map((c) => [c.group, c.from, c.to])).to.deep.eq([
      ["Bond and penalty", "250", "400"],
      ["Reference behaviour", "1", "2"],
      ["Failure conditions", "3", "5"],
    ]);
  });

  it("counts as agreed only when both named wallets signed the latest version", async () => {
    let d = newDraft(market, terms, "team", { team: team.publicKey.toBase58(), operator: operator.publicKey.toBase58() });
    d.approvals.push(await sign(d, team, "team"));
    expect((await approvalState(d)).agreed).to.eq(false);
    d.approvals.push(await sign(d, operator, "operator"));
    const st = await approvalState(d);
    expect(st.agreed).to.eq(true);
    expect(await verifyApproval(st.team!)).to.eq(true);

    // A counter-proposal: earlier approvals stay on record but no longer count.
    d = propose(d, { ...terms, bond: "200" }, "operator", "Bond too high for a 30-day term");
    const after = await approvalState(d);
    expect(after.agreed).to.eq(false);
    expect(after.stale).to.have.length(2);
  });

  it("rejects a forged signature or a signature from the wrong wallet", async () => {
    const d = newDraft(market, terms, "team", { team: team.publicKey.toBase58(), operator: operator.publicKey.toBase58() });
    const stranger = Keypair.generate();
    const wrong = { ...(await sign(d, stranger, "operator")) };
    const forged = { ...(await sign(d, operator, "operator")), sig: base58Encode(new Uint8Array(64).fill(7)) };
    d.approvals.push(await sign(d, team, "team"), wrong, forged);
    const st = await approvalState(d);
    expect(st.operator).to.eq(null);
    expect(st.agreed).to.eq(false);
    expect(await verifyApproval(forged)).to.eq(false);
  });

  it("sets out what each side commits", () => {
    const e = economics(terms);
    expect(e).to.include({ feeBudget: 720, teamQuote: 5_720, bond: 250, termHours: 720, slashAmount: 125, periods: 720 });
    expect(e.returnOnBond).to.be.closeTo(2.88, 1e-9);
  });
});

describe("renewal report reasoning (renewal.ts)", () => {
  const terms: DraftTerms = {
    feePerPeriod: "1", periodMinutes: "60", durationPeriods: "720", bond: "250", maxSpreadBps: "100", minDepth: "500", depthWindowBps: "200", bandBps: "500",
    twapMinutes: "5", speedPctPerMin: "1", liquidityLockSecs: "30", maxConsecutiveFailures: "3", slashPct: "50", baseDeposit: "1000000", quoteDeposit: "5000",
  };
  const p = (period: number, status: number, minBid = 2_000, minAsk = 2_000, worst = 20): LogPeriod => ({ period, status, snapshots: status === 3 ? 0 : 3, minBid, minAsk, worstSpreadBps: worst });

  it("finds incidents with their causes and recovery time, and gaps in observation", () => {
    const log = [p(0, 1), p(1, 2, 2_000, 300), p(2, 2, 2_000, 100, 65535), p(3, 1), p(4, 3), p(5, 3), p(6, 1), p(7, 2, 100, 2_000)];
    const inc = incidentsOf(log, 3600, 500, 100);
    expect(inc).to.have.length(2);
    expect(inc[0]).to.deep.include({ from: 1, to: 2, periods: 2, durationSecs: 7200, recoveredAfterSecs: 7200 });
    expect(inc[0].causes).to.deep.eq(["asks", "empty side"]);
    expect(inc[1].recoveredAfterSecs).to.eq(null, "still failing at the end of the log");
    expect(gapsOf(log)).to.deep.eq([{ from: 4, to: 5, periods: 2 }]);
  });

  it("proposes changes tied to the evidence", () => {
    const log = [p(0, 1), p(1, 2, 2_000, 300), p(2, 2, 2_000, 200), p(3, 2, 2_000, 100), ...Array.from({ length: 4 }, (_, i) => p(4 + i, 3))];
    const props = proposeChanges({ terms, log, counters: { ok: 1, failed: 3, unobserved: 4 }, breached: true, quote: "USDC" });
    const ids = props.map((x) => x.id);
    expect(ids).to.include.members(["monitoring", "asks-inventory", "failures"]);
    expect(props.find((x) => x.id === "asks-inventory")!.change).to.deep.eq({ baseDeposit: "2000000" });
    const next = applyProposals(terms, props.filter((x) => x.id !== "monitoring"));
    expect(next).to.include({ baseDeposit: "2000000", maxConsecutiveFailures: "5", bond: "375" });
  });

  it("proposes the delivered depth when a clean term over-delivered, and nothing else", () => {
    const log = Array.from({ length: 24 }, (_, i) => p(i, 1, 3_000, 2_600));
    const props = proposeChanges({ terms, log, counters: { ok: 24, failed: 0, unobserved: 0 }, breached: false, quote: "USDC" });
    expect(props.map((x) => x.id)).to.deep.eq(["tighten"]);
    expect(props[0].change).to.deep.eq({ minDepth: "2000" });
  });
});
