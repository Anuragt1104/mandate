/**
 * A living test network for Mandate. Named, simulated participants act on real contracts so
 * the product can be watched working end to end: a launchpad whose tokens graduate with a
 * liquidity SLA, market makers of different quality, retail traders, a whale, an attacker
 * who tries to fake a pass, and a watchtower that checks everyone at random times.
 *
 *   npx tsx scripts/simulate.ts setup            # launch tokens, post SLAs, makers accept
 *   npx tsx scripts/simulate.ts run              # run the network (Ctrl-C to stop, re-run to resume)
 *
 * Off localnet set CLUSTER, RPC_URL and DLMM_PRESET, e.g. for devnet:
 *   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com DLMM_PRESET=4vP4DFDJLRz85NBCfJALYPNdieWwzQSstrUuTms1gekn npx tsx scripts/simulate.ts setup
 *
 * The story `run` plays out (times from the first run, adjustable by env):
 *   LAZY_QUIT_SECS (480)   Lazy Capital pulls its liquidity from KITE; checks fail; the bond is
 *                          slashed after the agreed failed periods; the watchtower unwinds and settles.
 *   RETENDER_SECS  (90)    after settlement, Kite Protocol posts a new SLA for KITE from its treasury.
 *   TIDEWATER_SECS (150)   Tidewater Trading accepts the open SLA and starts quoting.
 * Throughout: Helios Markets quotes ORBT (and the earlier MAND demo on devnet), retail and a
 * whale trade, and Mallory sandwiches checks on ORBT, which still pass.
 *
 * Scenes replay a moment on demand while `run` is running elsewhere (its watchtower does the
 * checking, slashing and settling), for recording:
 *   npx tsx scripts/simulate.ts scene walkaway [minutes]   a fresh KITE SLA; Lazy Capital takes it,
 *                                                          quotes for `minutes` (default 3), then walks
 *   npx tsx scripts/simulate.ts scene sandwich             Mallory sandwiches a check on ORBT now
 *   npx tsx scripts/simulate.ts scene whale                Ferro Capital buys ~3,000 USDC of ORBT now
 *
 * Every participant is fictional and labelled as simulated in app/public/personas.<cluster>.json.
 */
import fs from "fs";
import path from "path";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { MandateClient, MandateTerms, pda, statusName } from "../sdk/src";
import { CrankState, crankOnce, makerTick, sandwichCheck, tradeOnce, withdrawAll } from "../keeper/agents";
import { RPC_URL, fetchMandate, loadKeypair, makeClient, makeConnection, sendIxs, sleep } from "../keeper/common";
import { CLUSTER_NAME, IS_LOCAL, KEY_DIR, ROOT, SUFFIX, createMandatedConfig, ensureAta, fund, helperKey, launchAndGraduate, mintTo, newMint, pairAtGraduatedPrice } from "./lib/launch";

const conn = makeConnection();
const STATE_PATH = path.join(KEY_DIR, "sim", "state.json");
const PERSONAS_PATH = path.join(ROOT, `app/public/personas${SUFFIX}.json`);
const USDC = (n: number) => new BN(Math.round(n * 1e6).toString());
const env = (k: string, d: number) => Number(process.env[k] ?? d);

// ---------------------------------------------------------------- cast

type Role = "launchpad" | "issuer" | "maker" | "trader" | "whale" | "attacker" | "watchtower";
interface Persona { key: Keypair; name: string; role: Role; bio: string; color: number; sol: number; usdc: number }

function cast() {
  const launchpad = loadKeypair();
  const p = (key: Keypair, name: string, role: Role, bio: string, color: number, sol: number, usdc: number): Persona => ({ key, name, role, bio, color, sol, usdc });
  const k = (name: string) => helperKey(`sim/${name}`, true);
  // On devnet the earlier demo's maker and buyer keep their track record under these names.
  const helios = CLUSTER_NAME === "devnet" && fs.existsSync(path.join(KEY_DIR, "maker.json")) ? loadKeypair(path.join(KEY_DIR, "maker.json")) : k("helios");
  const buyers = CLUSTER_NAME === "devnet" && fs.existsSync(path.join(KEY_DIR, "buyer.json")) ? loadKeypair(path.join(KEY_DIR, "buyer.json")) : k("buyers");
  return {
    nova: p(launchpad, "Nova Launchpad", "launchpad", "Launchpad whose tokens graduate with a liquidity SLA funded from their leftover supply.", 45, 0, 0),
    orbit: p(k("orbit"), "Orbit Labs", "issuer", "Team behind ORBT, launched on Nova.", 33, 0.08, 0),
    kite: p(k("kite"), "Kite Protocol", "issuer", "Team behind KITE. Bought out its own curve and holds a treasury; re-tenders its SLA after a breach.", 39, 0.15, 300_000),
    buyers: p(buyers, "Launch buyers", "trader", "Early buyers who took ORBT through graduation.", 244, 0.05, 300_000),
    helios: p(helios, "Helios Markets", "maker", "Diligent market maker: quotes both sides and re-centres as the price moves.", 36, 0.35, 5_000),
    lazy: p(k("lazy"), "Lazy Capital", "maker", "Accepts an SLA, quotes for a while, then pulls its liquidity.", 208, 0.3, 5_000),
    tidewater: p(k("tidewater"), "Tidewater Trading", "maker", "Picks up open SLAs from the board and quotes them.", 75, 0.3, 5_000),
    priya: p(k("priya"), "Priya", "trader", "Retail trader, small sizes.", 213, 0.04, 20_000),
    marco: p(k("marco"), "Marco", "trader", "Retail trader, small sizes.", 141, 0.04, 20_000),
    jun: p(k("jun"), "Jun", "trader", "Retail trader, small sizes.", 110, 0.04, 20_000),
    ferro: p(k("ferro"), "Ferro Capital", "whale", "Occasional block trades that move the price.", 178, 0.05, 250_000),
    mallory: p(k("mallory"), "Mallory", "attacker", "Buys out the asks and forces a check in the same transaction, hoping to fake a result.", 196, 0.05, 50_000),
    watchtower: p(k("watchtower"), "Watchtower", "watchtower", "Checks every live SLA at random times. Anyone can run one.", 250, 0.08, 0),
  };
}
type Cast = ReturnType<typeof cast>;

// ---------------------------------------------------------------- state

interface Market { symbol: string; mint: string; dammPool: string; lbPair: string }
interface State {
  quoteMint?: string;
  router?: string;
  dbcConfig?: string;
  markets: Record<string, Market>;
  mandates: Record<string, string>; // orbt, kite, kite2, mand
  story: { startedAt?: number; lazyQuitAt?: number; kiteSettledAt?: number; retenderAt?: number; tidewaterAt?: number };
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { markets: {}, mandates: {}, story: {} };
  }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function writePersonas(c: Cast, s: State) {
  const parties: Record<string, { name: string; role: Role; bio: string }> = {};
  for (const p of Object.values(c)) parties[p.key.publicKey.toBase58()] = { name: p.name, role: p.role, bio: p.bio };
  const out = {
    cluster: CLUSTER_NAME,
    generatedBy: "scripts/simulate.ts",
    note: "Simulated participants on the Mandate test network. The companies and people are fictional; their transactions are real.",
    parties,
    mandates: s.mandates,
    tokens: s.quoteMint ? { [s.quoteMint]: { symbol: "USDC", name: "Test USDC" } } : {},
    quoteMint: s.quoteMint,
    markets: s.markets,
  };
  fs.writeFileSync(PERSONAS_PATH, JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------- terms

/** One-minute periods so a whole story plays out in minutes; a seven-day term. */
function slaTerms(o: Partial<{ fee: number; bond: number; depth: number; spread: number; failures: number }> = {}): MandateTerms {
  return {
    feePerPeriod: USDC(o.fee ?? 0.5), periodSecs: 60, durationPeriods: 10_080, bondAmount: USDC(o.bond ?? 250),
    maxSpreadBps: o.spread ?? 100, minDepthQuote: USDC(o.depth ?? 500), depthWindowBps: 200, bandBps: 500,
    anchorTwapSecs: 120, anchorSpeedBpsPerMin: 200, liquidityLockSecs: 20, maxConsecutiveFailures: o.failures ?? 3, slashBps: 5_000,
  };
}

// ---------------------------------------------------------------- logging

const t0 = Date.now();
const colored = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[38;5;${code}m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
function say(who: Persona | null, msg: string) {
  const clock = new Date().toTimeString().slice(0, 8);
  const name = who ? colored(who.color, who.name.padEnd(18)) : "".padEnd(18);
  console.log(`${dim(clock)}  ${name}${msg}`);
}
function banner(msg: string) {
  console.log(`\n${colored(15, `━━ ${msg} ━━`)}\n`);
}

// ---------------------------------------------------------------- setup

async function setup() {
  const c = cast();
  const s = loadState();
  const launchpad = c.nova.key;
  const client = makeClient(conn, launchpad);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  if (IS_LOCAL) {
    const sig = await conn.requestAirdrop(launchpad.publicKey, 500 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  if (s.quoteMint && !(await conn.getAccountInfo(new PublicKey(s.quoteMint)))) {
    // The cluster was reset (localnet): start the story over.
    Object.assign(s, { quoteMint: undefined, router: undefined, dbcConfig: undefined, markets: {}, mandates: {}, story: {} });
    saveState(s);
  }
  banner(`Setting up the ${CLUSTER_NAME} network`);
  for (const p of Object.values(c)) if (p.sol) await fund(conn, launchpad, p.key.publicKey, IS_LOCAL ? 5 : p.sol);
  say(c.nova, `funded ${Object.values(c).filter((p) => p.sol).length} participants with SOL`);

  // Quote token: the cluster's test USDC (the launchpad holds its mint authority).
  if (!s.quoteMint) {
    const demoPath = path.join(ROOT, `app/public/demo${SUFFIX}.json`);
    const demo = !IS_LOCAL && fs.existsSync(demoPath) ? JSON.parse(fs.readFileSync(demoPath, "utf8")) : null;
    s.quoteMint = demo?.quoteMint ?? (await newMint(conn, launchpad, 6)).toBase58();
    if (demo?.dbcConfig) s.dbcConfig = demo.dbcConfig;
    if (demo?.mandates?.[0]) s.mandates.mand = demo.mandates[0];
    saveState(s);
  }
  const quote = new PublicKey(s.quoteMint!);
  for (const p of Object.values(c)) {
    if (!p.usdc) continue;
    const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(quote, p.key.publicKey)).then((b) => Number(b.value.uiAmount)).catch(() => 0);
    if (bal < p.usdc / 2) await mintTo(conn, launchpad, quote, p.key.publicKey, BigInt(Math.round(p.usdc - bal)) * 1_000_000n);
  }
  await mintTo(conn, launchpad, quote, launchpad.publicKey, 50_000n * 1_000_000n);
  say(c.nova, `minted test USDC to participants`);

  const router = pda.router(launchpad.publicKey);
  if (!(await conn.getAccountInfo(router))) await sendIxs(conn, launchpad, [await client.initRouter({ authority: launchpad.publicKey })]);
  s.router = router.toBase58();
  if (!s.dbcConfig) {
    s.dbcConfig = (await createMandatedConfig(conn, dbc, launchpad, router, quote)).toBase58();
    say(c.nova, `created its Mandated launch config: leftover supply is routed to its Mandate router`);
  }
  saveState(s);

  const launches = [
    { id: "orbt", symbol: "ORBT", name: "Orbit", creator: c.orbit, buyer: c.buyers, maker: c.helios },
    { id: "kite", symbol: "KITE", name: "Kite", creator: c.kite, buyer: c.kite, maker: c.lazy },
  ];
  for (const l of launches) {
    if (!s.markets[l.id]) {
      const g = await launchAndGraduate({
        conn, dbc, launchpad, creator: l.creator.key, buyer: l.buyer.key, config: new PublicKey(s.dbcConfig!), quote, router,
        name: l.name, symbol: l.symbol, uri: `https://mandate-lac-rho.vercel.app/tokens/${l.id}.json`,
      });
      say(l.creator, `launched ${l.symbol} on Nova; it graduated to a DAMM v2 pool`);
      const { lbPair } = await pairAtGraduatedPrice(conn, launchpad, g.baseMint, quote, g.dammPool);
      s.markets[l.id] = { symbol: l.symbol, mint: g.baseMint.toBase58(), dammPool: g.dammPool.toBase58(), lbPair: lbPair.toBase58() };
      saveState(s);
      say(c.nova, `opened the ${l.symbol}/USDC DLMM pair at the graduation price`);
    }
    const mk = s.markets[l.id];
    const baseMint = new PublicKey(mk.mint);
    if (!s.mandates[l.id]) {
      await ensureAta(conn, launchpad, baseMint, launchpad.publicKey);
      const mandate = pda.mandate(launchpad.publicKey, baseMint, 1);
      const terms = slaTerms();
      await sendIxs(conn, launchpad, [
        await client.createMandate({
          issuer: launchpad.publicKey, baseMint, quoteMint: quote, lbPair: new PublicKey(mk.lbPair), referencePool: new PublicKey(mk.dammPool), id: 1, terms,
          baseDeposit: new BN(0), quoteDeposit: USDC(5_000), feeBudget: terms.feePerPeriod.muln(terms.durationPeriods),
        }),
        await client.registerLaunch({ authority: launchpad.publicKey, baseMint, mandate }),
      ]);
      const m0 = await fetchMandate(conn, client, mandate);
      await sendIxs(conn, launchpad, [await client.routeLeftover({ routerAuthority: launchpad.publicKey, mandate, m: m0 })]);
      s.mandates[l.id] = mandate.toBase58();
      saveState(s);
      say(c.nova, `posted the ${l.symbol} liquidity SLA, funded with 100M ${l.symbol} of leftover supply and 5,000 USDC`);
    }
    const mandate = new PublicKey(s.mandates[l.id]);
    const makerClient = makeClient(conn, l.maker.key);
    for (let i = 0; i < 4; i++) {
      const did = await makerTick(conn, l.maker.key, makerClient, mandate, { autoAccept: true });
      if (!did) break;
      say(l.maker, `${did} (${l.symbol})`);
    }
  }
  writePersonas(c, s);
  say(null, `wrote ${path.relative(ROOT, PERSONAS_PATH)} and ${path.relative(ROOT, STATE_PATH)}`);
}

// ---------------------------------------------------------------- run

interface Task { who: Persona; every: [number, number]; next: number; run: () => Promise<void> }
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

async function run() {
  const c = cast();
  const s = loadState();
  if (!s.mandates.orbt || !s.mandates.kite) throw new Error("run `setup` first");
  const clients = new Map<string, MandateClient>();
  const cl = (p: Persona) => clients.get(p.name) ?? (clients.set(p.name, makeClient(conn, p.key)), clients.get(p.name)!);
  const symbolOf: Record<string, string> = {};
  for (const [id, addr] of Object.entries(s.mandates)) symbolOf[addr] = id === "mand" ? "MAND" : s.markets[id.replace(/2$/, "")]?.symbol ?? id.toUpperCase();
  const label = (addr: string) => `${symbolOf[addr] ?? addr.slice(0, 6)}/USDC`;
  const symbolForMint = (mint: PublicKey) => Object.values(s.markets).find((mk) => mk.mint === mint.toBase58())?.symbol;
  const now = () => Date.now() / 1000;
  s.story.startedAt ??= now();
  saveState(s);
  writePersonas(c, s);

  const LAZY_QUIT = env("LAZY_QUIT_SECS", 480);
  const RETENDER = env("RETENDER_SECS", 90);
  const TIDEWATER = env("TIDEWATER_SECS", 150);

  /** SLAs with a live position: somewhere a trader can actually trade (cached for 20 s). */
  let liveCache: { at: number; list: PublicKey[] } = { at: 0, list: [] };
  async function liveMarkets(): Promise<PublicKey[]> {
    if (now() - liveCache.at < 20) return liveCache.list;
    const out: PublicKey[] = [];
    for (const addr of new Set(Object.values(s.mandates))) {
      const m = await fetchMandate(conn, cl(c.watchtower), new PublicKey(addr)).catch(() => null);
      if (m && statusName(m.status) === "Active" && !(m.position as PublicKey).equals(PublicKey.default)) out.push(new PublicKey(addr));
    }
    liveCache = { at: now(), list: out };
    return out;
  }

  const crankState: CrankState = new Map();
  const lastCheckTs = new Map<string, number>();
  const tasks: Task[] = [];
  const every = (who: Persona, range: [number, number], fn: () => Promise<void>, delay = 0) => tasks.push({ who, every: range, next: now() + delay + rand(0, range[0]), run: fn });

  // Watchtower: random-time checks, finalization, unwind and settlement.
  every(c.watchtower, [6, 10], async () => {
    await crankOnce(conn, c.watchtower.key, cl(c.watchtower), crankState, {
      samplesPerPeriod: 3,
      onEvent: async (key, what) => {
        if (!symbolOf[key]) {
          const m = await fetchMandate(conn, cl(c.watchtower), new PublicKey(key)).catch(() => null);
          const sym = m && symbolForMint(m.baseMint);
          if (sym) symbolOf[key] = sym;
        }
        if (what.startsWith("checked")) {
          const m = await fetchMandate(conn, cl(c.watchtower), new PublicKey(key)).catch(() => null);
          if (!m) return;
          if (statusName(m.status) === "Breached") {
            const maker = Object.values(c).find((p) => p.key.publicKey.equals(m.maker));
            banner(`${label(key)} SLA breached`);
            return say(c.watchtower, `${colored(203, "BREACH")} ${maker?.name ?? "the maker"} missed ${m.terms.maxConsecutiveFailures} periods in a row: ${(Number(m.bondSlashed) / 1e6).toFixed(0)} USDC of its bond slashed · ${label(key)}`);
          }
          const l = m.last;
          // Checks inside the setup grace (or while catching up on periods) record nothing.
          if (l.ts.toNumber() === 0 || l.ts.toNumber() === lastCheckTs.get(key)) return say(c.watchtower, dim(`checked ${label(key)} · setup grace, not scored`));
          lastCheckTs.set(key, l.ts.toNumber());
          const v = (x: any) => Math.round(Number(x) / 1e6).toLocaleString("en-US");
          const detail = `spread ${l.spreadBps === 65535 ? "— (a side is empty)" : `${l.spreadBps} bps`} · bids ${v(l.bidDepthQuote)} · asks ${v(l.askDepthQuote)} USDC`;
          say(c.watchtower, `checked ${label(key)}  ${l.ok ? colored(35, "PASS") : colored(203, "FAIL")}  ${dim(detail)}`);
        } else say(c.watchtower, `${what} · ${label(key)}`);
      },
    });
  });

  // Helios: the diligent maker, on ORBT (and the earlier MAND demo on devnet).
  const heliosMandates = [s.mandates.orbt, s.mandates.mand].filter(Boolean).map((a) => new PublicKey(a));
  every(c.helios, [18, 28], async () => {
    for (const mandate of heliosMandates) {
      const did = await makerTick(conn, c.helios.key, cl(c.helios), mandate);
      if (did) say(c.helios, `${did} · ${label(mandate.toBase58())}`);
    }
  });
  every(c.helios, [540, 720], async () => {
    for (const mandate of heliosMandates) {
      const m = await fetchMandate(conn, cl(c.helios), mandate);
      const owed = Number(m.feesEarned) - Number(m.feesClaimed);
      if (owed < 1e6 || !(m.maker as PublicKey).equals(c.helios.key.publicKey)) continue;
      await sendIxs(conn, c.helios.key, [await cl(c.helios).claimMakerFees({ mandate, m })]);
      say(c.helios, `claimed ${(owed / 1e6).toFixed(2)} USDC in fees earned · ${label(mandate.toBase58())}`);
    }
  }, 300);

  // Lazy Capital: diligent until it isn't.
  const kite = new PublicKey(s.mandates.kite);
  every(c.lazy, [18, 28], async () => {
    if (!s.story.lazyQuitAt && now() - s.story.startedAt! < LAZY_QUIT) {
      const did = await makerTick(conn, c.lazy.key, cl(c.lazy), kite);
      if (did) say(c.lazy, `${did} · ${label(kite.toBase58())}`);
      return;
    }
    if (!s.story.lazyQuitAt) {
      const did = await withdrawAll(conn, c.lazy.key, cl(c.lazy), kite);
      if (!did) return; // still inside the liquidity lock; try again next tick
      s.story.lazyQuitAt = now();
      saveState(s);
      banner("Lazy Capital stops making KITE's market");
      say(c.lazy, `${did} · ${label(kite.toBase58())}`);
    }
  });

  // Kite Protocol re-tenders after the breach settles; Tidewater picks it up.
  every(c.kite, [10, 15], async () => {
    const m = await fetchMandate(conn, cl(c.kite), kite);
    const st = statusName(m.status);
    if (st === "Settled" && !s.story.kiteSettledAt) {
      s.story.kiteSettledAt = now();
      saveState(s);
      banner("KITE's SLA was breached and settled");
    }
    if (!s.story.kiteSettledAt || s.mandates.kite2 || now() - s.story.kiteSettledAt < RETENDER) return;
    const mk = s.markets.kite;
    const baseMint = new PublicKey(mk.mint);
    const quote = new PublicKey(s.quoteMint!);
    const id = 1;
    const mandate = pda.mandate(c.kite.key.publicKey, baseMint, id);
    if (!(await conn.getAccountInfo(mandate))) {
      const treasury = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(baseMint, c.kite.key.publicKey)).then((b) => BigInt(b.value.amount));
      const baseDeposit = treasury / 4n; // a quarter of the treasury as quoting inventory
      const terms = slaTerms({ fee: 0.75, bond: 400, depth: 400 });
      await sendIxs(conn, c.kite.key, [
        createAssociatedTokenAccountIdempotentInstruction(c.kite.key.publicKey, getAssociatedTokenAddressSync(quote, c.kite.key.publicKey), c.kite.key.publicKey, quote),
        await cl(c.kite).createMandate({
          issuer: c.kite.key.publicKey, baseMint, quoteMint: quote, lbPair: new PublicKey(mk.lbPair), referencePool: new PublicKey(mk.dammPool), id, terms,
          baseDeposit: new BN(baseDeposit.toString()), quoteDeposit: USDC(3_000), feeBudget: terms.feePerPeriod.muln(terms.durationPeriods),
        }),
      ]);
    }
    s.mandates.kite2 = mandate.toBase58();
    symbolOf[s.mandates.kite2] = "KITE";
    s.story.retenderAt = now();
    saveState(s);
    writePersonas(c, s);
    banner("Kite Protocol re-tenders its SLA");
    say(c.kite, `posted a new SLA for KITE from its own treasury, open to any maker · bond 400 USDC, 0.75 USDC per compliant minute`);
  });

  every(c.tidewater, [15, 25], async () => {
    if (!s.mandates.kite2 || now() - (s.story.retenderAt ?? Infinity) < TIDEWATER) return;
    const mandate = new PublicKey(s.mandates.kite2);
    if (!s.story.tidewaterAt) {
      banner("Tidewater Trading takes the open KITE SLA");
      s.story.tidewaterAt = now();
      saveState(s);
    }
    for (let i = 0; i < 3; i++) {
      const did = await makerTick(conn, c.tidewater.key, cl(c.tidewater), mandate, { autoAccept: true });
      if (!did) break;
      say(c.tidewater, `${did} · ${label(mandate.toBase58())}`);
    }
  });

  // Traders.
  for (const who of [c.priya, c.marco, c.jun]) {
    every(who, [25, 55], async () => {
      const live = await liveMarkets();
      if (!live.length) return;
      const mandate = pick(live);
      const t = await tradeOnce(conn, who.key, cl(who), mandate, { maxQuote: 250 });
      say(who, `${t.buy ? "bought" : "sold"} ${Math.round(t.quoteSize)} USDC of ${symbolOf[mandate.toBase58()] ?? "tokens"}`);
    });
  }
  every(c.ferro, [200, 320], async () => {
    const live = await liveMarkets();
    if (!live.length) return;
    const mandate = pick(live);
    const t = await tradeOnce(conn, c.ferro.key, cl(c.ferro), mandate, { quoteSize: rand(1_500, 3_500) });
    say(c.ferro, `${t.buy ? "bought" : "sold"} ${Math.round(t.quoteSize).toLocaleString("en-US")} USDC of ${symbolOf[mandate.toBase58()]} in one block`);
  }, 60);

  // Mallory: sandwich a check on Helios's ORBT market.
  const orbt = new PublicKey(s.mandates.orbt);
  every(c.mallory, [300, 420], async () => {
    const size = rand(1_500, 3_000);
    const r = await sandwichCheck(conn, c.mallory.key, cl(c.mallory), orbt, size);
    say(c.mallory, `bought ${size.toFixed(0)} USDC of ORBT and forced a check in the same transaction (price pushed ${r.movedBins} bins): ${r.passed ? colored(35, "check still passed") : colored(203, "check failed")}; sold back`);
  }, 120);

  banner(`Mandate test network running on ${CLUSTER_NAME} (Ctrl-C to stop)`);
  const stopAt = process.env.MINUTES ? t0 + Number(process.env.MINUTES) * 60_000 : Infinity;
  while (Date.now() < stopAt) {
    tasks.sort((a, b) => a.next - b.next);
    const task = tasks[0];
    const wait = task.next - now();
    if (wait > 0) await sleep(Math.min(wait, 1) * 1000);
    if (task.next > now()) continue;
    try {
      await task.run();
    } catch (e: any) {
      const logs: string[] = e.logs ?? e.transactionLogs ?? [];
      const hint = logs.filter((l) => /Error Message|failed/.test(l)).slice(-1)[0] ?? "";
      say(task.who, dim(`skipped: ${e.message?.split("\n")[0] ?? e} ${hint}`));
    }
    task.next = now() + rand(...task.every);
  }
}

// ---------------------------------------------------------------- scenes

async function scene(name: string | undefined, arg: string | undefined) {
  const c = cast();
  const s = loadState();
  if (!s.mandates.orbt || !s.markets.kite) throw new Error("run `setup` first");
  const cl = (p: Persona) => makeClient(conn, p.key);
  const orbt = new PublicKey(s.mandates.orbt);

  if (name === "sandwich") {
    const size = 2_500;
    banner("Scene: Mallory sandwiches a check on ORBT");
    const r = await sandwichCheck(conn, c.mallory.key, cl(c.mallory), orbt, size);
    say(c.mallory, `bought ${size.toLocaleString("en-US")} USDC of ORBT and forced a check in the same transaction (price pushed ${r.movedBins} bins): ${r.passed ? colored(35, "check still passed") : colored(203, "check failed")}; sold back`);
    return;
  }
  if (name === "whale") {
    banner("Scene: Ferro Capital trades a block of ORBT");
    const t = await tradeOnce(conn, c.ferro.key, cl(c.ferro), orbt, { side: "buy", quoteSize: 3_000 });
    say(c.ferro, `bought ${Math.round(t.quoteSize).toLocaleString("en-US")} USDC of ORBT in one block; the reference follows at up to 2% a minute`);
    return;
  }
  if (name !== "walkaway") throw new Error("scenes: walkaway [minutes] | sandwich | whale");

  const minutes = Number(arg ?? 3);
  const mk = s.markets.kite;
  const baseMint = new PublicKey(mk.mint);
  const quote = new PublicKey(s.quoteMint!);
  let id = 2;
  while (await conn.getAccountInfo(pda.mandate(c.kite.key.publicKey, baseMint, id))) id++;
  const mandate = pda.mandate(c.kite.key.publicKey, baseMint, id);
  banner(`Scene: a maker walks away from a KITE SLA (quotes for ${minutes} min)`);
  const treasury = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(baseMint, c.kite.key.publicKey)).then((b) => BigInt(b.value.amount));
  const terms = slaTerms();
  await sendIxs(conn, c.kite.key, [
    await cl(c.kite).createMandate({
      issuer: c.kite.key.publicKey, baseMint, quoteMint: quote, lbPair: new PublicKey(mk.lbPair), referencePool: new PublicKey(mk.dammPool), id, terms,
      baseDeposit: new BN((treasury / 8n).toString()), quoteDeposit: USDC(2_000), feeBudget: terms.feePerPeriod.muln(terms.durationPeriods),
      designatedMaker: c.lazy.key.publicKey,
    }),
  ]);
  s.mandates[`walkaway${id}`] = mandate.toBase58();
  saveState(s);
  writePersonas(c, s);
  say(c.kite, `posted a KITE SLA for Lazy Capital: 500 USDC each side, 0.5 USDC per compliant minute, 250 USDC bond`);
  const lazyClient = cl(c.lazy);
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    // Act back-to-back while there is work (accept, open, place), then idle between ticks.
    for (let i = 0; i < 4 && Date.now() < until; i++) {
      const did = await makerTick(conn, c.lazy.key, lazyClient, mandate, { autoAccept: true }).catch((e) => `skipped: ${e.message?.split("\n")[0]}`);
      if (!did) break;
      say(c.lazy, `${did} · KITE/USDC`);
    }
    await sleep(15_000);
  }
  for (;;) {
    const did = await withdrawAll(conn, c.lazy.key, lazyClient, mandate).catch(() => null);
    if (did) {
      say(c.lazy, `${did} · KITE/USDC. It is no longer quoting.`);
      break;
    }
    await sleep(5_000);
  }
  say(null, dim(`the watchtower (from \`run\`) now finds the book empty: ${terms.maxConsecutiveFailures} failed periods slash half the bond`));
  let last = "";
  for (let i = 0; i < 80; i++) {
    const m = await fetchMandate(conn, lazyClient, mandate).catch(() => null);
    const st = m ? statusName(m.status) : "";
    const line = m ? `${st}: ${m.consecutiveFailed} failed period${m.consecutiveFailed === 1 ? "" : "s"} in a row, ${(Number(m.bondSlashed) / 1e6).toFixed(0)} USDC slashed` : "";
    if (line && line !== last) say(c.watchtower, line);
    last = line;
    if (st === "Settled") break;
    await sleep(10_000);
  }
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "run" ? run() : cmd === "scene" ? scene(process.argv[3], process.argv[4]) : Promise.reject(new Error("usage: simulate.ts setup | run | scene <walkaway [minutes] | sandwich | whale>"))).catch((e) => {
  console.error(e);
  process.exit(1);
});
