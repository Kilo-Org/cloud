# migration-proxy

Applies the shared Postgres migrations (`packages/db/src/migrations`) for the deploy workflows'
`db-gate` job (design Q64a; contract `migration-proxy-contract.md`, revision 8). CI holds no
database credential: the job sends its GitHub OIDC token, STS attests it, and the proxy applies
exactly what is on `main` at an attested commit.

- **Worker** `migration-proxy` (`https://migration-proxy.kiloapps.io`, production) and
  `migration-proxy-staging` (`env.staging`). Routes: `POST /v1/runs`, `GET /v1/runs/{id}`.
- **`MigrationRunDO`**: one SQLite object per environment, addressed only as `runs` in the EU
  jurisdiction. It is the single-run lock and holds the runs, the blob and GitHub caches, the
  recorded session pairs and the audit outbox. It owns the one container (`ctx.container`).
- **Container** (`container/`): Node 24 with `pg` and drizzle-orm, one Postgres session per run
  with `verify-full` TLS against `ca-bundle.pem` (only the Supabase Root 2021 CA). A standalone
  package outside the pnpm workspace: its own `pnpm-lock.yaml`, exact pins, a digest-pinned base
  image, pnpm pinned by sha512, built from `container/` alone. HTTP(S) out is refused by two
  intercepts registered before `start()`; Postgres TCP stays open.

## API

`POST /v1/runs` with `Authorization: Bearer <GitHub OIDC token, proxy audience>` and
`{"sha":"<40 hex>"}` (at most 1 KB):

| HTTP | Body |
|---|---|
| 202 | `{"status":"accepted","run":RunView}` |
| 200 | `{"status":"existing","run":RunView}`: the newest run of this `run_id`+`run_attempt`, when active, succeeded, or failed with `retryable: false` |
| 200 | `{"status":"already_applied","run":RunView}`: `sha` is the newest succeeded sha or an ancestor of it |
| 400 / 413 | `{"status":"invalid_request"}` |
| 401 | `{"status":"denied","reason":"identity_rejected"}` |
| 403 | `{"status":"denied","reason":R}`: `unknown_workload`, `environment_mismatch`, `grant_not_allowed`, `caller_not_allowed` (STS); `claim_mismatch`, `sha_not_on_main`, `sha_not_attested`; `sha_behind_attempted` and `sha_diverged` also carry `attemptedSha` |
| 409 | `{"status":"busy","activeRunId":"<uuid>","retryAfterSeconds":30}` with `Retry-After` |
| 429 | `{"status":"limited","reason":"rate_limited"\|"too_many_attempts","retryAfterSeconds":N}` |
| 500 | `{"status":"config_invalid"}`: a refused config (below); not retryable |
| 503 | `{"status":"unavailable","reason":"sts_unavailable"\|"github_unavailable","retryAfterSeconds":N}` |

`GET /v1/runs/{id}` authenticates the same way and answers `RunView` or 404 `{"status":"not_found"}`.

**States:** `pending` (phases `fetching`, `reviewing`, `starting`, `probing`), `running` (phase
`migrating`, from the moment the probe passes), `succeeded` / `failed` (phase `done`). `failure` is
`{code, retryable, sqlstate, migrationTag}` plus `reason` for `probe_failed`, `indexes` for
`invalid_index_present` and `files` for `migration_not_approved`. The view never carries a
Postgres message, SQL, host or user name.

`heartbeatAt` is when the container last answered `/status`: it shows the container is up, not
that the statement makes progress. A blocked `CONCURRENTLY` build keeps a fresh heartbeat; look
at `pg_stat_activity` and `pg_stat_progress_create_index` for progress.

**Operator notes.**
- A config that becomes invalid while a run is active (a bad deploy) stops the object's ticks:
  the run stays `pending`/`running` and the container keeps working until the config is fixed and
  the next tick reads its status. Fix `wrangler.jsonc` first, then let CI poll.
- A container that is up but stops answering `/status` (or answers for no run, or another run)
  ends `container_lost` after 8 ticks (2 minutes); a container that is gone, after 2 ticks.
- A start the runtime refuses, an `/apply` that times out (30 s) or answers anything but 202,
  counts as a stalled start; 5 in a row end `container_start_failed`.
- Each GitHub call has 30 s, body included; past that it counts as GitHub being unavailable.
- Invocation logs are off (`observability.logs.invocation_logs: false`): Cloudflare documents
  them as holding the request and response details
  (https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
  and does not document that the `Authorization` header is left out, so a GitHub OIDC token
  could be kept for 7 days. The Worker's own `console` lines stay on.

## Failure codes

| Code | Retryable | What to do |
|---|---|---|
| `github_unavailable`, `container_start_failed`, `leftover_not_ended`, `lock_busy`, `container_lost` | yes | CI re-POSTs once |
| `probe_failed` (`connect_timeout`, `tls_verify_failed`, `not_primary`) | yes | CI re-POSTs once |
| `migration_failed` with `57014`, `55P03`, `40P01`, `40001`, `08*` | yes | CI re-POSTs once |
| `probe_failed` (`auth_failed`, `wrong_role`) | no | Fix the login (setup, rotation) |
| `migration_failed` (other sqlstate), `journal_invalid`, `journal_order_invalid` | no | Fix forward with a commit (`packages/db/AGENTS.md`) |
| `invalid_index_present` | no | Runbook below |
| `migration_not_approved`, `migration_not_reviewed`, `owners_unreadable`, `owners_mismatch` | no, pages | A code owner approves the merged content (a follow-up PR touching the same file), or a revert; for a database behind the review base, lower `MIGRATION_REVIEW_BASELINE_SHA`; for `owners_mismatch`, make `.github/CODEOWNERS` and `src/owners.ts` agree in one reviewed PR |
| `deadline_exceeded` | no | The run passed 6 h; see "Cancelling a run" |
| `config_invalid` (HTTP 500) | no | Fix `wrangler.jsonc` in a reviewed PR |

## Configuration

Every environment rule derives from `MIGRATION_PROXY_ENVIRONMENT` (`src/config.ts`), which also
fixes the identity the attestation re-check expects (`ci-db-migrate` on `deploy-production.yml`,
or `ci-db-migrate-staging` on `deploy-staging.yml`).

| Var | Production | Staging |
|---|---|---|
| `MIGRATION_DB_LOGIN_MODE` | `member` (the only mode production accepts) | `direct` |
| `MIGRATION_DB_USER` | `kilo_migration_proxy` (or `.<ref>` through a pooler; nothing else is accepted) | `postgres` |
| `MIGRATION_SESSION_KEY` | `label` | `pid` (required in direct mode) |
| `MIGRATION_SESSION_SAMPLE_MINUTES` | `60` | `0` (required in direct mode) |
| `MIGRATION_DB_TARGET` | the direct host, `<host>:5432/postgres` (set by setup) | `db.xrcpuwfztrhiazsslhuu.supabase.co:5432/postgres` |
| `MIGRATION_PROXY_GITHUB_APP_ID`, `..._INSTALLATION_ID`, `MIGRATION_REVIEW_BASELINE_SHA` | set by setup | set by setup |

Until setup fills the empty values, every request answers `config_invalid`. The bundle
(`/workloads/migration-proxy`) holds `MIGRATION_PROXY_DB_PASSWORD` and
`MIGRATION_PROXY_GITHUB_APP_KEY`; production's password is the `kilo_migration_proxy` one, never
`postgres`'s. The password reaches the container only in the `/apply` body.

## Owner-approval check

Before the container starts, every path under `packages/db/src/migrations/` that changed since the
review base (the newest succeeded run's sha, or `MIGRATION_REVIEW_BASELINE_SHA` for the first run)
must be the exact blob a pinned code owner (`src/owners.ts`, by GitHub user id), other than the
PR's author, approved in the merged PR that last changed it. The CODEOWNERS migrations line must
name exactly the pinned logins. Passes are cached per `(path, blob)`; a PR's reviews are re-read by
each run.

## Costs

At most 24 production runs a day; per run one STS call per request, up to 4 GitHub compares, 5+
tree reads and only new blobs, about 8 GitHub calls per changed migration PR, one alarm every 15 s,
one database connection (the login's limit of 2 leaves room for one leftover), and 2 + N audit
rows. The container (`basic`) costs about $0.17 at most for a 6-hour run and under $1 a month of
runs; the hourly sampled check about $0.30 a month per environment.

## Runbooks

**Rotation (rotation phase; then every 90 days or on suspicion).**
1. Confirm no run is active: the newest `ai.kilo.migration_proxy.run_started` has a matching
   `run_finished`:
   `['kilo-audit'] | where type startswith 'ai.kilo.migration_proxy.run_' | summarize started = countif(type endswith 'run_started'), finished = countif(type endswith 'run_finished') by tostring(data.attributes.runId) | where finished == 0`
   (no row means nothing is running).
2. As `postgres`, with statement logging and pgaudit off for the session (the password passes
   through one `set_config` statement) and never with `psql -a` or `-e`, which echo statements:
   `MIGRATION_PROXY_DB_PASSWORD="$(openssl rand -base64 48 | tr -d '\n')" PGOPTIONS='-c log_statement=none -c pgaudit.log=none' psql "<target, sslmode=verify-full sslrootcert=services/migration-proxy/container/ca-bundle.pem>" -v ON_ERROR_STOP=1 -v block=rotate -f services/migration-proxy/sql/setup-login.sql`.
   A missing password makes psql exit non-zero.
3. Write the password to Infisical; the bundle reaches the object within about 8 minutes.
4. Dispatch no deploy for 10 minutes (a run in that window fails `auth_failed`; the next passes).
5. After the first rotation, add the Axiom annotation the 90-day monitor reads.

**Emergency stop (member mode).** `ALTER ROLE kilo_migration_proxy NOLOGIN;` then
`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'kilo_migration_proxy';`.
Deploys now fail `auth_failed`. To restore: rotate (above), then `ALTER ROLE kilo_migration_proxy LOGIN;`.
In staging, remove `MIGRATION_PROXY_DB_PASSWORD` from the staging bundle or pause staging deploys;
never set `postgres` `NOLOGIN`.

**Invalid index (`invalid_index_present`).** Check that no build runs on it
(`SELECT * FROM pg_stat_progress_create_index`), then `DROP INDEX CONCURRENTLY <name>` in the SQL
editor, and redeploy. An invalid index that a pending migration rebuilds with
`DROP INDEX CONCURRENTLY IF EXISTS` is allowed: that is the designed retry.

**Cancelling a run.** There is no cancel API. First cancel the GitHub Actions job that waits on
the run, so CI makes no retry POST. Then cancel its backend in the SQL editor
(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = 'kilo-migration-proxy:<runId>'`);
the run fails `migration_failed` with `57014`, which stays retryable because a `statement_timeout`
raises the same code: a CI job still waiting would POST once more and start the run again.

**A fresh database.** A new database, or one restored from empty, cannot be migrated by the proxy
alone: on main's journal `0035_third_shiver_man` has a lower `when` than `0034_bouncy_whizzer`,
and the proxy refuses pending entries out of `when` order (`journal_order_invalid`, contract §5
step 4), which protects a partly applied run from skipping 0035 on retry. Seed the database first
from a trusted operator machine with `pnpm drizzle migrate` (all of it), or drizzle-kit with the
journal cut after 0035; the proxy applies everything after. The local e2e's differential does
exactly this and matches a plain `pnpm drizzle migrate` row for row and in `pg_dump
--schema-only`.

**`sha_behind_attempted` / `sha_diverged`.** A newer commit was already tried. Dispatch the deploy
again so `check-deployment-changes` picks the newest CI-green commit; if that attempt failed for
good, fix forward with a new commit. Never deploy the older commit by hand.

**A paging sample or `unexpectedSessions`.** A session of the login that is not a recorded
`(pid, backend_start)` pair of a run or sample pages. A container that died before its first
`/status` leaves such a labelled session:
1. Match its label (`kilo-migration-proxy:<runId>` or `:sample:<sampleId>`) to a run whose
   `run_finished` says `container_lost`, or to a sample with no `session_sampled` event.
2. If it matches, end it in the SQL editor: `SELECT pg_terminate_backend(<pid>)`.
3. If nothing matches, treat it as a compromise and run the emergency stop.

## Tests

- `pnpm test`: the Worker and object suites (fake STS, GitHub and container) and the repository
  checks (config barriers against the real `wrangler.jsonc`, the one-object rule, the standalone
  container package, the CA bundle, the owner-approval check, the journal). `journal.ts` tests the
  journal's own rules; the out-of-order pending case (`journal_order_invalid`) is tested in
  `test/container/member.test.ts`, since only the container knows the database's newest
  `created_at`.
- `pnpm test:container`: Docker. Builds the image and runs it against `supabase/postgres:15.8.1.135`
  in member mode (override with `SUPABASE_PG_IMAGE=<tag>`) and `supabase/postgres:17.6.1.127` in
  direct mode.
- `test/e2e/run.sh`: the local e2e of contract §10 step 5 under `wrangler dev` with the container,
  a fake STS and a fake GitHub (see the script's header).

## Residual risks (accepted, not fixed here)

- The two-person rule excludes only the PR author: any other pinned owner's approval counts.
- A remembered pass is keyed by `(path, blob)`, not by approver: removing an owner does not
  re-check paths an owner already passed.
- An unauthenticated flood reaches the object (each refusal is one write per reason and actor per
  minute); a WAF rule in front of the route comes later.
- Refusals before authentication (a malformed body, an oversized one) are not audited.
- `session_terminated` can be lost when the container dies before the object reads its status.
- Raw TCP out of the container stays open; only HTTP(S) is refused.
- The blob, GitHub and verdict caches are never pruned (a few hundred small rows a year).
