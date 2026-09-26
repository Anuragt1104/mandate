# Accounts and workspaces

Mandate works without an account: observations and drafts stay in the browser that made them
and travel as links. Accounts add **workspaces**, where a team (or an operator firm) keeps that
work together with roles. Agreements, vaults, scores and money stay on chain; the workspace is a
record and collaboration layer and never holds keys or funds.

## What's stored

| Table | Holds |
|---|---|
| `workspaces`, `memberships` | who is in which workspace, as viewer / manager / admin / owner |
| `invitations` | pending invitations; only the sha256 of each token is stored |
| `observations` | observation sessions (`sdk/src/observe.ts`), written at most once a minute while running |
| `drafts` | draft documents and their links; approvals inside are wallet signatures every reader re-verifies |
| `reports`, `agreements`, `workspace_wallets` | shared reports, followed agreements, the wallets a workspace acts through |
| `audit_events` | who did what; written only by database triggers and functions |

Access is enforced in Postgres with row-level security
(`supabase/migrations/20260926000000_workspaces.sql`), not by the app: members read, managers
write, admins manage members and invitations, owners manage admins. A workspace always keeps an
owner. `tests/workspaces.test.ts` runs these rules against real Postgres (PGlite).

The app talks to Supabase directly from the browser as the signed-in user with the public
anon/publishable key; no service-role key is used by the app.

## Setup

1. Add Supabase to the Vercel project (Vercel dashboard → the `mandate` project → Storage or
   Integrations → Supabase, or `vercel integration add supabase`). This creates the Supabase
   project and adds `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to Vercel.
2. Apply the migration: paste `supabase/migrations/20260926000000_workspaces.sql` into the
   Supabase SQL editor and run it, or `supabase db push` with the Supabase CLI linked to the
   project.
3. In Supabase → Authentication → URL configuration, set the Site URL to the production URL and
   add `https://<production-domain>/app/**` and `http://localhost:3000/app/**` as redirect URLs.
4. Sign-in methods (Authentication → Providers):
   - **Email** is on by default (sign-in link; add `{{ .Token }}` to the magic-link template to
     also show a code).
   - **Web3 wallet → Solana**: turn it on for "Sign in with a Solana wallet".
   - **Google**: needs a Google OAuth client ID and secret.
5. Redeploy so the public settings are built into the app.

## In the app

- `/app/account`: sign in with email, Google or a Solana wallet. The sign-in wallet and the
  signing wallet can differ: approvals and transactions are always signed by a connected wallet.
- `/app/workspace`: create or switch workspaces, members and roles, invitation links, importing
  work from this browser, recent activity.
- `/app/join#t=…`: accept an invitation. The token rides in the URL fragment so it never reaches
  a server log. An invitation with an email can only be accepted by that email's account.
- With a workspace open, the Overview, Monitoring, and Reports and drafts pages show that
  workspace's work, and new observations and drafts are saved to it. Signing out removes
  workspace copies from the browser.

## Workspace links

`/app/w/<workspace id>` (overview), `/monitoring`, `/reports` and `/settings` under it open that
workspace for anyone who is a member, so links can be shared inside a team. Non-members are told
they aren't in the workspace; nothing of it is shown. The sidebar uses these links whenever a
workspace is open.

## Background observation

A manager can hand an observation to Mandate ("Observe in the background" on its page) for 3–30
days. The server then samples it at random times with the same code the browser runs
(`sdk/src/observe.ts`), whether or not any tab is open; the page shows the server's copy and
keeps its own observer off, and the database refuses browser overwrites while the job runs.
At most 5 per workspace. Failures back off and stop after 20 in a row, with the reason shown.

Pieces: `observation_jobs` and its functions
(`supabase/migrations/20260927000000_background_observation.sql`), the route
`app/src/app/api/observe/route.ts`, and a pg_cron job that calls the route once a minute only
while some job is due. Mainnet reads use `RPC_UPSTREAM_MAINNET` (set a paid key there; public
RPC works but is rate limited), devnet reads use `RPC_UPSTREAM`.

Setup, once:

1. Run `supabase/migrations/20260927000000_background_observation.sql` in the SQL editor.
2. Database → Extensions: make sure `pg_cron` and `pg_net` are enabled, then re-run the last
   block of that file (the `cron.schedule` part) if the schedule wasn't created
   (`select * from cron.job` shows `mandate-observe`).
3. Make a random secret (e.g. `openssl rand -hex 32`) and store it in two places:
   - Vercel → mandate → Settings → Environment Variables: `CRON_SECRET` (Production, sensitive).
   - Supabase SQL editor:
     `select vault.create_secret('<secret>', 'mandate_observe_secret');`
     `select vault.create_secret('https://mandate-lac-rho.vercel.app/api/observe', 'mandate_observe_url');`
4. Redeploy so the route sees `CRON_SECRET`.
