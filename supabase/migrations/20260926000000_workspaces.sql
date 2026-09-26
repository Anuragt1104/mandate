-- Mandate workspaces: accounts, teams, and the off-chain work a team keeps (observations,
-- drafts, reports, tracked agreements). Nothing here is authoritative for money: agreements,
-- vaults and scores live on chain; this is the team's record and collaboration layer.
--
-- Access is enforced here, by row-level security, not by the app. Every table is readable by
-- members of its workspace and writable by role:
--   viewer  < manager (edit drafts, observations, reports) < admin (members, invitations) < owner
-- Membership changes, invitations and workspace creation go through security-definer
-- functions so the rules (last owner, token hashing, role ceilings) hold in one place.

create extension if not exists pgcrypto with schema extensions;

create type public.workspace_role as enum ('viewer', 'manager', 'admin', 'owner');
create type public.workspace_kind as enum ('team', 'operator');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  kind public.workspace_kind not null default 'team',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user on public.memberships (user_id);

-- Only the sha256 of an invitation token is stored; the token itself is shown once.
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text check (email is null or char_length(email) <= 254),
  role public.workspace_role not null check (role <> 'owner'),
  token_hash text not null unique,
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_by uuid references auth.users (id),
  accepted_at timestamptz
);
create index invitations_workspace on public.invitations (workspace_id);

-- Wallets a workspace acts through (the team's issuer wallet, the operator's maker wallet).
create table public.workspace_wallets (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  address text not null check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  label text check (char_length(label) <= 80),
  added_by uuid references auth.users (id),
  added_at timestamptz not null default now(),
  primary key (workspace_id, address)
);

-- On-chain agreements this workspace follows, with its side of each.
create table public.agreements (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  mandate text not null check (mandate ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster text not null check (cluster in ('devnet', 'mainnet', 'localnet')),
  side text not null check (side in ('team', 'operator', 'observer')),
  label text check (char_length(label) <= 120),
  added_by uuid references auth.users (id),
  added_at timestamptz not null default now(),
  primary key (workspace_id, mandate)
);

-- An observation session (sdk/src/observe.ts Session) as the browser recorded it.
create table public.observations (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  label text not null check (char_length(label) <= 160),
  pair text not null,
  owner text,
  cluster text not null,
  samples integer not null default 0,
  session jsonb not null check (pg_column_size(session) < 2000000),
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  primary key (workspace_id, id)
);

-- A draft (sdk/src/draft.ts DraftDoc) and the link it travels as. Approvals inside the doc
-- are wallet signatures that every reader re-verifies; storing them here adds no trust.
create table public.drafts (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  title text not null check (char_length(title) <= 160),
  status text not null check (char_length(status) <= 120),
  doc jsonb not null check (pg_column_size(doc) < 500000),
  link text not null check (char_length(link) <= 60000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  primary key (workspace_id, id)
);

-- A frozen report: an observation report or a renewal/closing report as shared.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('observation', 'renewal', 'closing')),
  subject text not null check (char_length(subject) <= 160),
  link text not null check (char_length(link) <= 60000),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index reports_workspace on public.reports (workspace_id, created_at desc);

create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor uuid,
  action text not null,
  subject text,
  detail jsonb,
  at timestamptz not null default now()
);
create index audit_workspace on public.audit_events (workspace_id, at desc);

-- ---------------------------------------------------------------------------------------------
-- Role checks. Security definer so policies on memberships don't recurse through themselves.

create function public.role_rank(r public.workspace_role) returns int
language sql immutable as $$
  select case r when 'viewer' then 1 when 'manager' then 2 when 'admin' then 3 when 'owner' then 4 end
$$;

create function public.has_role(ws uuid, at_least public.workspace_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and public.role_rank(m.role) >= public.role_rank(at_least)
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security.

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.workspace_wallets enable row level security;
alter table public.agreements enable row level security;
alter table public.observations enable row level security;
alter table public.drafts enable row level security;
alter table public.reports enable row level security;
alter table public.audit_events enable row level security;

-- Profiles: your own, and those of people you share a workspace with.
create policy profiles_read on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.memberships a join public.memberships b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = profiles.id
  )
);
create policy profiles_write on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy workspaces_read on public.workspaces for select to authenticated using (public.has_role(id, 'viewer'));
create policy workspaces_rename on public.workspaces for update to authenticated using (public.has_role(id, 'admin')) with check (public.has_role(id, 'admin'));
create policy workspaces_delete on public.workspaces for delete to authenticated using (public.has_role(id, 'owner'));
-- Creation goes through create_workspace(), which also makes the creator the owner.

create policy memberships_read on public.memberships for select to authenticated using (public.has_role(workspace_id, 'viewer'));
-- Leaving: anyone may remove themselves (leave_workspace() guards the last owner).
-- Role changes and removals go through set_member_role() / remove_member().

create policy invitations_read on public.invitations for select to authenticated using (public.has_role(workspace_id, 'admin'));
create policy invitations_revoke on public.invitations for delete to authenticated using (public.has_role(workspace_id, 'admin'));

-- Work tables: members read, managers write, admins delete.
do $$
declare t text;
begin
  foreach t in array array['workspace_wallets', 'agreements', 'observations', 'drafts', 'reports'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.has_role(workspace_id, ''viewer''))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.has_role(workspace_id, ''manager''))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.has_role(workspace_id, ''manager'')) with check (public.has_role(workspace_id, ''manager''))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.has_role(workspace_id, ''admin''))', t);
  end loop;
end $$;

create policy audit_read on public.audit_events for select to authenticated using (public.has_role(workspace_id, 'viewer'));
-- No insert policy: events are written only by the triggers and functions below.

-- ---------------------------------------------------------------------------------------------
-- Audit trail.

create function public.audit(ws uuid, act text, subj text, det jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (workspace_id, actor, action, subject, detail) values (ws, auth.uid(), act, subj, det)
$$;
revoke execute on function public.audit(uuid, text, text, jsonb) from public, anon, authenticated;

create function public.audit_work() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  perform public.audit((r ->> 'workspace_id')::uuid, tg_table_name || '.' || lower(tg_op),
    coalesce(r ->> 'mandate', r ->> 'address', r ->> 'id'),
    case tg_table_name
      when 'drafts' then jsonb_build_object('status', r ->> 'status', 'title', r ->> 'title')
      when 'observations' then jsonb_build_object('label', r ->> 'label', 'samples', (r ->> 'samples')::int)
      when 'reports' then jsonb_build_object('kind', r ->> 'kind', 'subject', r ->> 'subject')
    end);
  return null;
end $$;

-- Observations are saved on every sample; audit only their creation and deletion.
create trigger audit_drafts after insert or update or delete on public.drafts for each row execute function public.audit_work();
create trigger audit_observations after insert or delete on public.observations for each row execute function public.audit_work();
create trigger audit_agreements after insert or delete on public.agreements for each row execute function public.audit_work();
create trigger audit_wallets after insert or delete on public.workspace_wallets for each row execute function public.audit_work();
create trigger audit_reports after insert or delete on public.reports for each row execute function public.audit_work();

-- Stamp who last changed a row; clients can't forge it.
create function public.stamp_updated() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger stamp_drafts before insert or update on public.drafts for each row execute function public.stamp_updated();
create trigger stamp_observations before insert or update on public.observations for each row execute function public.stamp_updated();

create function public.stamp_added() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.added_by := auth.uid();
  return new;
end $$;
create trigger stamp_agreements before insert on public.agreements for each row execute function public.stamp_added();
create trigger stamp_wallets before insert on public.workspace_wallets for each row execute function public.stamp_added();

create function public.stamp_created() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := auth.uid();
  return new;
end $$;
create trigger stamp_reports before insert on public.reports for each row execute function public.stamp_created();

-- A profile for every new account.
create function public.on_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)))
  on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.on_new_user();

-- ---------------------------------------------------------------------------------------------
-- Workspace and membership operations.

create function public.create_workspace(ws_name text, ws_kind public.workspace_kind default 'team') returns uuid
language plpgsql security definer set search_path = '' as $$
declare ws uuid; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if (select count(*) from public.memberships where user_id = uid and role = 'owner') >= 20 then
    raise exception 'too many workspaces' using errcode = '54000';
  end if;
  insert into public.workspaces (name, kind, created_by) values (trim(ws_name), ws_kind, uid) returning id into ws;
  insert into public.memberships (workspace_id, user_id, role) values (ws, uid, 'owner');
  perform public.audit(ws, 'workspace.create', trim(ws_name), jsonb_build_object('kind', ws_kind));
  return ws;
end $$;

-- Returns the plaintext token once; only its hash is kept.
create function public.create_invitation(ws uuid, invite_role public.workspace_role, invite_email text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare token text;
begin
  if not public.has_role(ws, 'admin') then raise exception 'admins only' using errcode = '42501'; end if;
  if invite_role = 'owner' then raise exception 'invite as admin, then transfer ownership' using errcode = '22023'; end if;
  if (select count(*) from public.invitations where workspace_id = ws and accepted_at is null and expires_at > now()) >= 50 then
    raise exception 'too many open invitations' using errcode = '54000';
  end if;
  token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.invitations (workspace_id, email, role, token_hash, invited_by)
  values (ws, nullif(lower(trim(invite_email)), ''), invite_role, encode(extensions.digest(token, 'sha256'), 'hex'), auth.uid());
  perform public.audit(ws, 'invitation.create', nullif(lower(trim(invite_email)), ''), jsonb_build_object('role', invite_role));
  return token;
end $$;

create function public.accept_invitation(token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invitations; uid uuid := auth.uid(); mail text;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into inv from public.invitations
  where token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
  for update;
  if inv.id is null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'this invitation is invalid, used or expired' using errcode = '22023';
  end if;
  if inv.email is not null then
    select lower(email) into mail from auth.users where id = uid;
    if mail is distinct from inv.email then
      raise exception 'this invitation is for a different email address' using errcode = '42501';
    end if;
  end if;
  update public.invitations set accepted_by = uid, accepted_at = now() where id = inv.id;
  insert into public.memberships (workspace_id, user_id, role) values (inv.workspace_id, uid, inv.role)
  on conflict (workspace_id, user_id) do update
    set role = case when public.role_rank(excluded.role) > public.role_rank(public.memberships.role) then excluded.role else public.memberships.role end;
  perform public.audit(inv.workspace_id, 'membership.join', uid::text, jsonb_build_object('role', inv.role));
  return inv.workspace_id;
end $$;

create function public.set_member_role(ws uuid, member uuid, new_role public.workspace_role) returns void
language plpgsql security definer set search_path = '' as $$
declare mine public.workspace_role; theirs public.workspace_role;
begin
  select role into mine from public.memberships where workspace_id = ws and user_id = auth.uid();
  select role into theirs from public.memberships where workspace_id = ws and user_id = member;
  if mine is null or public.role_rank(mine) < public.role_rank('admin') then raise exception 'admins only' using errcode = '42501'; end if;
  if theirs is null then raise exception 'not a member' using errcode = '22023'; end if;
  -- Only owners grant or take away ownership, and admins can't manage other admins.
  if (new_role = 'owner' or theirs = 'owner') and mine <> 'owner' then raise exception 'owners only' using errcode = '42501'; end if;
  if theirs = 'admin' and mine <> 'owner' and member <> auth.uid() then raise exception 'owners only' using errcode = '42501'; end if;
  if theirs = 'owner' and new_role <> 'owner'
     and (select count(*) from public.memberships where workspace_id = ws and role = 'owner') = 1 then
    raise exception 'a workspace needs an owner' using errcode = '22023';
  end if;
  update public.memberships set role = new_role where workspace_id = ws and user_id = member;
  perform public.audit(ws, 'membership.role', member::text, jsonb_build_object('from', theirs, 'to', new_role));
end $$;

create function public.remove_member(ws uuid, member uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare mine public.workspace_role; theirs public.workspace_role;
begin
  select role into mine from public.memberships where workspace_id = ws and user_id = auth.uid();
  select role into theirs from public.memberships where workspace_id = ws and user_id = member;
  if theirs is null then return; end if;
  if member <> auth.uid() then
    if mine is null or public.role_rank(mine) < public.role_rank('admin') then raise exception 'admins only' using errcode = '42501'; end if;
    if theirs in ('owner', 'admin') and mine <> 'owner' then raise exception 'owners only' using errcode = '42501'; end if;
  end if;
  if theirs = 'owner' and (select count(*) from public.memberships where workspace_id = ws and role = 'owner') = 1 then
    raise exception 'a workspace needs an owner: transfer ownership or delete the workspace' using errcode = '22023';
  end if;
  delete from public.memberships where workspace_id = ws and user_id = member;
  perform public.audit(ws, case when member = auth.uid() then 'membership.leave' else 'membership.remove' end, member::text, null);
end $$;

-- Members of a workspace with their names and emails, for its members page.
create function public.workspace_members(ws uuid)
returns table (user_id uuid, role public.workspace_role, display_name text, email text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.role, p.display_name, u.email::text, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = ws and public.has_role(ws, 'viewer')
  order by public.role_rank(m.role) desc, m.created_at
$$;

revoke execute on function public.create_workspace(text, public.workspace_kind) from public, anon;
revoke execute on function public.create_invitation(uuid, public.workspace_role, text) from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
revoke execute on function public.set_member_role(uuid, uuid, public.workspace_role) from public, anon;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
revoke execute on function public.workspace_members(uuid) from public, anon;
grant execute on function public.create_workspace(text, public.workspace_kind) to authenticated;
grant execute on function public.create_invitation(uuid, public.workspace_role, text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, public.workspace_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.workspace_members(uuid) to authenticated;
