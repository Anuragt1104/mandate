/**
 * Background observation. Supabase's scheduler (pg_cron, see
 * supabase/migrations/20260927000000_background_observation.sql) calls this once a minute while
 * some job is due, with a shared secret. Each call leases the due jobs, takes one sample of each
 * with exactly the code the browser observer runs (sdk/src/observe.ts), appends it to the
 * workspace's observation, and draws the job's next random sample time.
 *
 * Reads use the server's RPC endpoints (RPC_UPSTREAM for this app's cluster,
 * RPC_UPSTREAM_MAINNET for mainnet), so keyed URLs stay server-side. A job that keeps failing
 * backs off, and stops after 20 failures in a row with the reason recorded.
 */
import { Connection } from "@solana/web3.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nextSampleIn, sampleOracle, takeSample, type Session } from "../../../../../sdk/src/observe";
import { failoverFetch, PUBLIC_FALLBACKS, redact } from "../../../../../sdk/src/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "localnet";
const MAX_JOBS = 8;
const LEASE_SECS = 90;
const MAX_FAILURES = 20;
const MIN_GAP_SECS = 60;
/** Stop before the observation outgrows the database's size limit for one session. */
const MAX_SESSION_BYTES = 6_000_000;

const conns = new Map<string, Connection>();
function connectionFor(cluster: string): Connection {
  let c = conns.get(cluster);
  if (!c) {
    const endpoints =
      cluster === "mainnet"
        ? [process.env.RPC_UPSTREAM_MAINNET ?? "https://api.mainnet-beta.solana.com"]
        : cluster === CLUSTER
          ? [process.env.RPC_UPSTREAM ?? process.env.NEXT_PUBLIC_RPC_URL ?? "", ...(PUBLIC_FALLBACKS[cluster] ?? [])].filter(Boolean)
          : [`https://api.${cluster}.solana.com`, ...(PUBLIC_FALLBACKS[cluster] ?? [])];
    c = new Connection(endpoints[0], { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: failoverFetch(endpoints, { timeoutMs: 10_000, hedgeMs: 2_500, rounds: 2 }) as any });
    conns.set(cluster, c);
  }
  return c;
}

type Db = SupabaseClient<any, "public", any>;
type Outcome = { id: string; result: "sampled" | "failed" | "stopped" | "skipped"; note?: string };

async function runJob(db: Db, ws: string, id: string): Promise<Outcome> {
  const job = db.from("observation_jobs");
  const { data: row, error } = await db.from("observations").select("session").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (error) return { id, result: "skipped", note: "couldn't read the observation" };
  if (!row) return { id, result: "skipped", note: "observation deleted" };
  const s = row.session as Session;
  if (!["mainnet", "devnet"].includes(s.cluster)) {
    await job.update({ active: false, lease_until: null, stopped_reason: `can't observe ${s.cluster} from the server` }).eq("workspace_id", ws).eq("observation_id", id);
    return { id, result: "stopped", note: s.cluster };
  }
  const { data: state } = await job.select("failures").eq("workspace_id", ws).eq("observation_id", id).maybeSingle();
  const failures = (state as { failures?: number } | null)?.failures ?? 0;

  try {
    const conn = connectionFor(s.cluster);
    await sampleOracle(conn, s);
    const sample = await takeSample(conn, s);
    s.samples.push(sample);
    if (JSON.stringify(s).length > MAX_SESSION_BYTES) {
      s.samples.pop();
      await job.update({ active: false, lease_until: null, stopped_reason: "the observation is full: start a new one to keep going" }).eq("workspace_id", ws).eq("observation_id", id);
      return { id, result: "stopped", note: "full" };
    }
    const saved = await db.from("observations").update({ session: s, samples: s.samples.length }).eq("workspace_id", ws).eq("id", id);
    if (saved.error) throw new Error(`save failed: ${saved.error.message}`);
    const next = new Date(Date.now() + 1000 * Math.max(MIN_GAP_SECS, nextSampleIn(s)));
    await job
      .update({ next_at: next.toISOString(), lease_until: null, failures: 0, last_error: null, last_sample_at: new Date(sample.at * 1000).toISOString() })
      .eq("workspace_id", ws)
      .eq("observation_id", id);
    return { id, result: "sampled", note: sample.problem };
  } catch (e) {
    const why = redact((e as Error)?.message?.split("\n")[0] ?? String(e)).slice(0, 300);
    const n = failures + 1;
    const stop = n >= MAX_FAILURES;
    const backoff = Math.min(30 * 60, 60 * 2 ** Math.min(n, 5));
    await job
      .update({ failures: n, last_error: why, lease_until: null, next_at: new Date(Date.now() + backoff * 1000).toISOString(), ...(stop ? { active: false, stopped_reason: `stopped after ${n} failed reads in a row` } : {}) })
      .eq("workspace_id", ws)
      .eq("observation_id", id);
    return { id, result: stop ? "stopped" : "failed", note: why };
  }
}

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return Response.json({ error: "background observation isn't configured" }, { status: 503 });

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs, error } = await db.rpc("claim_observation_jobs", { max_jobs: MAX_JOBS, lease_secs: LEASE_SECS });
  if (error) {
    console.error("observe: claim failed", redact(error.message));
    return Response.json({ error: "couldn't claim jobs" }, { status: 500 });
  }
  const list = (jobs ?? []) as { workspace_id: string; observation_id: string }[];
  const results = await Promise.all(list.map((j) => runJob(db, j.workspace_id, j.observation_id).catch((e): Outcome => ({ id: j.observation_id, result: "failed", note: redact(String(e)).slice(0, 200) }))));
  for (const r of results) if (r.result !== "sampled") console.log(`observe: ${r.id} ${r.result}${r.note ? `: ${r.note}` : ""}`);
  return Response.json({ claimed: list.length, results: results.map(({ id, result }) => ({ id, result })) });
}
