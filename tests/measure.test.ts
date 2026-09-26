import { expect } from "chai";
import { executable, measureCommitted, priceQ64, type Bin, type RawBin } from "../sdk/src/measure";

/**
 * Shared fixtures with programs/mandate/src/scoring.rs `fixtures_match_the_sdk`: both sides
 * assert the same exact numbers, so the SDK and the program can't drift apart silently.
 */
const STEP = 25;
const TERMS = { minDepthQuote: 1_000n, depthWindowBps: 200, maxSpreadBps: 100 };

/** Bins -5..=6 around bin 0: 2_000 quote atoms in each bid bin, 2_000 base atoms in each ask bin, fully owned. */
function arrays(): Map<number, RawBin[]> {
  const a = new Map<number, RawBin[]>([[0, []], [-1, []]]);
  for (let i = 0; i < 70; i++) a.get(0)!.push({ amountX: 0n, amountY: 0n, liquiditySupply: 0n }), a.get(-1)!.push({ amountX: 0n, amountY: 0n, liquiditySupply: 0n });
  for (let bin = -5; bin <= 6; bin++) {
    const b: RawBin = bin <= 0 ? { amountX: 0n, amountY: 2_000n, liquiditySupply: 1_000_000n } : { amountX: 2_000n, amountY: 0n, liquiditySupply: 1_000_000n };
    if (bin >= 0) a.get(0)![bin] = b;
    else a.get(-1)![bin + 70] = b;
  }
  return a;
}
const shares = () => Array.from({ length: 70 }, (_, i) => (i <= 11 ? 1_000_000n : 0n));

describe("measure: the SDK's exact mirror of scoring.rs", () => {
  it("fixture 1: a compliant book, to the atom", () => {
    const a = arrays();
    const r = measureCommitted({ anchorBin: 0, binStep: STEP, position: { lower: -5, upper: 64, shares: shares() }, binArray: (i) => a.get(i), terms: TERMS });
    expect(r).to.deep.eq({ status: "measured", ok: true, bidDepth: 12_000n, askDepth: 12_104n, spreadBps: 25 });
  });

  it("fixture 2: the ownership share applies after valuing the whole bin", () => {
    // X = 1 atom, Y = 3 atoms at price exactly 1, half owned: (1 + 3) / 2 = 2 atoms. Flooring
    // each token's share first would give 0 + 1 = 1.
    const bins: RawBin[] = Array.from({ length: 70 }, () => ({ amountX: 0n, amountY: 0n, liquiditySupply: 0n }));
    bins[0] = { amountX: 1n, amountY: 3n, liquiditySupply: 2n };
    const r = measureCommitted({ anchorBin: 0, binStep: STEP, position: { lower: 0, upper: 69, shares: [1n, ...Array(69).fill(0n)] }, binArray: (i) => (i === 0 ? bins : undefined), terms: { ...TERMS, minDepthQuote: 2n } });
    expect(r.status === "measured" && r.bidDepth).to.eq(2n);
  });

  it("fixture 3: prices match math.rs at the extremes it allows", () => {
    expect(priceQ64(0, 25)).to.eq(1n << 64n);
    expect(priceQ64(1, 10)).to.eq(18465190817783261167n);
    expect(priceQ64(-5358, 4)).to.eq(2164342040064997394n);
    expect(priceQ64(100, 25)).to.eq(23678699809202413098n);
    expect(priceQ64(-2000, 80)).to.eq(2212358501109n);
    expect(priceQ64(0x80000, 1)).to.eq(null);
  });

  it("says unknown, not failed, when a needed bin array wasn't read", () => {
    const a = arrays();
    const r = measureCommitted({ anchorBin: 0, binStep: STEP, position: { lower: -5, upper: 64, shares: shares() }, binArray: (i) => (i === 0 ? a.get(0) : undefined), terms: TERMS });
    expect(r.status).to.eq("unknown");
  });

  it("is unchanged when a buyer takes the asks, while execution gets worse", () => {
    const a = arrays();
    const before = measureCommitted({ anchorBin: 0, binStep: STEP, position: { lower: -5, upper: 64, shares: shares() }, binArray: (i) => a.get(i), terms: TERMS });
    // A buyer takes bins 1..=3: each bin's base becomes quote at that bin's own price.
    for (let bin = 1; bin <= 3; bin++) {
      const b = a.get(0)![bin];
      a.get(0)![bin] = { ...b, amountX: 0n, amountY: b.amountY + ((b.amountX * priceQ64(bin, STEP)!) >> 64n) };
    }
    const after = measureCommitted({ anchorBin: 0, binStep: STEP, position: { lower: -5, upper: 64, shares: shares() }, binArray: (i) => a.get(i), terms: TERMS });
    if (before.status !== "measured" || after.status !== "measured") throw new Error("unmeasured");
    expect(Number(before.askDepth - after.askDepth)).to.be.within(0, 3, "rounding only");
    expect([after.ok, after.spreadBps]).to.deep.eq([before.ok, before.spreadBps]);

    const price = (id: number) => Math.pow(1 + STEP / 10_000, id);
    const book = (drained: boolean): Bin[] =>
      Array.from({ length: 12 }, (_, i) => i - 5).map((id) => (id <= 0 ? { binId: id, base: 0, quote: 2_000, price: price(id) } : { binId: id, base: drained && id <= 3 ? 0 : 2_000, quote: drained && id <= 3 ? 2_000 * price(id) : 0, price: price(id) }));
    expect(executable(book(true), 4, price(0), 500).buy.cost!).to.be.greaterThan(executable(book(false), 1, price(0), 500).buy.cost!);
  });

  it("fails an empty side", () => {
    const a = arrays();
    for (let bin = 1; bin <= 6; bin++) a.get(0)![bin] = { amountX: 0n, amountY: 0n, liquiditySupply: 0n };
    const r = measureCommitted({ anchorBin: 0, binStep: STEP, position: { lower: -5, upper: 64, shares: shares() }, binArray: (i) => a.get(i), terms: TERMS });
    expect(r.status === "measured" && [r.ok, r.spreadBps]).to.deep.eq([false, 65535]);
  });
});
