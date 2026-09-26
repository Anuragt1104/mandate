-- Background observation: a workspace's observation keeps sampling after its browser tab
-- closes. The app's /api/observe route takes the samples (the same SDK code the browser runs)
-- and writes them into the observation; this file keeps the schedule.
--
-- Timing stays unpredictable to the operator: each job's next sample is drawn at random by the
-- route (uniform on [0, 2 × period / checks], at least a minute apart), and pg_cron only asks
-- the route to run when some job is due, so an idle system makes no calls at all.

create table public.observation_jobs (
  workspace_id uuid not null,
  observation_id text not null,
  active boolean not null default true,
  next_at timestamptz not null default now(),
  lease_until timestamptz,
  ends_at timestamptz not null default now() + interval '30 days',
  runs integer not null default 0,
  failures integer not null default 0,
  last_run_at timestamptz,
  last_sample_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  stopped_reason text check (char_length(stopped_reason) <= 200),
  started_by uuid references auth.users (id),
  started_at timestamptz not null default now(),
  primary key (workspace_id, observation_id),
  foreign key (workspace_id, observation_id) references public.observations (workspace_id, id) on delete cascade
);
create index observation_jobs_due on public.observation_jobs (next_at) where active;

alter table public.observation_jobs enable row level security;
create policy observation_jobs_read on public.observation_jobs for select to authenticated using (public.has_role(workspace_id, 'viewer'));
-- Writes go through set_background_observation() (people) and the service role (the route).

-- Start or stop background observation of one of the workspace's observations.
create function public.set_background_observation(ws uuid, obs text, turn_on boolean, days integer default 30) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(ws, 'manager') then raise exception 'managers only' using errcode = '42501'; end if;
  if not exists (select 1 from public.observations where workspace_id = ws and id = obs) then
    raise exception 'save the observation to this workspace first' using errcode = '22023';
  end if;
  if turn_on then
    if (select count(*) from public.observation_jobs where workspace_id = ws and active and observation_id <> obs) >= 5 then
      raise exception 'a workspace can observe at most 5 arrangements in the background' using errcode = '54000';
    end if;
    insert into public.observation_jobs (workspace_id, observation_id, started_by, ends_at)
    values (ws, obs, auth.uid(), now() + make_interval(days => least(greatest(days, 1), 90)))
    on conflict (workspace_id, observation_id) do update
      set active = true, next_at = now(), lease_until = null, failures = 0, last_error = null, stopped_reason = null,
          started_by = auth.uid(), started_at = now(), ends_at = excluded.ends_at;
  else
    update public.observation_jobs set active = false, lease_until = null, stopped_reason = 'stopped by a member'
    where workspace_id = ws and observation_id = obs;
  end if;
  perform public.audit(ws, case when turn_on then 'observation.background_on' else 'observation.background_off' end, obs, null);
end $$;
revoke execute on function public.set_background_observation(uuid, text, boolean, integer) from public, anon;
grant execute on function public.set_background_observation(uuid, text, boolean, integer) to authenticated;

-- For the route (service role only): lease the due jobs so overlapping runs never double-sample.
create function public.claim_observation_jobs(max_jobs integer, lease_secs integer)
returns table (workspace_id uuid, observation_id text)
language plpgsql security definer set search_path = '' as $$
begin
  update public.observation_jobs j set active = false, stopped_reason = 'reached its end date'
  where j.active and j.ends_at <= now();
  return query
  update public.observation_jobs j set lease_until = now() + make_interval(secs => lease_secs), last_run_at = now(), runs = j.runs + 1
  from (
    select c.workspace_id, c.observation_id from public.observation_jobs c
    where c.active and c.next_at <= now() and (c.lease_until is null or c.lease_until < now())
    order by c.next_at
    limit least(max_jobs, 20)
    for update skip locked
  ) due
  where j.workspace_id = due.workspace_id and j.observation_id = due.observation_id
  returning j.workspace_id, j.observation_id;
end $$;
revoke execute on function public.claim_observation_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_observation_jobs(integer, integer) to service_role;

-- While the server observes, a browser can't overwrite the session (a stale tab would drop
-- samples). Renaming it is still fine.
create function public.guard_background_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and new.session is distinct from old.session
     and exists (select 1 from public.observation_jobs j where j.workspace_id = old.workspace_id and j.observation_id = old.id and j.active) then
    raise exception 'this observation runs in the background; stop background observation to change it here' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger guard_background_session before update on public.observations for each row execute function public.guard_background_session();

-- The trigger. The route's URL and shared secret live in Vault (set by scripts/supabase-cron.ts),
-- never in this file.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.schedule('mandate-observe', '* * * * *', $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'mandate_observe_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'mandate_observe_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000)
      where exists (select 1 from public.observation_jobs where active and next_at <= now())
        and exists (select 1 from vault.decrypted_secrets where name = 'mandate_observe_url')
    $cron$);
  end if;
end $$;
