# scim-sync

Polls the [WorkOS Events API](https://workos.com/docs/events/data-syncing/events-api)
for Directory Sync (SCIM) events and applies each one.

It holds **no database binding**. Directory state is applied by calling the Kilo
app's internal REST endpoints, so the app keeps the advisory locks, the depth
check, the soft-delete side effects and the removal tombstone in one place
rather than growing a second, divergent copy here. See "Mutation endpoints".

What it *does* hold is a Durable Object SQLite database, for the cursor and for
the record of what it could not apply: see "Cursor" and "Parking".

## How it runs

A Durable Object alarm reschedules itself after every poll, so the loop
continues indefinitely without an external trigger. The object hibernates
between ticks, so it is not billed for the waiting time — an always-in-memory
poller would cost roughly 300x more duration for the same work.

| | |
|---|---|
| Idle interval | `SCIM_POLL_INTERVAL_SECONDS`, default 60, clamped to 10..3600 |
| Page size | 100 events, the Events API's documented `limit` maximum |
| Drain budget | ~20 seconds of wall clock per poll, checked before every event |
| Catch-up re-arm | 1 second while pages keep coming back full |
| Failure backoff | the interval doubled per attempt, capped at 5 minutes |
| Event filter | all 10 `dsync.*` types |
| Watchdog | `*/5 * * * *` cron calling `ensureScheduled()` |

The cron only re-arms a loop that died, for example an eviction whose alarm
retries were exhausted. `ensureScheduled()` leaves a live alarm untouched.

The interval is read on every alarm, so changing it takes effect on the first
tick after a deploy. A blank or unparseable value falls back to 60 seconds. The
10-second floor exists because a shorter interval would leave no idle window for
hibernation, billing the object's full 128 MB allocation continuously.

**One poll drains rather than fetching one page.** It keeps requesting the next
page while the previous one came back full and the budget remains, then re-arms
at one second if events probably remain and at the configured interval once a
short page says the stream is caught up. One page per interval is not a rate an
initial sync can be applied at: a real directory's first sync is tens of
thousands of events, which at 10 events a minute is days of backlog. The pages
are still fetched strictly one at a time, because WorkOS prescribes a single
serial consumer that requests the next page only after finishing the current
one.

The budget is checked **before every event**, not only before every page. A
page is up to 100 events and a single `dsync.group.user_added` issues three
sequential calls each bounded by `REQUEST_TIMEOUT_MS`, so a per-page check
alone would let one page run minutes past the budget the alarm schedule is
built on. A drain that stops mid-page leaves the cursor at the last applied
event and reports not caught up, so the one-second re-arm resumes from exactly
there.

100 is the maximum the `limit` parameter accepts: "Accepts values between 1 and
100. Default is 10"
([Events API reference](https://workos.com/docs/reference/events/list)).

## Cursor

The cursor is **Durable Object state**, committed per event, and `sync_state`
holds two rows: `cursor`, the id of the last event every call of which
succeeded, and `seed_cursor`, the `WORKOS_EVENT_CURSOR` value that produced it.

Nothing but a successful event writes `cursor`. So a crash mid-page replays
exactly the last event, which every endpoint is an idempotent upsert for, and
an event that could not be applied holds the cursor where it is
(`.specs/organization-sso.md`, Directory Sync rule 7).

**`WORKOS_EVENT_CURSOR` is the operator's reset action.** The stored cursor
normally wins; the var wins only when it differs from the stored `seed_cursor`,
in which case both rows are rewritten to it. That is what makes changing the var
and redeploying a deliberate rewind, while an unchanged var never overrides a
cursor the loop has advanced — a var that always lost could not reset, and one
that always won would re-apply the same backlog on every deploy. `/status`
reports which source won.

The var can only ever be an event id. `after` and `range_start` are mutually
exclusive in the Events API, so recovery from a cursor older than the 90-day
retention window — `range_start`, which takes an ISO 8601 UTC timestamp with a
`Z` suffix — is a separate operator action rather than a second meaning for this
var.

An override also **clears the held failure**, because the row describes an
event the new cursor may never reach again. Left behind, a forward reset past
a held event would leave `/status.eventFailure` non-null forever — only that
event applying or being parked clears it, and once the cursor is ahead of it
neither can happen — and a rewind *onto* it would carry the old attempt count
and first-failure time into the next attempt, so a conflict could be parked
immediately instead of getting the retry budget the reset was meant to grant. A
reset is a deliberate "start from here", and the held failure does not survive
it. `parked_events` does: those rows are the record of what was skipped, and a
reset is how an operator replays them.

## Parking

An event the loop gives up on is stepped over rather than retried forever: the
cursor advances past it, a row lands in `parked_events`, and the error log
carries the event id, type, class, status and reason. Nothing reads those rows
back; they exist so an event the directory can never satisfy stays recoverable
by an operator instead of being silently lost, and so `/status` can report a
count.

While the loop is stuck, `event_failures` holds exactly one row — the stream is
serial, so a held event blocks everything behind it — carrying the attempt
count and the first failure time. The row is deleted the moment that event
applies, when it is parked, or when `WORKOS_EVENT_CURSOR` resets the stream.
`/status` reports it, which is the thing to look at when the cursor stops
moving.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health` | Worker liveness. Does not touch the Durable Object. |
| `GET /status` | Environment, interval, cursor and its source, the held failure, the parked count, next alarm time, and the last poll result. |

Both routes are unauthenticated, so the Worker has no *HTTP* ingress: no
`workers_dev` hostname, no `routes`, and no service binding. Neither route is
callable in production; read the poll output from Workers Logs, or stream it
with `wrangler tail` — the cron trigger and the alarm both invoke the Worker,
so there is traffic to see. Add
authentication before exposing either route.

## Mutation endpoints

Directory state is written by calling the Kilo app, not by writing Postgres from
here. The endpoints live in `apps/web/src/app/api/internal/scim/`, over
`apps/web/src/lib/scim/directory-sync.ts`, and each one is an idempotent upsert
keyed on a WorkOS identifier, so replaying an event is a no-op.

| Event | Calls, in order |
|---|---|
| `dsync.activated` | `PUT /api/internal/scim/organizations/{directory_id}` |
| `dsync.deleted` | `DELETE /api/internal/scim/organizations/{directory_id}` |
| `dsync.group.created`, `dsync.group.updated` | `PUT /api/internal/scim/sub-organizations/{directory_group_id}` |
| `dsync.group.deleted` | `DELETE /api/internal/scim/sub-organizations/{directory_group_id}` |
| `dsync.user.created`, `dsync.user.updated` with `state: 'active'` | `PUT /api/internal/scim/users/{external_id}` |
| `dsync.user.updated` with `state: 'inactive'`, `dsync.user.deleted` | `DELETE /api/internal/scim/users/{external_id}/memberships` |
| `dsync.group.user_added` | `PUT .../sub-organizations/{id}`, then `PUT .../users/{id}`, then `PUT .../memberships` |
| `dsync.group.user_removed` | `DELETE /api/internal/scim/memberships` |

`dsync.user.deleted` revokes every directory membership and never deletes the
account: there is no user DELETE, because `softDeleteUser` anonymizes the
account and refuses outright when a live subscription exists. An `inactive`
`dsync.user.updated` takes the same route — the identity provider
deprovisioning a person without removing them revokes access rather than
applying attributes. That route converges rather than conflicting: an unknown
`external_id` answers 200 with `kiloUserId: null` and an empty
`revokedOrganizationIds`, so a replay is a no-op.

The membership routes take the `{directoryGroupId, externalId}` pair in the
body, including `DELETE`, because a membership is identified by two WorkOS
identifiers. The revoke-all route takes a body for the same reason: the
directory user is in the path and its `{directoryId}` is in the body, which
scopes the revocation to the directory that emitted the event. Without it, one
tenant's offboarding would delete another tenant's memberships for an account
that belongs to both; `DirectoryUser.directoryId` carries it on the hard
deletion and on the inactive update alike.

The endpoints are reached under `BACKEND_API_URL`, which the staging and
production environments point at `staging-app.kilo.ai` and `app.kilo.ai`
respectively. Calling them also requires `INTERNAL_API_SECRET` in the
`x-internal-api-key` header, bound from the Secrets Store.

**Both sides share one contract module**, `@kilocode/scim-contracts`
(`packages/scim-contracts`). The app validates requests with its schemas and
types its handlers from them; this Worker builds request bodies and parses
responses with the same definitions. They deploy independently and the request
schemas are `z.strictObject`, so an unknown field is a 400 that holds the
cursor rather than a silently dropped key — and a 400 is retryable precisely
so that a Worker deployed ahead of the app waits for it instead of parking
events (see "Response classes"). With a mirrored copy per side that drift
stayed invisible until a real event hit it, and now it is a compile error. A
new field must still land in the package as optional before the Worker starts
sending it, because the app deploys on its own cadence.

The package also owns `TERMINAL_CONFLICT_CODES`, so classifying a new conflict
code is one decision in one place: a code nobody classified fails the
exhaustive record there instead of defaulting to retryable in a Worker copy
that was never updated. Every response is parsed with Zod on the way back in: a
2xx whose body does not match the contract means the two deployments disagree,
which retrying the same payload does not fix.

### Domain capture

`dsync.activated` carries `data.domains[]`, and the organization upsert sends
them as `capturedDomains`. For an organization with **no** `sso_domain`, the
first candidate no other live organization holds becomes it, which is what later
authorizes taking over an existing account on that domain. Directory intake is
administratively gated, so a domain on the event has already passed a human
reviewer — the same authority a manual capture in the dashboard carries.

Four guards, all because a domain is an SSO authority rather than a label:

- An organization that already has a domain keeps it. The SSO domain decides who
  must authenticate through SSO and which addresses a takeover may claim, and
  `data.domains[]` carries no ordering guarantee, so a reordered or extended list
  would otherwise move authority between activations. Replacing one stays a
  dashboard action.
- A domain another live organization holds is skipped, not overwritten. Two
  authorities claiming one domain fails closed for *both*
  (`.specs/organization-sso.md`, Policy Resolution rule 6), so stealing it would
  break authentication for the incumbent.
- The claim is taken under the same `pg_advisory_xact_lock(hashtextextended('sso-domain:' || $domain, 0))`
  that the dashboard's capture uses, so a concurrent human capture cannot
  interleave.
- An event without `domains` says nothing rather than clearing: `dsync.deleted`
  omits the field, and releasing an SSO domain stays a deliberate
  administrative action.

Each capture writes an `organization.sso.set_domain` audit row with a null
actor, which is how this repo records a system-initiated organization change. A
replay that would not change the row writes nothing, so re-running an event does
not append audit noise.

Note that an Okta directory's domain is often the IdP tenant hostname
(`integrator-6483000.okta.com`) rather than the customer's email domain. That is
what WorkOS reports and what gets captured; an address is then bindable, by
takeover or a new account, only on that domain.

### Disconnect

`dsync.deleted` soft-deletes the organization and the sub-organizations carrying
a `directory_group_id`, in one transaction. One transaction matters: committing
the organization first would make a retry find no live unparented row, report
nothing deleted, and never reach the remaining groups — whose `directory_id`
keeps matching group events.

A sub-organization the *customer* created under the same parent carries no
directory binding and is left alone. `markOrganizationAsDeleted` soft-deletes
the organization row but hard-deletes that organization's
`cloud_agent_environments` and `provider_oauth_attempts`, so sweeping one in
would destroy rows that clearing `deleted_at` could not bring back.

Such a child stays parented to the soft-deleted organization, so its effective
SSO policy resolves `misconfigured` with reason `deleted_parent` and fails
closed. That is deliberate: detaching it would leave it with no policy at all
and silently re-admit magic-link sign-ins for members the parent's `sso_domain`
was forcing through SSO. Locked out beats quietly downgraded. The app logs
`[scim] Directory disconnect stranded customer-created sub-organizations` with
the ids, because nothing else distinguishes one from a healthy organization. A
reconnect does not re-adopt it — `dsync.activated` only matches live rows, so it
creates a new organization and the stranded child keeps pointing at the dead
one until an administrator reparents it.

### Arrival order

`dsync.group.user_added` carries the whole user and the whole group
(`data: { directoryId, user: DirectoryUser, group: DirectoryGroup }`), which is
every field the group and user upserts require. So the dispatcher upserts both
from the payload before posting the membership — three idempotent calls, and the
event no longer depends on its `dsync.group.created` and `dsync.user.created`
having been seen first. The two upserts are no-ops in the normal case.

The user upsert's `directoryId` comes from `data.directoryId` on a membership
event and from `data.directoryId` on the `DirectoryUser` itself for
`dsync.user.created` and `dsync.user.updated`. It is required, because the
domain gate resolves the organization from it on every bind.

The directory is deliberately **not** provisioned this way. Nothing in a
`dsync.group.*` payload distinguishes a directory Kilo never activated from one
an administrator disconnected, so backfilling it resurrects the organization and
its groups after a `dsync.deleted`. An unknown directory stays a 409
(`directory_not_found`), which holds the cursor for up to an hour and is then
parked; recovering a lost cursor is an operator action, using `range_start`.

`dsync.group.user_removed` takes no prerequisite calls. An unknown group or user
means there is no membership to revoke, which is what the event asserts, so the
route answers 200 with `removed: false`. Provisioning them would create an
account for a user who is leaving the directory. The accepted cost is that a
removal arriving before its own addition leaves no tombstone to fence the late
addition with — see `.specs/organization-sso.md`, Directory Sync rule 12.

Removal also revokes the **parent** membership once the user holds no other
directory group under it, reported as `revokedParentMembership`. An add writes
two memberships — the group and its parent — because group membership is the
identity provider saying the person belongs to the enterprise. Leaving one of
several groups keeps the parent; leaving the last one does not, or a user
deleted from the directory would keep the enterprise organization's seats and
data. Only directory-bound siblings count, and only a directory-provisioned
account is affected: a membership an administrator created is not directory
sync's to revoke. See Directory Sync rule 4.

An `active` `dsync.user.updated` is not a no-op. A changed name or address is
applied to the bound account. An address change is a move to a different
mailbox, so it carries a first bind's protections: the organization must have
captured the new domain, no other account may hold the address,
`web_session_pepper` is rotated so sessions issued to the mailbox's previous
holder stop authenticating, and `user_auth_provider.email` moves too — it is a
separate source for address lookups, so leaving it behind keeps the old address
resolving to the account. `normalized_email` is rewritten because
`findUserByNormalizedEmail` and the signup dedup read it rather than
`google_user_email`, and `email_domain` through
`extractEmailDomain`, the registrable domain the insert path stores.

The `workos` auth provider row this route writes is keyed on the WorkOS
directory user id, never on `data.idp_id`. `idp_id` is assigned by the
customer's identity provider and is not unique across directories, and account
resolution matches `(provider, provider_account_id)` *before* comparing
addresses — so keying on it let a second directory's user resolve to the first
person's account, silently taking their binding, before the domain gate or the
rebind refusal could run. That row is also not the one an interactive sign-in
matches, which is the WorkOS profile id (`prof_…`); a verified SSO callback
matches by address and replaces it.

### Response classes

Every attempt lands in exactly one of four classes, and the class decides both
the cursor and whether the event survives:

| Class | Cause | Effect |
|---|---|---|
| `applied` | 2xx | Continue to this event's next call, then commit the cursor |
| `conflict` | 409 whose `code` is retryable, or an unrecognized code; an unexpected throw inside the dispatcher | Hold the cursor and retry, bounded by one hour from the first failure, then park |
| `terminal` | a 409 with a terminal `code`, or a payload that cannot be mapped at all | Park immediately |
| `unavailable` | 400, 401, 403, 408, 429, any 3xx, any 5xx, a 2xx whose body does not match the contract, a network error, a timeout | Hold the cursor and retry indefinitely with capped backoff; never park |

The 409 body carries a machine-readable `code`, which is what separates the two
outcomes a conflict can have. Four codes are retryable, because an event
*behind* the cursor can still supply what is missing: `directory_not_found`,
`sub_organization_not_found`, `user_not_found`, and
`user_provisioning_failed`. Four are terminal, because nothing the directory
can send repairs them: `sub_organization_cannot_nest`, `domain_not_captured`,
`account_bound_to_other_directory_user`, and
`address_held_by_another_account`. An unrecognized code is treated as
retryable, which is the direction that cannot lose an event — the retry budget
turns a permanently unsatisfiable one into a park an hour later.

Two payload cases are `terminal` with no HTTP call at all, because no request
body can express them: a directory user whose `email` is null, which the SDK
types nullable and the endpoint requires, and a `dsync.activated` carrying no
`organizationId`.

`unavailable` never parks, and the distinction matters most for a missing or
wrong `INTERNAL_API_SECRET`. That is an operator problem rather than a bad
event, and parking the stream over one would step past every event behind it.

**A 400 is `unavailable`, not terminal**, which is not the obvious reading of
the status. The app's request schemas are `z.strictObject`, so this Worker
deployed ahead of the app — sending a field the app does not yet accept — is
rejected with exactly the status a malformed path or a genuinely bad body
produces, and the loop cannot tell them apart. Deploy skew clears on its own
the minute the app rolls out, and nothing replays `parked_events`, so parking
it would discard events over a condition that resolves itself in minutes. A
bounded `conflict` is wrong for the same reason in a slower form: the skew
window is operational rather than per-event, so the hour could expire
mid-rollout, and a 400 indicts the *request*, which is identical for every
event of that type — so the bounded path would park every event of that shape
in sequence. The cost is that a body no deploy will ever fix holds the stream
indefinitely instead of being stepped over; that is the right side to fail on,
because every body is built from the shared typed contract module with no user
input in it, so a permanently rejected one is a bug in this Worker, which is an
operator problem exactly like a wrong secret. `/status` reports the held
failure with the status and the reason, which is how it gets noticed.

**Redirects are refused, never followed.** `x-internal-api-key` is a custom
header, so it is *not* stripped when a redirect crosses origins: a followed
3xx from `BACKEND_API_URL` or an intermediary in front of it would hand the
shared internal secret to whatever origin the `Location` names, and that
origin's body would then be parsed as the route's response. Every call is
issued with `redirect: 'manual'`, and a 3xx is classified `unavailable` — an
origin or intermediary to fix rather than a statement about the event.

**An unexpected throw inside the dispatcher is an outcome for its own event**,
classified `conflict`. The dispatcher is total, like `callApp`: a throw that
unwound into the poll's single catch would be recorded as a poll-level error
with no event id, no `event_failures` row and an unmoved cursor, so every later
poll would refetch the same event and throw again forever, with nothing in the
held-failure view naming it. `conflict` rather than the two alternatives: a
throw is this Worker failing to build a request, which says nothing about
whether the app can answer, so `unavailable` — which never parks — would hold
the stream on one unreadable payload; but a throw is not proof the event is
unapplicable either, because the SDK passes optional fields through without
defaulting them. `conflict` is the only class that both retries and ends: the
budget gives a transient cause room to clear, and once it is spent the event is
parked with its id, so the loop makes progress.

A 409 is not always recoverable by waiting. A group under a sub-organization is
structural, and a refused address bind is a claim the directory cannot
substantiate — no arrival order fixes either. Holding the cursor behind a
refusal would also stop every later event in the stream, including the
membership removals that take a departing person's access away: one directory
that captured no domain would stall events it does not touch. A refusal is
therefore bounded: the loop retries it up to its retry bound, records the
refusal and the event id it skips, and advances. That id is the replay point for
an administrator who clears the refusal afterwards.

Rule 7 forbids advancing past an event the loop could not apply, and a refusal
is a decided answer rather than a missing dependency: the app evaluated the
event and recorded why it is denied. A loop that applies events must state that
distinction in rule 7 before it skips the first event.

`PUT .../users/{external_id}` carries `directoryId` so it can resolve that
claim. The address is accepted only when its domain equals the Effective SSO
policy domain of the directory's organization — domain capture is what
establishes the enterprise's claim to it — and a pre-existing Kilo account
holding the address is then taken over. The account is converted to the SSO
authority's WorkOS identity, its other authentication providers are dropped and
its browser sessions are invalidated, so the prior holder keeps neither a login
that bypasses SSO nor a live session.

The match is the mailbox, not one spelling of it. The account is resolved
case-insensitively and with `+` aliases and Gmail dots ignored, and that same
row is then converted by its stored address — otherwise a directory delivering
`holder@acme.test` for a row stored as `Holder@acme.test` would miss it and
either 409 forever on the normalized-email dedup or, for a legacy row with no
`normalized_email`, create a second account for one mailbox.

An account already bound to a different directory user is refused rather than
rebound. Overwriting would drop the first identifier, and its later events would
then resolve to no account — which the removal routes report as converged, so it
would fail silently.

Any other address is refused, including when the organization has captured no
domain or its policy is misconfigured. The gate runs whether the address matches
a pre-existing account or would create a new one, so a directory can neither
take over nor mint an account at a domain it does not own. Every SCIM account is
expected to be domain-captured, so a refusal is a real misconfiguration rather
than a race: only the capture clears it. The app logs it as
`[scim] Refused a directory address bind` with the directory and the email
domain, and the 409 body names the domain too — neither carries the address. See
`.specs/organization-sso.md`, Directory Sync rules 13 and 15.

Clearing the refusal is an administrative action on the organization, never a
directory-side one: capture the domain in the organization's SSO settings, or
replay `dsync.activated` carrying `domains` for an organization that has none
(rule 14). Until one of those happens every address the directory provisions is
refused, and each refusal is recorded and skipped rather than held, so later
events keep applying while the organization has no captured domain.

`domain_not_captured` is the code for that refusal, and it is terminal: the loop
parks it rather than retrying something no event will satisfy.
`account_bound_to_other_directory_user` is terminal for the same reason.

The one refusal from this gate that is *not* terminal is a directory with no
live organization, which reports `directory_not_found`. Since the gate runs on
every bind rather than only a takeover, treating that as a refusal would park
every `dsync.user.created` that overtook its `dsync.activated` and never
provision the user.

## Logging

Only envelope fields and failure reasons are logged: `eventId`, `eventType`,
`eventCreatedAt`, the class, the status, the conflict code, and the attempt
count. An event's `data` carries directory user attributes — emails, names, raw
IdP attributes — and is never logged. A park is logged at error level, a held
failure at warn.

## WorkOS client

Uses `@workos-inc/node` (catalog-pinned) rather than hand-rolled requests: its
`exports` map has a first-class `workerd` condition resolving to a
`fetch`-based client with no runtime dependencies, and it supplies the `Event`
and `EventName` types so no local schema is needed. The client is constructed
with `maxRetries: 0`, because the SDK's internal retries would stretch one alarm
across several attempts and hide the failure — the alarm interval is the retry.

That `workerd` build constructs its HTTP client without forwarding the SDK's
`fetchFn` option, so the global `fetch` is the only boundary a test can stub —
which is what the integration tests do, for both origins, rather than the
Worker carrying an injection seam that exists only for tests.

The SDK costs about 500 KiB of bundle (93 KiB gzipped) against a 3 MiB limit.

## Environments

| | Production | Staging |
|---|---|---|
| Worker | `cloudflare-scim-sync` | `cloudflare-scim-sync-staging` |
| `wrangler` env | base config | `--env staging` |
| WorkOS stream | `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` | `WORKOS_API_KEY_STAGING` / `WORKOS_CLIENT_ID_STAGING` |
| App secret | `INTERNAL_API_SECRET_PROD` | `INTERNAL_API_SECRET_STAGING` |
| `BACKEND_API_URL` | `https://app.kilo.ai` | `https://staging-app.kilo.ai` |

The environment is named `staging` because that is the only non-production
`target_environment` `deploy-workers.yml` passes, and it skips any Worker whose
config lacks an `env` of exactly that name. Any other name is a hand-deploy
only.

`vars`, `secrets_store_secrets` and `durable_objects` are not inherited by a
named environment, so `env.staging` restates each one in full;
`compatibility_date`, `triggers`, `migrations`, `observability`, `logpush` and
`workers_dev` are inherited and must stay environment-neutral.

Each environment is a separate Worker script, so each gets its own Durable
Object namespace and its own `v1` SQLite class — there is no shared instance and
no migration-tag conflict between them.

**The WorkOS keys are what separate the environments, not `ENVIRONMENT`.** The
Events API is scoped to whichever WorkOS environment issued the key. Two
deployments holding the same key both consume one stream and both apply the
same events: the cursor is per-deployment Durable Object state, not a lease.
`ENVIRONMENT` is reported by `/status` and otherwise decides nothing.

## Secrets

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and `INTERNAL_API_SECRET` come from the
shared Cloudflare Secrets Store (`342a86d9e3a94da698e82d0c6e2a36f0`, the
account's only store), under the names in the table above. Each is read once
per isolate through `getCachedSecret`, because all three are needed on every
poll.

For local work, create the names the target environment binds — omit `--remote`
and wrangler writes to `.wrangler/` instead of the account:

```sh
for n in WORKOS_API_KEY_STAGING WORKOS_CLIENT_ID_STAGING INTERNAL_API_SECRET_STAGING; do
  npx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 \
    --name "$n" --scopes workers
done
```

A binding for a secret that does not exist fails the deploy, so create all
three staging names before the first `--env staging` deploy.

**`.dev.vars` does not substitute for that.** It overrides `wrangler.jsonc`'s
`vars`, but it does *not* shadow a `secrets_store_secrets` binding: a
`wrangler dev` run with the key only in `.dev.vars` fails every poll with
`Secret "WORKOS_API_KEY_STAGING" not found`. Seed the local store as above.

What `.dev.vars` is for is the rest of the local setup, generated by
`pnpm dev:env -y cloudflare-scim-sync` from `.dev.vars.example`. One entry
there is load-bearing: `pnpm dev` runs `--env staging`, whose `BACKEND_API_URL`
is `staging-app.kilo.ai`, so without the local override a working key would
apply directory state to **staging's** database rather than yours. The example
pins it to local Next.js through `@url nextjs`.

Use a staging or sandbox WorkOS environment for this, never production: the
cursor is per-deployment state rather than a lease, so a production key makes
your machine consume the same stream as the deployed Worker and both apply the
same events.

## Data model

The WorkOS directory hierarchy maps onto the organization hierarchy, and the
app's endpoints are what resolve each identifier:

| WorkOS | Kilo | Binding |
|---|---|---|
| directory | parent organization | `directory_id` |
| directory group | **sub-organization** | `directory_group_id`, `directory_idp_id` |
| directory user | user | `kilocode_users.external_id` |
| group membership | membership on that sub-organization | — |

The binding columns live on every `organizations` row, parent or child, which is
what makes a sub-organization the thing a directory group resolves to. Note that
`directory_id` alone does not identify the organization: a sub-organization
inherits its parent's, so once one group exists a directory matches several live
rows, and the organization is the one with `parent_organization_id IS NULL`.

Kilo's `organization_groups` table is unrelated to WorkOS directory groups. A
group there is a named bundle of policies scoped to one organization, and the
only policy type is `model_access` — modes `all`, `none`, or `selected` with
model and provider allow-lists (`packages/db/src/schema-types.ts:1457-1466`). It
decides which models a member may call: the policies a member's groups carry are
unioned over the org-wide default and enforced in the AI gateway, which denies
the request
(`packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.ts:1065-1070`).
Groups are enterprise-only, administered by an owner or admin, and nothing
populates them from directory sync.

So groups and sub-organizations are orthogonal rather than alternatives: a
sub-organization is a tenant boundary with its own members, credits, and seats,
while a group is a model allow-list inside one organization. A directory group
maps to a sub-organization, not to a row in `organization_groups`.

**One cascade the write path has to account for.**
`organization_group_memberships` holds a composite foreign key into
`organization_memberships` with `ON DELETE CASCADE`, so deleting a membership
also destroys that user's group assignments in that organization — their
model-access grants. Re-adding the membership later does not restore them. A
`dsync.group.user_removed` followed by a re-add therefore loses configuration
that no directory event describes and that WorkOS cannot replay.

### Durable Object state

The loop's own state, in one Durable Object's SQLite database — the namespace
holds exactly one instance, because WorkOS prescribes a single serial consumer.

| Table | Holds |
|---|---|
| `sync_state` | `cursor` and `seed_cursor` |
| `event_failures` | The one event the loop is currently stuck on, with `attempts` and `first_failed_at` |
| `parked_events` | Events it gave up on and stepped over |

Each instance's database is isolated and migrations apply per instance on first
access after a deploy, so there is no centralized migration step. Changing a
deployed class's storage backend is not supported, which is why the class has
been `new_sqlite_classes` since its first deploy.

## Commands

```sh
pnpm dev                 # wrangler dev --env staging, port 8819
pnpm deploy:staging      # wrangler deploy --env staging
pnpm deploy:prod         # wrangler deploy --env=""
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test                # unit tests, Node
pnpm test:integration    # Durable Object tests, Workers runtime
pnpm types               # regenerate worker-configuration.d.ts after config changes
pnpm drizzle-kit generate  # after editing src/db/sqlite-schema.ts
```

`wrangler dev` does not fire cron triggers, so arm the loop by hand. The handler
runs `ensureScheduled`, and the alarm then polls within the second:

```sh
curl http://127.0.0.1:8819/cdn-cgi/handler/scheduled
curl http://127.0.0.1:8819/status
```

The loop's behaviour is this service's own rather than the SDK's, so it is
covered here: `test/integration/` drives the Durable Object through its RPC
under `@cloudflare/vitest-pool-workers`, with the Events API and the app origin
stubbed at the `fetch` boundary, and asserts the cursor, the call order per
event type, and what each response class does. `test/unit/` holds the interval
clamp. The directory *rules* stay covered where they are implemented, in
`apps/web` (`src/app/api/internal/scim/scim-routes.test.ts`,
`src/lib/scim/directory-sync.integration.test.ts`).

A schema change is `src/db/sqlite-schema.ts` plus `pnpm drizzle-kit generate`;
the `drizzle/` SQL, its barrel and its snapshot are generated, never
hand-written, and `migrate()` applies them in `blockConcurrencyWhile` on first
access after a deploy.

## Deployment

Deployed by `deploy-workers.yml`, which auto-discovers any `services/*` folder
containing a `wrangler.jsonc`. The automatic `deploy-production.yml` run starts
when a main `CI` run completes, and `deploy-staging.yml` does the same ahead of
it; an hourly poll covers a missed completion. Both deploy the base config and
`--env staging` from the newest CI-green merge commit.

A merge therefore starts the 5-minute cron and the self-rescheduling alarm in
both environments; there is no separate enablement switch.
