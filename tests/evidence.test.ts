import { expect } from "chai";
import { readFileSync } from "fs";
import path from "path";
import { explainPeriod, judgeCheck, verifyEvidence, type EvidenceBundle } from "../sdk/src/evidence";

/**
 * "Why was this operator paid?" on real devnet evidence: KITE (simulated participants), period 1
 * (met, paid at settlement) and period 24 (the third failure in a row, which breached and slashed).
 */
const load = (f: string): EvidenceBundle => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", f), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("period evidence", () => {
  const met = load("evidence-kite-p1.json");
  const breach = load("evidence-kite-p24.json");

  it("recomputes a met period and its fee, and agrees with the program", () => {
    const r = verifyEvidence(met);
    expect(r.ok).to.equal(true);
    expect(r.explanation.status).to.equal(1);
    expect(r.explanation.complete).to.equal(true);
    expect(r.explanation.fee.toString()).to.equal(met.terms.feePerPeriod);
    expect(met.payout?.kind).to.equal("settlement");
  });

  it("recomputes the breaching failure: which condition failed, the count and the slash", () => {
    const r = verifyEvidence(breach);
    expect(r.ok).to.equal(true);
    const x = r.explanation;
    expect(x.status).to.equal(2);
    expect(x.verdicts.every((v) => !v.bids && v.asks && v.spread)).to.equal(true);
    expect(x.consecutiveFailed).to.equal(3);
    expect(x.breach?.reached).to.equal(true);
    expect(x.breach?.slash.toString()).to.equal(breach.slash?.amount);
  });

  it("flags a bundle whose measurement was edited", () => {
    const b = clone(breach);
    b.checks[0].bidDepthQuote = "500000000";
    const r = verifyEvidence(b);
    expect(r.ok).to.equal(false);
    expect(r.results.find((x) => x.name.startsWith("Check at slot"))?.pass).to.equal(false);
  });

  it("can't tell a consistent forgery offline (that's what --recheck is for)", () => {
    const b = clone(breach);
    for (const c of b.checks) Object.assign(c, { bidDepthQuote: "500000000", ok: true });
    b.finalized = { ...b.finalized!, status: 1, feeAccrued: b.terms.feePerPeriod };
    b.slash = null;
    expect(verifyEvidence(b).ok).to.equal(true);
  });

  it("is undetermined, not 'met', when recorded checks are missing", () => {
    const b = clone(met);
    b.checks = b.checks.slice(1);
    const x = explainPeriod(b);
    expect(x.complete).to.equal(false);
    expect(x.status).to.equal(null);
    expect(verifyEvidence(b).ok).to.equal(false);
  });

  it("a single failed check decides 'failed' even with evidence missing", () => {
    const b = clone(breach);
    b.checks = b.checks.slice(0, 1);
    expect(explainPeriod(b).status).to.equal(2);
  });

  it("an empty side fails the spread condition", () => {
    const c = { ...met.checks[0], spreadBps: 65535 };
    expect(judgeCheck(c, met.terms).spread).to.equal(false);
  });

  it("counts consecutive failures across unchecked periods and stops at a met one", () => {
    const b = clone(breach);
    b.previous = [
      { period: 19, status: 1 },
      { period: 20, status: 2 },
      { period: 21, status: 3 },
      { period: 22, status: 2 },
    ];
    b.period = 23;
    expect(explainPeriod(b).consecutiveFailed).to.equal(3);
    b.previous = [{ period: 22, status: 2 }];
    const x = explainPeriod(b);
    expect(x.consecutiveKnown).to.equal(false);
  });
});
