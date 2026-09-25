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
 */
import { after } from "next/server";
import { failoverFetch, PUBLIC_FALLBACKS } from "../../../../../sdk/src/rpc";

export const runtime = "edge";

const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "localnet";
const PRIMARY = process.env.RPC_UPSTREAM ?? process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const FALLBACKS = process.env.RPC_UPSTREAM_FALLBACKS?.split(",").filter(Boolean) ?? PUBLIC_FALLBACKS[CLUSTER] ?? [];
const upstream = failoverFetch([PRIMARY, ...FALLBACKS], { timeoutMs: 8_000, hedgeMs: 1_200, rounds: 2 });

const MANDATE_PROGRAM = "3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn";
const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "getSignaturesForAddress", "getTransaction", "getSignatureStatuses", "getLatestBlockhash", "isBlockhashValid", "getFeeForMessage",
  "getMinimumBalanceForRentExemption", "getRecentPrioritizationFees", "getSlot", "getBlockHeight", "getBlockTime", "getEpochInfo",
  "getGenesisHash", "getVersion", "getHealth", "sendTransaction", "simulateTransaction", "requestAirdrop",
]);

/** How long a read stays fresh, and how long a stale copy may stand in while it refreshes. */
const FRESH_MS: Record<string, number> = {
  getAccountInfo: 4_000, getMultipleAccounts: 4_000, getProgramAccounts: 6_000, getSignaturesForAddress: 4_000,
  getTokenAccountBalance: 4_000, getBalance: 4_000, getTransaction: 3_600_000, getBlockTime: 3_600_000,
  getMinimumBalanceForRentExemption: 3_600_000, getGenesisHash: 86_400_000, getVersion: 600_000,
};
const STALE_MS = 90_000;
const cache = new Map<string, { at: number; status: number; result: string }>();
const inflight = new Map<string, Promise<{ status: number; result: string }>>();

function refuse(id: unknown, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message } });
}

async function forward(body: string): Promise<{ status: number; result: string }> {
  const res = await upstream("", { method: "POST", headers: { "content-type": "application/json" }, body });
  return { status: res.status, result: await res.text() };
}

/** One upstream request per distinct call at a time; successful answers are cached. */
function load(key: string, call: any): Promise<{ status: number; result: string }> {
  let p = inflight.get(key);
  if (!p) {
    p = forward(JSON.stringify({ ...call, id: 1 }))
      .then((r) => {
        if (r.status === 200 && !/"error"\s*:/.test(r.result.slice(0, 200))) cache.set(key, { at: Date.now(), ...r });
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
    if (c.method === "getProgramAccounts" && c.params?.[0] !== MANDATE_PROGRAM) return refuse(c.id, "program scans are limited to the Mandate program");
  }

  try {
    const fresh = !Array.isArray(calls) ? FRESH_MS[calls.method] : undefined;
    if (!fresh) {
      const r = await forward(body);
      return reply(r.status, r.result, "upstream");
    }
    const key = JSON.stringify([calls.method, calls.params ?? []]);
    const hit = cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < fresh) return reply(200, withId(hit.result, calls.id), "cache");
    if (hit && age < STALE_MS) {
      // Serve the recent answer now; refresh it once the response is out.
      after(() => load(key, calls).catch(() => undefined));
      return reply(200, withId(hit.result, calls.id), "stale");
    }
    const r = await load(key, calls);
    return reply(r.status, withId(r.result, calls.id), "upstream");
  } catch (e: any) {
    return Response.json({ jsonrpc: "2.0", id: list[0]?.id ?? null, error: { code: -32000, message: `upstream RPC unavailable: ${e?.message ?? e}` } }, { status: 502 });
  }
}
