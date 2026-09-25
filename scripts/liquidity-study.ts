/**
 * "How liquid are new Solana tokens?" — measures ±2% depth of recently created
 * Meteora DAMM v2 pools (graduated launchpad tokens) straight from on-chain state.
 *
 *   npx tsx scripts/liquidity-study.ts [--pages 10] [--rpc https://...]
 *
 * Pool discovery uses Meteora's public DAMM v2 data API; depth is computed from each
 * pool's on-chain liquidity and sqrt price:  Δquote = L · (√P_hi − √P_lo) / 2^128.
 * Only pools quoted in USDC or SOL are valued (USD via the API's quote-token price).
 */
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";

const API = "https://damm-v2.datapi.meteora.ag/pools";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const DEPTH_BPS = 200;

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const PAGES = Number(arg("--pages", "10"));
const RPC = arg("--rpc", process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com");

interface ApiPool {
  address: string;
  name: string;
  launchpad: string;
  created_at: number;
  tvl: number;
  token_x: { address: string; symbol: string; decimals: number };
  token_y: { address: string; symbol: string; decimals: number; price: number };
  volume: Record<string, number>;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

/** Quote (atomic) needed to move the price ±bps, clamped to the pool's price range. */
function depthQuoteAtomic(liquidity: bigint, sqrtP: bigint, sqrtMin: bigint, sqrtMax: bigint, bps: number) {
  const scale = (s: bigint, num: bigint) => isqrt((s * s * num) / 10_000n);
  let up = scale(sqrtP, BigInt(10_000 + bps));
  let down = scale(sqrtP, BigInt(10_000 - bps));
  if (up > sqrtMax) up = sqrtMax;
  if (down < sqrtMin) down = sqrtMin;
  const ask = up > sqrtP ? (liquidity * (up - sqrtP)) >> 128n : 0n;
  const bid = sqrtP > down ? (liquidity * (sqrtP - down)) >> 128n : 0n;
  return { ask, bid };
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const pools: ApiPool[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const res = await fetch(`${API}?page=${page}&page_size=100&sort_by=pool_created_at:desc`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const j: any = await res.json();
    pools.push(...j.data);
    process.stderr.write(`fetched page ${page}/${PAGES} (${pools.length} pools)\n`);
  }
  const candidates = pools.filter(
    (p) => p.launchpad && [USDC, WSOL].includes(p.token_y.address) && p.token_y.price > 0,
  );

  const rows: any[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch.map((p) => new PublicKey(p.address)));
    infos.forEach((info, k) => {
      if (!info || info.data.length < 1112) return;
      const d = Buffer.from(info.data);
      const p = batch[k];
      const liquidity = u128(d, 360);
      const sqrtMin = u128(d, 424);
      const sqrtMax = u128(d, 440);
      const sqrtP = u128(d, 456);
      if (sqrtP === 0n || liquidity === 0n) return;
      const { ask, bid } = depthQuoteAtomic(liquidity, sqrtP, sqrtMin, sqrtMax, DEPTH_BPS);
      const usd = (a: bigint) => (Number(a) / 10 ** p.token_y.decimals) * p.token_y.price;
      rows.push({
        pool: p.address,
        name: p.name,
        launchpad: p.launchpad,
        createdAt: new Date(p.created_at).toISOString(),
        tvlUsd: p.tvl,
        volume24hUsd: p.volume?.["24h"] ?? 0,
        askDepth2pctUsd: usd(ask),
        bidDepth2pctUsd: usd(bid),
      });
    });
  }

  rows.forEach((r) => (r.depth2pctUsd = Math.min(r.askDepth2pctUsd, r.bidDepth2pctUsd)));
  const segment = (rs: any[]) => {
    const depth = rs.map((r) => r.depth2pctUsd);
    const share = (t: number) => (depth.length ? depth.filter((d) => d < t).length / depth.length : 0);
    return {
      pools: rs.length,
      medianTvlUsd: median(rs.map((r) => r.tvlUsd)),
      medianVolume24hUsd: median(rs.map((r) => r.volume24hUsd)),
      medianDepth2pctUsd: median(depth),
      medianDepthToVolume24h: median(rs.filter((r) => r.volume24hUsd > 0).map((r) => r.depth2pctUsd / r.volume24hUsd)),
      shareDepthBelow100Usd: share(100),
      shareDepthBelow1000Usd: share(1_000),
      shareDepthBelow5000Usd: share(5_000),
    };
  };
  const byLaunchpad: Record<string, any[]> = {};
  rows.forEach((r) => (byLaunchpad[r.launchpad] ??= []).push(r));
  const summary = {
    generatedAt: new Date().toISOString(),
    source: "Meteora DAMM v2 data API (discovery, newest first) + mainnet pool accounts (depth)",
    poolsScanned: pools.length,
    depthWindow: "±2% (two-sided minimum of bid and ask depth)",
    all: segment(rows),
    tvlAtLeast1k: segment(rows.filter((r) => r.tvlUsd >= 1_000)),
    volume24hAtLeast10k: segment(rows.filter((r) => r.volume24hUsd >= 10_000)),
    byLaunchpad: Object.fromEntries(
      Object.entries(byLaunchpad)
        .map(([k, v]) => [k, segment(v)])
        .sort((a: any, b: any) => b[1].pools - a[1].pools),
    ),
  };

  const out = path.resolve(__dirname, "../data");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "liquidity-study.json"), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
