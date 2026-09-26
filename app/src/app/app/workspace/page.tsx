"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Copy, Download, Plus, UserPlus } from "lucide-react";
import { can, cloud, why, type Role } from "@/lib/cloud";
import { browserOnly, importInto, syncError, useLocalVersion } from "@/lib/local";
import { copyText, docFromLink } from "@/lib/drafts";
import { useAccount } from "@/components/account";
import { ago } from "@/components/ui";

interface Member { user_id: string; role: Role; display_name: string | null; email: string | null; joined_at: string }
interface Invite { id: string; email: string | null; role: Role; created_at: string; expires_at: string; accepted_at: string | null }
interface Event { id: number; action: string; subject: string | null; detail: { title?: string; label?: string; role?: string; to?: string } | null; at: string; actor: string | null }

const ROLE_HELP: Record<Role, string> = {
  viewer: "reads everything",
  manager: "edits drafts, observations and reports",
  admin: "also manages members and invitations",
  owner: "also manages admins and can delete the workspace",
};

const ACTION: Record<string, string> = {
  "workspace.create": "created the workspace",
  "invitation.create": "invited",
  "membership.join": "joined",
  "membership.role": "changed a role",
  "membership.leave": "left",
  "membership.remove": "removed a member",
  "drafts.insert": "added a draft",
  "drafts.update": "updated a draft",
  "drafts.delete": "deleted a draft",
  "observations.insert": "started an observation",
  "observations.delete": "deleted an observation",
  "agreements.insert": "followed an agreement",
  "reports.insert": "saved a report",
};

/** The open workspace: who's in it, inviting people, bringing browser work in, and what changed. */
export default function WorkspacePage() {
  const acct = useAccount();
  const ws = acct.current;
  const router = useRouter();
  const path = usePathname();
  /** On a workspace URL, switching means going to the other workspace's URL. */
  const switchTo = (id: string) => (path.startsWith("/app/w/") ? router.push(`/app/w/${id}/settings`) : acct.open(id));
  useLocalVersion();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"team" | "operator">("team");
  const [inviteRole, setInviteRole] = useState<Role>("manager");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const now = Math.floor(Date.now() / 1000);

  const load = useCallback(async () => {
    const sb = cloud();
    if (!sb || !ws) return;
    const [m, i, e] = await Promise.all([
      sb.rpc("workspace_members", { ws: ws.id }),
      can(ws.role, "admin") ? sb.from("invitations").select("id, email, role, created_at, expires_at, accepted_at").eq("workspace_id", ws.id).is("accepted_at", null).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      sb.from("audit_events").select("id, action, subject, detail, at, actor").eq("workspace_id", ws.id).order("at", { ascending: false }).limit(30),
    ]);
    const err = m.error ?? i.error ?? e.error;
    setError(err ? why(err) : null);
    setMembers((m.data ?? []) as Member[]);
    setInvites((i.data ?? []) as Invite[]);
    setEvents((e.data ?? []) as Event[]);
  }, [ws?.id, ws?.role]);
  useEffect(() => {
    setInviteLink(null);
    load();
  }, [load]);

  async function act(f: () => PromiseLike<{ error: unknown }>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await f();
      if (r.error) setError(why(r.error));
      else after?.();
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!acct.enabled || (!acct.loading && !acct.user)) {
    return (
      <>
        <div className="page-head"><div><span className="eyebrow">Workspace</span><h1 className="h1">Work together on drafts and reports</h1></div></div>
        <div className="card" style={{ maxWidth: 620 }}>
          <div className="card-body" style={{ display: "grid", gap: 12 }}>
            <span className="small">A workspace keeps your team&apos;s observations, drafts and reports in one place that colleagues and your operator can open, with roles for who may change what.</span>
            {acct.enabled ? <Link className="btn btn-primary" href="/app/account" style={{ justifySelf: "start" }}>Sign in</Link> : <span className="xs muted">Accounts aren&apos;t set up on this deployment; work stays in this browser.</span>}
          </div>
        </div>
      </>
    );
  }
  if (acct.loading) return null;

  const create = (
    <form
      className="row"
      style={{ gap: 8, flexWrap: "wrap" }}
      onSubmit={(e) => {
        e.preventDefault();
        let created: string | null = null;
        act(
          async () => {
            const r = await cloud()!.rpc("create_workspace", { ws_name: name.trim(), ws_kind: kind });
            created = (r.data as string) ?? null;
            return r;
          },
          async () => {
            setName("");
            setCreating(false);
            if (created) acct.open(created);
            await acct.refresh();
            if (created) router.push(`/app/w/${created}/settings`);
          },
        );
      }}
    >
      <input className="input" style={{ flex: "1 1 220px" }} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kite Labs" aria-label="Workspace name" />
      <select className="input" style={{ flex: "0 0 auto", width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as "team" | "operator")} aria-label="Workspace type">
        <option value="team">Token team</option>
        <option value="operator">Market operator</option>
      </select>
      <button className="btn btn-primary" disabled={busy || !name.trim()}><Plus />Create workspace</button>
    </form>
  );

  if (!ws) {
    return (
      <>
        <div className="page-head"><div><span className="eyebrow">Workspace</span><h1 className="h1">Create your workspace</h1><p className="muted" style={{ margin: 0 }}>Name it after your project or firm. You can invite people once it exists.</p></div></div>
        <div className="card" style={{ maxWidth: 620 }}><div className="card-body" style={{ display: "grid", gap: 10 }}>{create}{(error ?? acct.error) && <div className="notice" role="alert">{error ?? acct.error}</div>}</div></div>
      </>
    );
  }

  const local = browserOnly();
  const localCount = local.sessions.length + local.drafts.length;
  const admin = can(ws.role, "admin");
  const owner = ws.role === "owner";
  const who = (id: string | null) => members.find((m) => m.user_id === id)?.display_name ?? "Someone";

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">{ws.kind === "operator" ? "Operator workspace" : "Team workspace"} · you are {ws.role === "admin" || ws.role === "owner" ? "an" : "a"} {ws.role}</span>
          <h1 className="h1">{ws.name}</h1>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {acct.workspaces.length > 1 && (
            <select className="input" style={{ width: "auto" }} value={ws.id} onChange={(e) => switchTo(e.target.value)} aria-label="Switch workspace">
              {acct.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <button className="btn btn-secondary" onClick={() => setCreating((x) => !x)}><Plus />New workspace</button>
        </div>
      </div>

      <div className="stack">
        {creating && <div className="card"><div className="card-body">{create}</div></div>}
        {(error ?? acct.error ?? syncError()) && <div className="notice" role="alert">{error ?? acct.error ?? syncError()}</div>}

        {localCount > 0 && (
          <div className="card">
            <div className="card-head"><span className="h3">Work in this browser only</span><span className="xs muted">{local.sessions.length} observations · {local.drafts.length} drafts</span></div>
            <div className="card-body row-between" style={{ gap: 12, flexWrap: "wrap" }}>
              <span className="small muted" style={{ maxWidth: "60ch" }}>Started before you signed in. Import it so it&apos;s kept in {ws.name} and your team can open it.</span>
              {can(ws.role, "manager") ? (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const r = await importInto(ws.id, docFromLink);
                    setBusy(false);
                    setImported(r.failed.length ? `Imported ${r.moved}. Not imported: ${r.failed.join("; ")}` : `Imported ${r.moved} into ${ws.name}.`);
                    load();
                  }}
                >
                  <Download />{busy ? "Importing…" : "Import work from this browser"}
                </button>
              ) : <span className="xs muted">Viewers can&apos;t add work; ask an admin for the manager role.</span>}
            </div>
          </div>
        )}
        {imported && <div className="notice" role="status">{imported}</div>}

        <div className="card">
          <div className="card-head"><span className="h3">Members</span><span className="xs muted">{members.length}</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th className="r">Joined</th><th /></tr></thead>
              <tbody>
                {members.map((m) => {
                  const self = m.user_id === acct.user?.id;
                  const editable = !self && admin && (owner || (m.role !== "owner" && m.role !== "admin"));
                  return (
                    <tr key={m.user_id}>
                      <td><b>{m.display_name ?? "Unnamed"}</b>{self && <span className="xs muted"> (you)</span>}<div className="xs muted">{m.email ?? "wallet account"}</div></td>
                      <td>
                        {editable ? (
                          <select className="input" style={{ width: "auto" }} value={m.role} disabled={busy} onChange={(e) => act(() => cloud()!.rpc("set_member_role", { ws: ws.id, member: m.user_id, new_role: e.target.value }))} aria-label={`Role of ${m.display_name ?? "member"}`}>
                            {(["viewer", "manager", "admin", ...(owner ? ["owner"] : [])] as Role[]).map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        ) : <span className="small">{m.role}</span>}
                      </td>
                      <td className="r xs muted">{ago(Math.max(0, now - Date.parse(m.joined_at) / 1000))}</td>
                      <td className="r">
                        {(editable || self) && (
                          <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act(() => cloud()!.rpc("remove_member", { ws: ws.id, member: m.user_id }), self ? () => acct.refresh().then(() => router.push("/app")) : undefined)}>{self ? "Leave" : "Remove"}</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {admin && (
          <div className="card">
            <div className="card-head"><span className="h3">Invite someone</span><span className="xs muted">links work once and expire in 7 days</span></div>
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              <form
                className="row"
                style={{ gap: 8, flexWrap: "wrap" }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError(null);
                  const { data, error } = await cloud()!.rpc("create_invitation", { ws: ws.id, invite_role: inviteRole, invite_email: inviteEmail.trim() || null });
                  setBusy(false);
                  if (error) setError(why(error));
                  else {
                    setInviteLink(`${window.location.origin}/app/join#t=${data}`);
                    setInviteEmail("");
                  }
                  load();
                }}
              >
                <input className="input" style={{ flex: "1 1 220px" }} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="Their email (optional: limits who can use the link)" aria-label="Email" />
                <select className="input" style={{ width: "auto" }} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Role">
                  {(["viewer", "manager", "admin"] as Role[]).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button className="btn btn-primary" disabled={busy}><UserPlus />Create invitation link</button>
              </form>
              <span className="xs muted">A {inviteRole} {ROLE_HELP[inviteRole]}.</span>
              {inviteLink && (
                <div className="notice" style={{ display: "grid", gap: 6 }}>
                  <span className="small">Send this link yourself. It&apos;s shown once; Mandate keeps only a fingerprint of it.</span>
                  <div className="row" style={{ gap: 8 }}>
                    <input className="input mono xs" readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
                    <button className="btn btn-secondary btn-sm" onClick={() => copyText(inviteLink)}><Copy />Copy</button>
                  </div>
                </div>
              )}
              {invites.length > 0 && (
                <div style={{ display: "grid", gap: 6 }}>
                  <span className="label">Open invitations</span>
                  {invites.map((i) => (
                    <div key={i.id} className="row-between small" style={{ gap: 10 }}>
                      <span>{i.email ?? "Anyone with the link"} · {i.role}{Date.parse(i.expires_at) < Date.now() && <span className="muted"> · expired</span>}</span>
                      <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act(() => cloud()!.from("invitations").delete().eq("id", i.id))}>Revoke</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-head"><span className="h3">Recent activity</span></div>
          <div className="card-body" style={{ display: "grid", gap: 6 }}>
            {events.length === 0 && <span className="small muted">Nothing yet.</span>}
            {events.map((e) => (
              <div key={e.id} className="row-between small" style={{ gap: 10 }}>
                <span><b>{who(e.actor)}</b> {ACTION[e.action] ?? e.action}{(() => {
                  const d = e.detail?.title ?? e.detail?.label ?? (e.action === "membership.role" ? `to ${e.detail?.to}` : e.action === "invitation.create" ? `${e.subject ?? "by link"} as ${e.detail?.role}` : null);
                  return d ? <span className="muted"> · {d}</span> : null;
                })()}</span>
                <span className="xs muted">{ago(Math.max(0, now - Date.parse(e.at) / 1000))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
