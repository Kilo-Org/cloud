# scim-sync

Polls the [WorkOS Events API](https://workos.com/docs/events/data-syncing/events-api)
for Directory Sync (SCIM) events and logs each one.

**Observe-only, for now.** This Worker still only logs: no directory state is
applied yet, and no users, organizations, or memberships are mutated. The cursor
is configuration, not state — see "Cursor" below.

It holds **no database binding**. Directory state is applied by calling the Kilo
app's internal REST endpoints, so the app keeps the advisory locks, the depth
check, the soft-delete side effects and the removal tombstone in one place
rather than growing a second, divergent copy here.

The write path it will call already exists, in the Kilo app rather than here:
see "Mutation endpoints".

## How it runs

A Durable Object alarm reschedules itself after every poll, so the loop
continues indefinitely without an external trigger. The object hibernates
between ticks, so it is not billed for the waiting time — an always-in-memory
poller would cost roughly 300x more duration for the same work.

| | |
|---|---|
| Interval | `SCIM_POLL_INTERVAL_SECONDS`, default 60, clamped to 10..3600 |
| Page size | 10 events per poll |
| Event filter | all 10 `dsync.*` types |
| Watchdog | `*/5 * * * *` cron calling `ensureScheduled()` |

The cron only re-arms a loop that died, for example an eviction whose alarm
retries were exhausted. `ensureScheduled()` leaves a live alarm untouched.

The interval is read on every alarm, so changing it takes effect on the first
tick after a deploy. A blank or unparseable value falls back to 60 seconds. The
10-second floor exists because a shorter interval would leave no idle window for
hibernation, billing the object's full 128 MB allocation continuously.

## Cursor

`WORKOS_EVENT_CURSOR` is passed as the Events API `after` parameter. Empty means
the request is made without `after`, which returns the oldest available events.

**The cursor does not advance.** It is re-read from configuration on every
tick, so the same events are logged repeatedly until the value is changed and
the Worker redeployed. Each poll logs `lastEventId`, and `/status` reports it, so
the value can be copied forward by hand.

Moving it into Durable Object storage is what the dispatch loop needs: the spec
requires that the cursor never advance past an event that could not be applied
(`.specs/organization-sso.md`, Directory Sync rule 7), and a configured value
cannot express that. The mutation endpoints already answer 409 for exactly that
case.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health` | Worker liveness. Does not touch the Durable Object. |
| `GET /status` | Environment, interval, cursor, next alarm time, and the last poll result. |

Both routes are unauthenticated, so the Worker has no *HTTP* ingress: no
`workers_dev` hostname, no `routes`, and no service binding. Neither route is
callable in production; read the poll output from Workers Logs, or stream it
with `wrangler tail` — unlike the previous iteration, there is now traffic to
see, because the cron trigger and the alarm both invoke the Worker. Add
authentication before exposing either route.

## Mutation endpoints

Directory state is written by calling the Kilo app, not by writing Postgres from
here. The endpoints live in `apps/web/src/app/api/internal/scim/`, over
`apps/web/src/lib/scim/directory-sync.ts`, and each one is an idempotent upsert
keyed on a WorkOS identifier, so replaying an event is a no-op.

| Event | Call |
|---|---|
| `dsync.activated` | `PUT /api/internal/scim/organizations/{directory_id}` |
| `dsync.deleted` | `DELETE /api/internal/scim/organizations/{directory_id}` |
| `dsync.group.created`, `dsync.group.updated` | `PUT /api/internal/scim/sub-organizations/{directory_group_id}` |
| `dsync.group.deleted` | `DELETE /api/internal/scim/sub-organizations/{directory_group_id}` |
| `dsync.user.created`, `dsync.user.updated` | `PUT /api/internal/scim/users/{external_id}` |
| `dsync.group.user_added` | `PUT /api/internal/scim/memberships` |
| `dsync.group.user_removed`, `dsync.user.deleted` | `DELETE /api/internal/scim/memberships` |

`dsync.user.deleted` removes memberships and never deletes the account: there is
no user DELETE, because `softDeleteUser` anonymizes the account and refuses
outright when a live subscription exists. The membership routes take the
`{directoryGroupId, externalId}` pair in the body, including `DELETE`, because a
membership is identified by two WorkOS identifiers.

The endpoints are reached under `BACKEND_API_URL`, which the staging and
production environments point at `staging-app.kilo.ai` and `app.kilo.ai`
respectively. Calling them also requires `INTERNAL_API_SECRET` in the
`x-internal-api-key` header, which this Worker does not yet hold. Request
bodies are `z.strictObject`, so an unknown field is a 400 rather than a
silently dropped one — a new field must land in `directory-sync-contracts.ts`
as optional before the Worker starts sending it.

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
its groups after a `dsync.deleted`. An unknown directory stays a 409; recovering
a lost cursor is an operator action, using `range_start`.

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

`dsync.user.updated` is not a no-op. A changed name or address is applied to the
bound account. An address change is a move to a different mailbox, so it carries
a first bind's protections: the organization must have captured the new domain,
no other account may hold the address, `web_session_pepper` is rotated so
sessions issued to the mailbox's previous holder stop authenticating, and
`user_auth_provider.email` moves too — it is a separate source for address
lookups, so leaving it behind keeps the old address resolving to the account.
`normalized_email` is rewritten because `findUserByNormalizedEmail` and the
signup dedup read it rather than `google_user_email`, and `email_domain` through
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

Three statuses, four outcomes, and they decide cursor movement:

| Status | Meaning | Cursor |
|---|---|---|
| 2xx | Applied, already applied, or nothing to do | Advance |
| 409 | A dependency is missing — an unactivated directory, or a group whose sub-organization is not bound yet | Hold and retry; the body names the dependency |
| 409 | The write is refused — the address is outside the organization's captured domain, an account is bound to another directory user, another account holds the address, or a group would nest under a sub-organization | Bounded retry, then advance and record the refusal |
| 400 / 401 / 5xx | Contract mismatch, missing secret, or an unexpected failure | Hold; 5xx bodies are fixed strings, detail is in the app's log |

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

The two 409 outcomes are told apart by what the body names, not by the status:
it carries `{ error }`, a message naming either the missing dependency or the
refused domain. A stable code in that body is what lets an applying loop move
the cursor without matching prose, and that is still open. Until it lands this
Worker logs events and applies none, and its configured cursor never moves.

## Logging

Only envelope fields are logged: `eventId`, `eventType`, and `eventCreatedAt`.
An event's `data` carries directory user attributes — emails, names, raw IdP
attributes — and is never logged.

## WorkOS client

Uses `@workos-inc/node` (catalog-pinned) rather than hand-rolled requests: its
`exports` map has a first-class `workerd` condition resolving to a
`fetch`-based client with no runtime dependencies, and it supplies the `Event`
and `EventName` types so no local schema is needed. The client is constructed
with `maxRetries: 0`, because the SDK's internal retries would stretch one alarm
across several attempts and hide the failure — the alarm interval is the retry.

The SDK costs about 500 KiB of bundle (93 KiB gzipped) against a 3 MiB limit.

## Environments

| | Production | Staging |
|---|---|---|
| Worker | `cloudflare-scim-sync` | `cloudflare-scim-sync-staging` |
| `wrangler` env | base config | `--env staging` |
| WorkOS stream | `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` | `WORKOS_API_KEY_STAGING` / `WORKOS_CLIENT_ID_STAGING` |
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
deployments holding the same key both consume one stream, and once the write
path lands they would both apply the same events: the cursor is configuration,
not a lease. `ENVIRONMENT` is reported by `/status` and otherwise decides
nothing.

## Secrets

`WORKOS_API_KEY` and `WORKOS_CLIENT_ID` come from the shared Cloudflare Secrets
Store (`342a86d9e3a94da698e82d0c6e2a36f0`, the account's only store), one pair
per WorkOS environment under the names in the table above.

For local work, create the names the target environment binds — omit `--remote`
and wrangler writes to `.wrangler/` instead of the account:

```sh
npx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 \
  --name WORKOS_API_KEY_STAGING --scopes workers
```

A binding for a secret that does not exist fails the deploy, so create both
staging names before the first `--env staging` deploy.

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

## Commands

```sh
pnpm dev              # wrangler dev --env staging, port 8819
pnpm deploy:staging   # wrangler deploy --env staging
pnpm deploy:prod      # wrangler deploy --env=""
pnpm typecheck
pnpm types            # regenerate worker-configuration.d.ts after config changes
```

`wrangler dev` does not fire cron triggers, so arm the loop by hand. The handler
runs `ensureScheduled`, and the alarm then polls within the second:

```sh
curl http://127.0.0.1:8819/cdn-cgi/handler/scheduled
curl http://127.0.0.1:8819/status
```

There are no tests. The poll loop's one branch worth asserting is the interval
clamp; everything else is the SDK's behavior or WorkOS's, and the directory
rules are covered where they are implemented, in `apps/web`
(`src/app/api/internal/scim/scim-routes.test.ts`,
`src/lib/scim/directory-sync.integration.test.ts`).

## Deployment

Deployed by `deploy-workers.yml`, which auto-discovers any `services/*` folder
containing a `wrangler.jsonc`. The automatic `deploy-production.yml` run starts
when a main `CI` run completes, and `deploy-staging.yml` does the same ahead of
it; an hourly poll covers a missed completion. Both deploy the base config and
`--env staging` from the newest CI-green merge commit.

A merge therefore starts the 5-minute cron and the self-rescheduling alarm in
both environments; there is no separate enablement switch.
