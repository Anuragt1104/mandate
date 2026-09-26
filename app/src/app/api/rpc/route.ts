/**
 * Same-origin JSON-RPC proxy for the app. Browsers call /api/rpc; this forwards to the
 * cluster's RPC with the same per-method hedged failover the bots use, from Vercel's network,
 * so a throttled client IP doesn't stall the page. The upstream is server-side
 * (RPC_UPSTREAM), so a keyed provider URL never reaches the browser.
 *
 * Reads are cached briefly per edge instance and shared between concurrent viewers. When the
 * upstream is slow, a recent answer is served at once and refreshed after the response, so
 * dashboards keep moving through public-RPC slowdowns. Only the methods the app uses are
 * forwarded, and program scans are limited to the Mandate program.
 *
 * The upstream budget is shared, so each client (by IP) and the instance as a whole are
 * rate limited, and each call's cost is bounded (keys per read, signatures per page,
 * transaction size). Errors never carry upstream details: the client gets a correlation id
 * and the redacted cause is logged server-side. A `getTransaction` that returns null (not yet
 * available at this commitment) is never cached. `?fresh=1` (used by wallet actions) skips the
 * cache entirely, so a transaction is built from current state.
 *
 * `?cluster=mainnet` reads mainnet instead (read methods only), for monitoring existing
 * arrangements: RPC_UPSTREAM_MAINNET if set (keep keyed URLs server-side), else public RPC.
 * Program scans are allowed for the Mandate program, and for Meteora DLMM positions only when
 * filtered to one pair and sliced to their header (owner lookups for the monitor).
 */
import { after } from "next/server";
import { failoverFetch, PUBLIC_FALLBACKS, redact } from "../../../../../sdk/src/rpc";

export const runtime = "edge";

const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "localnet";
const PRIMARY = process.env.RPC_UPSTREAM ?? process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const FALLBACKS = process.env.RPC_UPSTREAM_FALLBACKS?.split(",").filter(Boolean) ?? PUBLIC_FALLBACKS[CLUSTER] ?? [];
const upstream = failoverFetch([PRIMARY, ...FALLBACKS], { timeoutMs: 8_000, hedgeMs: 1_200, rounds: 2 });
const mainnet = failoverFetch([process.env.RPC_UPSTREAM_MAINNET ?? "https://api.mainnet-beta.solana.com"], { timeoutMs: 10_000, hedgeMs: 3_000, rounds: 2 });
const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const WRITES = new Set(["sendTransaction", "simulateTransaction", "requestAirdrop"]);

/** A DLMM position scan the monitor needs: filtered to one pair (offset 8), header slice only. */
function allowedDlmmScan(p: any[]): boolean {
  const cfg = p?.[1] ?? {};
  const filters: any[] = cfg.filters ?? [];
  const byPair = filters.some((f) => f?.memcmp?.offset === 8 && typeof f.memcmp.bytes === "string");
  const slice = cfg.dataSlice;
  return byPair && !!slice && slice.offset === 0 && slice.length <= 72;
}

const MANDATE_PROGRAM = "3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn";
const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "getSignaturesForAddress", "getTransaction", "getSignatureStatuses", "getLatestBlockhash", "isBlockhashValid", "getFeeForMessage",
  "getMinimumBalanceForRentExemption", "getRecentPrioritizationFees", "getSlot", "getBlockHeight", "getBlockTime", "getEpochInfo",
  "getGenesisHash", "getVersion", "getHealth", "sendTransaction", "simulateTransaction",
  ...(CLUSTER === "mainnet-beta" ? [] : ["requestAirdrop"]),
]);

/** Per-call cost bounds; anything larger is refused before it reaches the upstream. */
function tooExpensive(c: any): string | null {
  const p = c.params ?? [];
  if (c.method === "getMultipleAccounts" && (!Array.isArray(p[0]) || p[0].length > 100)) return "at most 100 accounts per call";
  if (c.method === "getSignatureStatuses" && (!Array.isArray(p[0]) || p[0].length > 256)) return "at most 256 signatures per call";
  if (c.method === "getSignaturesForAddress" && (p[1]?.limit ?? 1000) > 100) return "at most 100 signatures per page";
  if ((c.method === "sendTransaction" || c.method === "simulateTransaction") && (typeof p[0] !== "string" || p[0].length > 2_000)) return "transaction too large";
  return null;
}

/** Token buckets per client and for the instance (edge instances don't share them; they bound each one). */
// One agreement page legitimately makes dozens of calls at once (accounts, events, transactions).
const CLIENT_RATE = { perSec: 20, burst: 150 };
const WRITE_RATE = { perSec: 0.5, burst: 5 };
const GLOBAL_RATE = { perSec: 150, burst: 400 };
const buckets = new Map<string, { tokens: number; at: number }>();
function take(key: string, rate: { perSec: number; burst: number }, cost = 1): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: rate.burst, at: now };
  b.tokens = Math.min(rate.burst, b.tokens + ((now - b.at) / 1000) * rate.perSec);
  b.at = now;
  buckets.set(key, b);
  if (buckets.size > 5_000) buckets.delete(buckets.keys().next().value!);
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
const MAX_CONCURRENT = 64;
let running = 0;

/** How long a read stays fresh, and how long a stale copy may stand in while it refreshes. */
const FRESH_MS: Record<string, number> = {
  getAccountInfo: 4_000, getMultipleAccounts: 4_000, getProgramAccounts: 6_000, getSignaturesForAddress: 4_000,
  getTokenAccountBalance: 4_000, getBalance: 4_000, getTransaction: 3_600_000, getBlockTime: 3_600_000,
  getMinimumBalanceForRentExemption: 3_600_000, getGenesisHash: 86_400_000, getVersion: 600_000,
};
const STALE_MS = 90_000;
const cache = new Map<string, { at: number; status: number; result: string }>();
const inflight = new Map<string, Promise<{ status: number; result: string }>>();

function refuse(id: unknown, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message } }, { status });
}

async function forward(body: string, net: "default" | "mainnet" = "default"): Promise<{ status: number; result: string }> {
  const res = await (net === "mainnet" ? mainnet : upstream)("", { method: "POST", headers: { "content-type": "application/json" }, body });
  return { status: res.status, result: await res.text() };
}

/** One upstream request per distinct call at a time; successful answers are cached. */
function load(key: string, call: any, net: "default" | "mainnet" = "default"): Promise<{ status: number; result: string }> {
  let p = inflight.get(key);
  if (!p) {
    p = forward(JSON.stringify({ ...call, id: 1 }), net)
      .then((r) => {
        // A null result can mean "not available yet" (getTransaction at this commitment);
        // caching it would hide the transaction for as long as the entry lives.
        if (r.status === 200 && /"result"\s*:/.test(r.result) && !/"error"\s*:/.test(r.result.slice(0, 200)) && !/"result"\s*:\s*null\b/.test(r.result.slice(0, 200)))
          cache.set(key, { at: Date.now(), ...r });
        return r;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return p;
}

const withId = (result: string, id: unknown) => {
  try {
    return JSON.stringify({ ...JSON.parse(result), id });
  } catch {
    return result;
  }
};
const reply = (status: number, body: string, source: string) =>
  new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-rpc-source": source } });

export async function POST(req: Request) {
  const body = await req.text();
  if (body.length > 64_000) return refuse(null, "request too large");
  let calls: any;
  try {
    calls = JSON.parse(body);
  } catch {
    return refuse(null, "invalid JSON");
  }
  const list = Array.isArray(calls) ? calls : [calls];
  if (!list.length || list.length > 20) return refuse(null, "batch size not allowed");
  for (const c of list) {
    if (!ALLOWED.has(c?.method)) return refuse(c?.id, `method ${String(c?.method)} is not served by this proxy`);
    if (c.method === "getProgramAccounts" && c.params?.[0] !== MANDATE_PROGRAM && !(c.params?.[0] === DLMM_PROGRAM && allowedDlmmScan(c.params)))
      return refuse(c.id, "program scans are limited to the Mandate program and pair-filtered DLMM position headers");
    const why = tooExpensive(c);
    if (why) return refuse(c.id, why);
  }

  const client = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const writes = list.filter((c: any) => c.method === "sendTransaction" || c.method === "requestAirdrop").length;
  const scans = list.filter((c: any) => c.method === "getProgramAccounts").length;
  const cost = list.length + 4 * scans;
  if (!take(`c:${client}`, CLIENT_RATE, cost) || (writes && !take(`w:${client}`, WRITE_RATE, writes)) || !take("global", GLOBAL_RATE, cost))
    return refuse(list[0]?.id, "rate limited: slow down", 429);
  if (running >= MAX_CONCURRENT) return refuse(list[0]?.id, "busy: retry shortly", 503);
  running++;
  try {
    const params = new URL(req.url).searchParams;
    const bypass = params.get("fresh") === "1";
    const net = params.get("cluster") === "mainnet" && CLUSTER !== "mainnet" ? "mainnet" : "default";
    if (net === "mainnet" && list.some((c: any) => WRITES.has(c.method))) return refuse(list[0]?.id, "mainnet access here is read-only");
    const fresh = !Array.isArray(calls) && !bypass ? FRESH_MS[calls.method] : undefined;
    if (!fresh) {
      const r = await forward(body, net);
      return reply(r.status, r.result, "upstream");
    }
    const key = JSON.stringify([net, calls.method, calls.params ?? []]);
    const hit = cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < fresh) return reply(200, withId(hit.result, calls.id), "cache");
    if (hit && age < STALE_MS) {
      // Serve the recent answer now; refresh it once the response is out.
      after(() => load(key, calls, net).catch(() => undefined));
      return reply(200, withId(hit.result, calls.id), "stale");
    }
    const r = await load(key, calls, net);
    return reply(r.status, withId(r.result, calls.id), "upstream");
  } catch (e: any) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`rpc proxy ${ref}: ${redact(e?.message ?? String(e))}`);
    return Response.json({ jsonrpc: "2.0", id: list[0]?.id ?? null, error: { code: -32000, message: `upstream RPC unavailable (ref ${ref})` } }, { status: 502 });
  } finally {
    running--;
  }
}
