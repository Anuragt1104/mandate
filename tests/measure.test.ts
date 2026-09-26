import { expect } from "chai";
import { committed, executable, type Bin } from "../sdk/src/measure";

// The same book as programs/mandate/src/scoring.rs tests: bins -5..=6, bin step 25,
// price ~1 at bin 0, bids hold quote at or below bin 0, asks hold base above it.
const STEP = 25;
const price = (id: number) => Math.pow(1 + STEP / 10_000, id);
function book(bidQuote: number, askBase: number): Bin[] {
  const out: Bin[] = [];
  for (let id = -5; id <= 6; id++) out.push(id <= 0 ? { binId: id, base: 0, quote: bidQuote / 6, price: price(id) } : { binId: id, base: askBase / 6, quote: 0, price: price(id) });
  return out;
}
const terms = { minDepth: 1_000, windowBps: 200, maxSpreadBps: 100 };

describe("measure (off-chain mirror of scoring.rs)", () => {
  it("passes a compliant book with the nearest-bin spread", () => {
    const m = committed(book(12_000, 12_000), 0, STEP, terms);
    expect(m.spreadBps).to.equal(25);
    expect(m.ok).to.equal(true);
  });

  it("is unchanged when a buyer takes the asks, while execution gets worse", () => {
    const before = book(12_000, 12_000);
    const after = before.map((b) => (b.binId >= 1 && b.binId <= 3 ? { ...b, quote: b.quote + b.base * b.price, base: 0 } : b));
    const a = committed(before, 0, STEP, terms);
    const b = committed(after, 0, STEP, terms);
    expect(Math.abs(a.askDepth - b.askDepth)).to.be.lessThan(1e-6);
    expect([a.ok, a.spreadBps]).to.deep.equal([b.ok, b.spreadBps]);
    // A trader now finds the nearest asks three bins further away.
    const exBefore = executable(before, 1, price(0), 500).buy.cost!;
    const exAfter = executable(after, 4, price(0), 500).buy.cost!;
    expect(exAfter).to.be.greaterThan(exBefore);
  });

  it("fails an empty side", () => {
    const m = committed(book(12_000, 0), 0, STEP, terms);
    expect(m.ok).to.equal(false);
    expect(m.spreadBps).to.equal(null);
  });
});
