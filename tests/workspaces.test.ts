import { expect } from "chai";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

/**
 * The workspace schema's access rules, run against real Postgres (PGlite) with a minimal
 * stand-in for what Supabase provides: the anon/authenticated roles, auth.users, and auth.uid()
 * from the request's JWT subject.
 */
const MIGRATION = path.join(process.cwd(), "supabase", "migrations", "20260926000000_workspaces.sql");
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";

describe("workspaces schema and row-level security", () => {
  let db: PGlite;
  let ws: string;

  type Out = { rows?: any[]; err?: string };
  async function as(uid: string | null, sql: string, params: unknown[] = []): Promise<Out> {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false); set role ${uid ? "authenticated" : "anon"};`);
    try {
      return { rows: (await db.query(sql, params)).rows as any[] };
    } catch (e) {
      return { err: (e as Error).message };
    } finally {
      await db.exec("reset role");
    }
  }

  before(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`
      create role anon nologin; create role authenticated nologin;
      create schema extensions; create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth, extensions to authenticated, anon;
      alter default privileges in schema public grant all on tables to authenticated, anon;
      alter default privileges in schema public grant all on sequences to authenticated, anon;
    `);
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${A}', 'a@x.io', '{"full_name":"Ana"}'), ('${B}', 'b@x.io', '{}'), ('${C}', 'c@x.io', '{}')`);
    ws = (await as(A, "select public.create_workspace('Kite team') as id")).rows![0].id;
  });

  after(async () => db.close());

  it("makes the creator the owner and hides the workspace from everyone else", async () => {
    expect((await as(A, "select role from memberships where workspace_id = $1", [ws])).rows![0].role).to.equal("owner");
    expect((await as(B, "select * from workspaces")).rows).to.have.length(0);
    expect((await as(B, "insert into drafts (workspace_id, id, title, status, doc, link) values ($1, 'd1', 't', 's', '{}', 'l')", [ws])).err).to.be.a("string");
    expect((await as(B, "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, B])).err).to.be.a("string");
    expect((await as(null, "select public.create_workspace('x')")).err).to.be.a("string");
  });

  it("invitations: hashed, bound to the email, single use, expiring, never owner", async () => {
    const tok = (await as(A, "select public.create_invitation($1, 'viewer', 'b@x.io') as t", [ws])).rows![0].t as string;
    expect(tok).to.have.length(48);
    expect((await as(A, "select token_hash from invitations")).rows![0].token_hash).to.not.equal(tok);
    expect((await as(C, "select public.accept_invitation($1)", [tok])).err).to.match(/different email/);
    expect((await as(B, "select public.accept_invitation($1)", [tok])).err).to.be.undefined;
    expect((await as(B, "select public.accept_invitation($1)", [tok])).err).to.be.a("string");
    expect((await as(A, "select public.create_invitation($1, 'owner')", [ws])).err).to.be.a("string");
    const open = (await as(A, "select public.create_invitation($1, 'manager') t", [ws])).rows![0].t;
    await db.exec(`update invitations set expires_at = now() - interval '1 minute' where accepted_at is null`);
    expect((await as(C, "select public.accept_invitation($1)", [open])).err).to.be.a("string");
  });

  it("viewers read but can't write, invite or escalate", async () => {
    expect((await as(B, "select count(*)::int n from workspaces")).rows![0].n).to.equal(1);
    expect((await as(B, "insert into drafts (workspace_id, id, title, status, doc, link) values ($1, 'd1', 't', 's', '{}', 'l')", [ws])).err).to.be.a("string");
    expect((await as(B, "select public.set_member_role($1, $2, 'owner')", [ws, B])).err).to.be.a("string");
    expect((await as(B, "select public.create_invitation($1, 'admin')", [ws])).err).to.be.a("string");
    expect((await as(B, "select * from invitations")).rows).to.have.length(0);
  });

  it("managers write work with server-stamped authorship but can't delete", async () => {
    expect((await as(A, "select public.set_member_role($1, $2, 'manager')", [ws, B])).err).to.be.undefined;
    expect((await as(B, "insert into drafts (workspace_id, id, title, status, doc, link, updated_by) values ($1, 'd1', 't', 'Awaiting approval', '{}', 'l', $2)", [ws, A])).err).to.be.undefined;
    expect((await as(B, "select updated_by from drafts")).rows![0].updated_by).to.equal(B);
    expect((await as(B, "delete from drafts where id = 'd1' returning id")).rows).to.have.length(0);
    expect((await as(B, "insert into observations (workspace_id, id, label, pair, cluster, session, started_at) values ($1, 's1', 'SOL/USDC', 'P', 'mainnet', '{}', now())", [ws])).err).to.be.undefined;
  });

  it("keeps an audit trail nobody can forge", async () => {
    const acts = (await as(A, "select action from audit_events order by id")).rows!.map((r) => r.action);
    expect(acts).to.include.members(["workspace.create", "invitation.create", "membership.join", "membership.role", "drafts.insert", "observations.insert"]);
    expect((await as(B, "insert into audit_events (workspace_id, action) values ($1, 'forged')", [ws])).err).to.be.a("string");
  });

  it("lists members only to members, and a workspace always keeps an owner", async () => {
    const members = (await as(A, "select display_name, role from public.workspace_members($1)", [ws])).rows!;
    expect(members.map((m) => m.display_name)).to.include("Ana");
    expect((await as(C, "select * from public.workspace_members($1)", [ws])).rows).to.have.length(0);
    expect((await as(A, "select public.remove_member($1, $2)", [ws, A])).err).to.match(/needs an owner/);
    expect((await as(B, "select public.remove_member($1, $2)", [ws, A])).err).to.be.a("string");
    expect((await as(B, "select public.remove_member($1, $2)", [ws, B])).err).to.be.undefined;
    expect((await as(B, "select count(*)::int n from drafts")).rows![0].n).to.equal(0);
  });
});
