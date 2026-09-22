# BYOC Stage 1 — Customer-paid Vercel

**Date:** 2026-08-25

**Base:** `sticky-slider` at `989ae31740fef1128f05e9a221edfcd66547a43b`

**Status:** Ready for implementation after the Slice 0 provider spike passes

This plan adds an organization-scoped Vercel credential to the call-home
control plane. New sessions for an enrolled organization run in isolated
Vercel sandboxes paid for by that organization.

The plan deliberately optimizes for a small, supportable MVP:

- one credential and one Vercel project per Kilo organization;
- one Vercel sandbox per Cloud Agent session;
- no fallback from BYOC Vercel to Kilo-paid Vercel;
- immediate hard deletion when the organization removes its credential;
- no credential versions, soft revocation, key rotation, or background purge;
- a Durable Object for the long-running snapshot build, with durable
  reconciliation around provider side effects;
- the current Kilo token behavior is accepted for Stage 1.

Canonical runtime rules remain in `CALL-HOME-CONTROL-PLANE.md`. Background and
future architecture are in `docs/byoc-architecture-research.md`.

---

## 1. Scope

### 1.1 User-visible flow

An organization owner or admin can:

1. Open organization compute settings.
2. Enter a Vercel token, team ID, and project ID.
3. Start setup. Kilo validates access, builds one runtime snapshot in the
   customer's project, boots a disposable child from it, and shows progress.
4. Kilo enables the organization in the server-side pilot allowlist after
   setup reaches `ready`; there is no second customer-facing toggle.
5. Start new Cloud Agent sessions. Each new session receives a distinct
   `ses-*` sandbox in the configured Vercel project.
6. Remove the credential after acknowledging that Kilo immediately loses
   control of existing BYOC sandboxes and old sessions will stop working.

The removal confirmation links to the configured Vercel project and tells the
user to open **Observability -> Sandboxes** so they can inspect or stop running
sandboxes first. After removal, when the project details are no longer
available, error and empty states link to the generic Vercel dashboard.

### 1.2 Explicit non-goals

- Shared owner sandboxes for BYOC.
- Personal-account BYOC.
- E2B, Modal, or additional keyed providers.
- Automatic provider fallback for a session bound to BYOC.
- Editing or replacing a credential in place. The flow is remove, then add.
- Credential history, soft revocation, grace periods, or restore.
- Encryption-key or Vercel-token rotation workflows.
- Discovering and stopping every Vercel sandbox during credential removal.
- Hiding `KILOCODE_TOKEN` from a customer's Vercel project administrators.
- A second retry system outside Durable Object alarms.
- Terminal/PTTY work beyond what call-home already provides.

### 1.3 Existing building blocks to reuse

Do not reimplement:

| Capability | Current location |
|---|---|
| Provider contract | `services/cloud-agent-next/src/sandbox-control/provider.ts` |
| Kilo-paid Vercel adapter | `services/cloud-agent-next/src/sandbox-control/vercel-provider.ts` |
| Vercel REST client and `inspectByName` recovery | `services/cloud-agent-next/src/agent-sandbox/vercel/vercel-sandbox-rest-client.ts` |
| Snapshot build commands and validation sequence | `services/cloud-agent-next/scripts/vercel-snapshot.ts` |
| Physical lifecycle and deadlines | `services/cloud-agent-next/src/persistence/SandboxControl.ts` |
| Per-session runtime owner | `services/cloud-agent-next/src/sandbox-session/SandboxSession.ts` |
| Existing Cloud Agent server-to-server client | `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts` |
| Existing RSA envelope helpers | `@kilocode/encryption`, re-exported by web and Cloud Agent |
| Existing Kilo token containment path | `KILOCODE_TOKEN_CONTAINMENT_ORG_IDS` and the session materialization code |

---

## 2. Required invariants

These are acceptance criteria, not suggestions.

### 2.1 Provider identity is closed and persistent

A session records exactly one provider source at registration:

```ts
type SandboxProviderBinding =
  | { kind: 'cloudflare' }
  | { kind: 'vercel'; source: { kind: 'platform' } }
  | {
      kind: 'vercel';
      source: {
        kind: 'byoc';
        organizationId: string;
        credentialId: string;
      };
    };
```

The BYOC pointer is required in the BYOC branch. It must not be modeled as an
optional property on `{ kind: 'vercel' }`, because that would allow a missing
pointer to fall through to the worker-global `VERCEL_TOKEN`.

The binding is stored with session workspace metadata and passed to
`SandboxControl`. `SandboxControl` pins and compares the complete binding, not
only the provider name.

Consequences:

- Cloudflare, Kilo-paid Vercel, and BYOC Vercel are unambiguous.
- A missing/deleted BYOC row is a terminal configuration error.
- Existing sessions do not change provider when settings or enrollment change.
- BYOC never consumes Kilo's Vercel credentials by accident.

### 2.2 BYOC is per session

For a BYOC binding, `generateSandboxRoutingTarget` always returns the existing
isolated `ses-{hash(sessionId)}` shape. Do not add BYOC organizations to
`PER_SESSION_SANDBOX_ORG_IDS`; BYOC is intrinsically isolated and must not
alter their Cloudflare behavior.

This avoids repinning a shared `SandboxControl` between provider sources. The
accepted MVP trade-off is one customer-paid VM and one cold start per open
session.

### 2.3 Credential removal is immediate and fail closed

Removal means:

1. Authorize the caller as an owner/admin of the organization.
2. Hard-delete the organization's credential row in PostgreSQL.
3. Return success once that delete commits.

No application component may retain the token or encrypted envelope outside
the PostgreSQL credential row:

- do not store either in Durable Object storage;
- do not put either in session metadata;
- do not cache a decrypted provider adapter between operations;
- do not log request bodies, auth headers, envelopes, or plaintext tokens;
- keep plaintext only in operation-local scope and drop references when the
  operation completes; JavaScript memory zeroization is not promised.

After deletion, the next provider operation re-reads the credential, receives
`404`, and fails with `byoc_credential_missing`. It must not fall back.

An operation already executing at deletion time may finish with credentials
already held in memory. Immediate cancellation of in-flight network calls is
not promised. Encrypted database backups follow the platform's normal backup
retention; Stage 1 does not introduce backup rewriting or cryptographic erasure.

Existing provider-side resources remain in the customer's Vercel account.
Kilo cannot safely enumerate or stop them after deleting the token. The UI must
say this plainly and direct the user to Vercel. If the user needs the token
itself invalidated at Vercel, they must revoke it there.

### 2.4 PostgreSQL is configuration and UI projection; the DO runs builds

The web application owns authorization, credential creation/removal, and the
status shown in settings. The per-organization `VercelSnapshotBuild` Durable
Object owns execution and retries.

Every build start has a random `buildGeneration`. Every status update from the
DO must use both `credentialId` and `buildGeneration`:

```sql
UPDATE organization_vercel_compute_credentials
SET setup_status = $status,
    setup_step = $step,
    setup_error = $safe_error,
    runtime_build_id = $runtime_build_id,
    runtime_snapshot_id = $runtime_snapshot_id,
    team_slug = $team_slug,
    project_slug = $project_slug,
    updated_at = now()
WHERE id = $credential_id
  AND build_generation = $build_generation;
```

Zero updated rows means the credential was removed or a newer setup superseded
the caller. The DO stops advancing and forgets its local state. This fence is
mandatory at every projected transition.

The web app does not bind or address the DO directly. It calls an authenticated
Cloud Agent internal endpoint; Cloud Agent resolves the DO stub.

### 2.5 Persist intent before provider side effects

Before every Vercel operation that can create or mutate a resource, persist a
stable operation intent in the DO. On retry, reconcile that same intent before
issuing the side effect again.

At minimum:

- builder create: persist deterministic sandbox name, create operation ID, and
  expected inputs; call `inspectByName` first on every attempt;
- command execution: persist the command step before calling Vercel, and make
  the command safe to repeat or verify its postcondition;
- snapshot create: persist the source session and the pre-operation snapshot
  IDs before calling; after an uncertain result, list/inspect snapshots and
  reconcile before deciding whether another POST is safe;
- validation sandbox create: use the same deterministic create pattern;
- stop: persist the target and retry/observe until terminal.

Never infer that a timed-out create or snapshot did not happen.

### 2.6 No rotation in Stage 1

Reuse the existing `AGENT_ENV_VARS_PUBLIC_KEY` in the web app and
`AGENT_ENV_VARS_PRIVATE_KEY` in Cloud Agent with
`encryptWithPublicKey`/`decryptWithPrivateKey`. This is the same trust boundary:
the web app may encrypt a secret that only the Cloud Agent worker may decrypt.

Do not add key IDs, retired key slots, token versions, previous ciphertext, or
a rotation job. The operational constraint is explicit: do not rotate this RSA
pair while BYOC credential rows exist. A future rotation project must add a
real multi-key decrypt/read-rewrite path before changing the key.

---

## 3. Data model and contracts

### 3.1 PostgreSQL table

Add `organization_vercel_compute_credentials` in
`packages/db/src/schema.ts`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key; generated for each add flow |
| `organization_id` | UUID | FK to `organizations.id`; unique; cascade delete |
| `token_encrypted` | JSONB | `EncryptedEnvelope`; never returned to the browser |
| `team_id` | text | Non-empty validated Vercel team identifier |
| `project_id` | text | Non-empty validated Vercel project identifier |
| `team_slug` | text nullable | Resolved during validation for the dashboard link |
| `project_slug` | text nullable | Resolved project name/slug for the dashboard link |
| `setup_status` | text enum/check | `pending`, `building`, `ready`, `failed` |
| `setup_step` | text nullable | Current safe UI step |
| `setup_error` | text nullable | Sanitized category/message only |
| `build_generation` | UUID | Fence for the active build |
| `runtime_build_id` | text nullable | Correlation value embedded in sandbox tags |
| `runtime_snapshot_id` | text nullable | Required for `ready` |
| `setup_started_at` | timestamp nullable | UI/operations |
| `setup_completed_at` | timestamp nullable | UI/operations |
| `created_at` | timestamp | Standard default |
| `updated_at` | timestamp | Standard default/update |

Constraints:

- one row per organization;
- `ready` requires the runtime snapshot, both dashboard slugs, and
  `setup_completed_at`;
- non-`ready` rows are never eligible for new sessions;
- no `revoked_at`, token version, previous token, builder session ID, or purge
  deadline columns.

Follow `packages/db/AGENTS.md` and generate the migration through the repo's
normal Drizzle workflow. Do not hand-edit the migration journal.

### 3.2 Web API

Add
`apps/web/src/routers/organizations/organization-vercel-compute-router.ts` and
register it as `organizations.vercelCompute` in
`apps/web/src/routers/organizations/organization-router.ts`. Keep it separate
from the already-large Cloud Agent session router.

Procedures:

```ts
getStatus({ organizationId })
add({ organizationId, token, teamId, projectId })
retrySetup({ organizationId })
remove({ organizationId })
```

All procedures require organization owner/admin membership.

`add`:

1. Reject if a row already exists; the UI must use remove then add.
2. Validate field shape without logging input.
3. Encrypt the token.
4. Insert a `pending` row with fresh `id`, `runtimeBuildId`, and
   `buildGeneration`.
5. Call Cloud Agent `startVercelSnapshotBuild`; the DO performs the Vercel
   access check as its first step so provider logic remains in Cloud Agent.
6. If the call fails, keep the row and project `failed`; the user can retry or
   remove it.

`retrySetup` keeps the same credential row but creates a fresh
`runtimeBuildId` and `buildGeneration`, clears the snapshot ID/error, and starts
the DO again. It is setup retry, not credential rotation.

`remove` only hard-deletes the row. It does not wait for Cloud Agent and cannot
fail because a provider/control-plane cleanup call is unavailable. The UI
already has the team/project identifiers needed for its pre-delete Vercel link.
The remove response never returns them, the token, or the envelope.

### 3.3 Internal web endpoint for credential resolution

Add:

`apps/web/src/app/api/internal/byoc/vercel-credentials/[credentialId]/route.ts`

Cloud Agent calls this endpoint with `x-internal-api-key` and both
`credentialId` and `organizationId`. The endpoint:

- verifies the internal secret with the repository's constant-time helper;
- selects the row by both IDs;
- returns encrypted token, team/project, setup state, runtime snapshot ID,
  `runtimeBuildId`, and `buildGeneration`;
- returns `404` immediately after deletion;
- sets `Cache-Control: no-store`;
- never decrypts or logs the token.

Add a generation-fenced status-update endpoint beside it, or a single internal
route with explicit `GET` and `PATCH`. `PATCH` accepts only the finite setup
status/step contract and sanitized errors. It must not accept arbitrary column
updates.

### 3.4 Cloud Agent internal endpoints

Add authenticated Hono routes in `services/cloud-agent-next/src/server.ts`:

```text
POST /internal/byoc/vercel-snapshot-build/start
```

It uses the existing `requireInternalApi` boundary. `start` accepts only
`organizationId`, `credentialId`, and `buildGeneration`. It forwards those to
the per-organization DO.

Extend `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts` with typed
methods for these routes. Do not expose them in browser-side tRPC clients.

### 3.5 Credential resolver in Cloud Agent

Add a narrow server-only module, for example:

`services/cloud-agent-next/src/byoc/vercel-credential-resolver.ts`

It:

1. Fetches the internal web endpoint using the raw
   `KILOCODE_BACKEND_BASE_URL` Worker value and
   `await env.INTERNAL_API_SECRET_PROD.get()`, matching the existing outbound
   internal-call pattern. Do not use the sandbox-rewritten backend URL.
2. Uses `cache: 'no-store'`.
3. Validates the response with Zod.
4. Decrypts with `AGENT_ENV_VARS_PRIVATE_KEY` only immediately before an
   operation.
5. Returns a short-lived `VercelSandboxRuntimeConfig` value to the caller.
6. Converts `404` into a non-retryable `ByocCredentialMissingError`.

The resolver has no module-level cache and no DO-storage cache.

### 3.6 Session metadata

Update the shared metadata schema and all serialization boundaries that
currently carry `sandboxProvider` so they carry `SandboxProviderBinding`.
Relevant current paths include:

- `services/cloud-agent-next/src/persistence/session-metadata.ts`
- `services/cloud-agent-next/src/session/session-registration.ts`
- `services/cloud-agent-next/src/session-service.ts`
- `services/cloud-agent-next/src/persistence/CloudAgentSession.ts`
- `services/cloud-agent-next/src/persistence/SandboxControl.ts`
- `services/cloud-agent-next/src/sandbox-control/stub.ts`

Use a schema-version/default compatibility path only for metadata already in
production:

- legacy `cloudflare` maps to `{ kind: 'cloudflare' }`;
- legacy `vercel` maps to `{ kind: 'vercel', source: { kind: 'platform' } }`;
- no legacy value may synthesize a BYOC pointer.

The BYOC metadata branch stores only the binding pointer and existing opaque
runtime correlation fields needed by the adapter. It never stores the token,
encrypted envelope, team/project configuration, or source snapshot. Preserve
the existing platform-Vercel `providerRuntime` compatibility fields; removing
them is unrelated to this feature.

---

## 4. Runtime provider resolution

### 4.1 Enrollment and registration

Add `BYOC_VERCEL_ORG_IDS` as the BYOC launch kill switch. Keep
`VERCEL_SANDBOX_ORG_IDS` exclusively for the existing Kilo-paid Vercel path so
the two sources cannot be confused. At session registration:

1. If the session has no organization, use the existing provider selection.
2. If the organization is not in `BYOC_VERCEL_ORG_IDS`, use the existing
   provider selection, including `VERCEL_SANDBOX_ORG_IDS`.
3. If it is in `BYOC_VERCEL_ORG_IDS`, fetch its BYOC status through the
   internal credential endpoint.
4. If the row is `ready`, persist a BYOC provider binding and generate a
   per-session `ses-*` sandbox ID.
5. If the row is absent or not ready, fail registration with an actionable
   `byoc_vercel_not_ready` error. Do not silently use Cloudflare or Kilo-paid
   Vercel for an organization explicitly enrolled in BYOC.

This makes launch behavior deterministic. Enabling or disabling the allowlist
only affects new sessions.

### 4.2 Adapter construction

Refactor `SandboxControl.createProviderAdapter` into an async operation-scoped
factory:

```ts
async function createProviderAdapterForOperation(
  env: PersistenceEnv,
  binding: SandboxProviderBinding
): Promise<ProviderAdapter>
```

- Cloudflare uses the existing binding/adapter.
- Platform Vercel uses `parseVercelSandboxRuntimeConfig(env)`.
- BYOC Vercel resolves and decrypts the row for that operation, verifies the
  credential ID and organization, and creates the existing Vercel adapter with
  that config.

Remove `private provider`/promise caching from `SandboxControl`. Each durable
operation (`create`, `observe`, `stop`, `ensureLeaseAtLeast`, `logs`) obtains an
adapter, invokes one logical provider operation, then releases it. This extra
internal request is intentional: credential deletion must take effect on the
next operation.

The closed binding switch must be exhaustive. Never implement:

```ts
if (binding.byoc) return byocAdapter;
return platformVercelAdapter;
```

because a malformed BYOC record would become a billing/security fallback.

### 4.3 Removal behavior for existing sessions

After removal:

- a connected wrapper may continue its already-established WebSocket until a
  lifecycle action requires credentials or the connection closes;
- new create/observe/lease/stop/log operations fail
  `byoc_credential_missing`;
- queued messages terminalize with clear copy instead of retrying forever;
- Kilo cannot guarantee stop or cleanup of the Vercel VM;
- the session UI points the user to Vercel and recommends starting a new
  session after reconfiguring compute.

This loss of control is accepted product behavior and must be covered by tests
and user-facing warnings.

---

## 5. Snapshot-build Durable Object

### 5.1 Ownership and bindings

Add `VercelSnapshotBuild`, addressed by organization ID. There is one active
build per organization. Register the class and binding in:

- `services/cloud-agent-next/src/persistence/VercelSnapshotBuild.ts`
- `services/cloud-agent-next/src/index.ts`
- `services/cloud-agent-next/src/types.ts`
- `services/cloud-agent-next/src/persistence/types.ts`
- `services/cloud-agent-next/wrangler.jsonc`
- `services/cloud-agent-next/worker-configuration.d.ts`

Add the state table to `services/cloud-agent-next/src/db/sqlite-schema.ts`, run
the service's Drizzle generation workflow, and commit the generated SQL,
`drizzle/migrations.js`, and metadata. Add `VercelSnapshotBuild` as the next
`new_sqlite_classes` Wrangler migration (`v11` at this base). Its constructor
uses `drizzle-orm/durable-sqlite` and runs `migrate(db, migrations)` inside
`blockConcurrencyWhile`; no external I/O belongs in that block. Use only
Drizzle query-builder operations for SQLite access.

Store a single state-machine row plus bounded operation-intent fields. Do not
store credentials or envelopes. Keep the DO class to RPC/alarm orchestration;
put state transitions and Vercel build operations in plain-function modules
under `src/persistence/vercel-snapshot-build/`.

Export `getVercelSnapshotBuildStub(env, organizationId)` beside the class and
route every caller through it. The helper uses deterministic `getByName`.
Worker-to-DO calls use the service's `src/utils/do-retry.ts` wrapper so a
retryable DO error obtains a fresh stub instead of reusing a broken one.

Public RPC surface:

```ts
start(input: {
  organizationId: string;
  credentialId: string;
  buildGeneration: string;
}): Promise<void>

alarm(): Promise<void>
```

`start` is idempotent for the same generation. It reads the credential first,
then re-reads local state after that external I/O before writing. A newer
generation replaces old local state only when the row's credential ID and
build generation match the request. `ready`, `failed`, stale-generation, and
missing-credential terminal paths erase the DO's local build state after
projecting their final safe status where applicable.

### 5.2 Runtime artifacts

The DO cannot read the operator's local filesystem. For the MVP, ship the two
existing generated artifacts with the Worker instead of adding an artifact
registry:

- `wrapper/dist/wrapper.js`;
- `wrapper/dist/control-wrapper.js`.

Add `services/cloud-agent-next/src/byoc/vercel-runtime-artifacts.ts` with static
Data-module imports for those files and a narrow accessor returning bytes plus
hashes/version. Add exact `Data` rules to `wrangler.jsonc`, an ambient module
type if TypeScript requires it, and a `predeploy` script that runs the existing
`build:wrapper`. Local dev already builds the wrapper through `predev`.

The current generated artifacts are approximately 260 KiB and 480 KiB. This is
small enough to try the direct approach, but Slice 4 must run a Wrangler
`deploy --dry-run` and record compressed/uncompressed Worker size. If it would
breach the account's Worker limit or materially harm startup, stop and move the
same versioned artifacts to the already-bound R2 bucket; do not add R2 and
embedded delivery simultaneously.

### 5.3 Build state machine

Use explicit, finite steps:

```text
validating_access
  -> create_builder
  -> install_system_dependencies
  -> install_node_dependencies
  -> upload_runtime_artifacts
  -> verify_runtime_artifacts
  -> snapshot_builder
  -> create_validator
  -> launch_validator_wrapper
  -> verify_validator_call_home
  -> stop_validator
  -> confirm_terminal
  -> ready
```

Every step:

1. Reads/fences the current credential row.
2. Persists the next operation intent locally before external work.
3. Performs at most one bounded provider action or one bounded command.
4. Persists the result.
5. Projects safe status to PostgreSQL with the generation fence.
6. Arms the next alarm.

Do not run the full `scripts/vercel-snapshot.ts` sequence in one request. Extract
and reuse its commands, validation rules, and REST primitives, but split them
into alarm-sized operations.

Alarms execute at least once and Cloudflare's automatic exception retries are
finite. The handler therefore catches classified transient failures, persists
its retry count/next time, and explicitly sets the next alarm. Deterministic or
exhausted failures project `failed` and clear local state. Every replay starts
from persisted state; class fields are caches only.

### 5.4 Builder-create recovery

Vercel returns the exact session ID only in the create response. Therefore a
lost response must be recoverable by name:

- deterministic name: derived from credential ID and runtime build ID;
- deterministic create operation ID: persisted before POST;
- expected runtime/snapshot/tag inputs: persisted before POST;
- on every attempt, call `inspectByName` first;
- if found and correlation succeeds, persist the returned session ID;
- if not found, issue create once;
- if inspection is inconclusive, retry inspection; do not create.

The existing REST client's runtime create path requires a source snapshot, but
the builder starts from a plain runtime. Extend its create input as a closed
union of `runtime` and `snapshot` sources, and make `inspectByName` correlate
the selected source. Reuse its existing name/tag recovery; do not add an
optional snapshot field that can silently select the wrong path. Do not rely on
in-memory `trackedSessions` from the CLI script.

### 5.5 Command recovery

Each install/upload/verify command must be safe to retry. Prefer commands with
an observable postcondition, such as a marker containing the runtime build ID
written only after successful completion. On alarm replay:

- if the marker/postcondition exists, advance;
- if not, run the same command again;
- never advance solely because the command request was sent.

Keep commands coarse enough to avoid unnecessary state but small enough to
finish within provider and Worker limits. There is no separate workflow engine.

### 5.6 Snapshot recovery

Before snapshot POST:

1. Persist the source session ID and the current set of snapshot IDs.
2. Mark the snapshot operation `requested`.
3. Call create snapshot.

On a definite response, validate `sourceSessionId`, status, and snapshot ID,
then persist it. On timeout/transport ambiguity:

1. List snapshots created since the persisted baseline.
2. Inspect candidates and correlate them to the source session.
3. If exactly one matches, adopt it.
4. If none match and the source session is still active, retry after another
   bounded reconciliation pass.
5. If multiple match or provider state cannot prove absence, mark setup failed
   with `snapshot_result_ambiguous`; do not blindly POST another snapshot.

The implementation spike must prove Vercel's list/inspect responses contain
enough information to perform step 2. If they do not, Stage 1 is blocked until
we choose a safe provider-supported correlation mechanism. This is the only
intentional pre-implementation gate.

Vercel snapshot creation stops the source sandbox. Treat a separate stop call
as terminal confirmation/reconciliation, not an unconditional next side effect.

### 5.7 Failure and cancellation

Retry only classified transient provider/network failures with a bounded
backoff. Invalid token, forbidden team/project, missing credential, failed
correlation, and deterministic command failures become `failed` immediately.

Persist only sanitized error categories/messages to PostgreSQL. Logs may carry
organization ID, credential ID, build generation, operation ID, provider
status, and HTTP status; never token, envelope, auth header, or raw provider
body that could contain secrets.

If a credential disappears during a build, the next armed alarm receives
`404`, cancels further work, and deletes local state without trying to stop
provider resources. This is deliberate: removal has already deleted the only
authority needed to control them.

---

## 6. Existing lifecycle fixes required before enrollment

Current `SandboxControl` has semantic deadlines (`idleStop`, `stopAttempt`, and
`reconciliation`), but the customer-billing safety behavior must be verified
and fixed before any BYOC org is enrolled.

### 6.1 Stop retry

When `provider.stop` returns `retryable`, the `stopAttempt` deadline must call
`provider.stop` again for the same persisted provider reference. Recording an
attempt and rearming without issuing stop is not sufficient.

Required transition:

```text
stop requested
  -> stop(ref)
  -> retryable
  -> persist attempt + arm stopAttempt
  -> stop(ref) again
  -> terminal: clear provider state
  -> retry budget exhausted: keep reconciliation armed
```

### 6.2 Reconciliation

On `reconciliation`, observe the persisted reference:

- `terminal`: clear provider state and cancel stop deadlines;
- `active` with no attached work: re-enter the stop transition;
- `active` with work: preserve it and rearm reconciliation;
- `unknown`: preserve state and rearm reconciliation.

This must work for Cloudflare, platform Vercel, and BYOC Vercel. For BYOC after
credential deletion, observation fails closed and telemetry identifies the
uncontrollable resource; it must not erase the reference as if terminal.

### 6.3 Queue terminalization

`ByocCredentialMissingError`, invalid credential, and non-retryable provider
capacity/configuration errors must terminalize the affected message/session
with actionable failure data. They must not enter the generic five-second queue
retry loop indefinitely.

---

## 7. UI requirements

Add organization compute settings at
`apps/web/src/app/(app)/organizations/[id]/cloud/compute/`, alongside the
existing organization Cloud pages. Follow `apps/web/AGENTS.md`, `DESIGN.md`,
and the `kilo-design-cloud` patterns during implementation.

### 7.1 Add/setup

- Inputs: Vercel token, team ID, project ID.
- Token input is write-only; never redisplay it.
- Explain that setup creates temporary sandboxes and snapshots in the selected
  project and can incur Vercel charges.
- Show finite setup steps from the PostgreSQL projection.
- `failed` offers Retry setup and Remove credentials.
- `ready` shows team/project and snapshot readiness. Setup resolves
  team/project slugs while validating access; IDs must never be interpolated as
  dashboard path slugs.

### 7.2 Remove confirmation

The destructive confirmation must say, in equivalent plain language:

> Removing these credentials deletes Kilo's copy immediately. Kilo will no
> longer be able to start, inspect, extend, or stop your Vercel sandboxes.
> Existing Cloud Agent sessions using this project will stop working. Review
> and stop running sandboxes in Vercel before continuing.

Include `https://vercel.com/{teamSlug}/{projectSlug}` and tell the user to open
**Observability -> Sandboxes**. Require an explicit confirmation action; do not
require typing the token or project name.

After success:

- clear all credential/setup details from the page;
- show a generic Vercel dashboard link for unmanaged running sandboxes;
- explain that the user may revoke the token in Vercel if it should no longer
  be valid there;
- do not offer restore or undo.

### 7.3 Session errors

Map at least:

- `byoc_vercel_not_ready` -> finish setup or contact an org admin;
- `byoc_credential_missing` -> credentials were removed; inspect Vercel and
  start a new session after reconfiguration;
- `byoc_vercel_capacity` -> check Vercel concurrency/spend limits;
- `byoc_vercel_forbidden` -> check token/team/project access.

Do not show raw Vercel responses or identifiers that are not needed for support.

---

## 8. Kilo token exposure

For Stage 1, the wrapper receives the current `KILOCODE_TOKEN` behavior. A
customer who administers the Vercel project may be able to inspect process
environment or VM state and obtain it. This is accepted for the MVP and must be
documented in the enrollment risk note.

Do not build a new containment design in this work. The follow-up is to adapt
the existing Cloudflare containment/capability path represented by
`KILOCODE_TOKEN_CONTAINMENT_ORG_IDS`, rather than create a Vercel-specific
second mechanism.

---

## 9. Implementation slices

Each slice should be a small reviewable commit/PR and leave default production
traffic unchanged.

### Slice 0 — Provider spike and contract proof

Goal: remove the only provider-contract uncertainty before schema/UI work.

Tasks:

- In an isolated Vercel test project, create a sandbox with deterministic name
  and tags, lose/ignore the response, and recover it through `inspectByName`.
- Create a snapshot, then prove list/inspect can correlate it to the source
  session after response loss.
- Confirm snapshot creation's source-session stop behavior.
- Record sanitized response shapes and the chosen correlation algorithm in a
  focused test/fixture or a short appendix to this document.

Gate: do not start later slices if snapshot response-loss cannot be reconciled
without risking duplicate snapshots.

### Slice 1 — Lifecycle billing safety

Files:

- `services/cloud-agent-next/src/persistence/SandboxControl.ts`
- `services/cloud-agent-next/src/sandbox-control/reconciliation.ts`
- focused tests under `src/sandbox-control/recovery/` and persistence tests

Deliver:

- real stop reissue on `stopAttempt`;
- active/no-work reconciliation re-enters stop;
- non-retryable configuration errors terminalize queues.

No BYOC schema or UI in this slice.

### Slice 2 — Credential persistence and removal

Files:

- `packages/db/src/schema.ts`
- generated `packages/db/src/migrations/*`
- `apps/web/src/routers/organizations/organization-vercel-compute-router.ts`
- `apps/web/src/routers/organizations/organization-router.ts`
- `apps/web/src/app/api/internal/byoc/vercel-credentials/[credentialId]/route.ts`
- web configuration/encryption tests

Deliver:

- one hard-deletable encrypted row per organization;
- owner/admin authorization;
- add/status/retry/remove contracts;
- internal no-store GET and generation-fenced PATCH;
- no version/revocation/rotation machinery.

### Slice 3 — Closed provider binding and resolver

Files:

- session metadata/registration files listed in §3.6;
- `services/cloud-agent-next/src/byoc/vercel-credential-resolver.ts`;
- `services/cloud-agent-next/src/persistence/SandboxControl.ts`;
- `services/cloud-agent-next/src/sandbox-control/vercel-provider.ts` as needed;
- `services/cloud-agent-next/src/types.ts` and persistence types.

Deliver:

- discriminated provider source union with legacy read compatibility;
- operation-scoped credential lookup/decrypt;
- no provider cache;
- hard fail on missing BYOC credentials;
- existing Cloudflare and platform Vercel paths unchanged.

### Slice 4 — Snapshot-build DO and internal control API

Files:

- `services/cloud-agent-next/src/persistence/VercelSnapshotBuild.ts`
- `services/cloud-agent-next/src/persistence/vercel-snapshot-build/*`
- `services/cloud-agent-next/src/db/sqlite-schema.ts` and generated
  `services/cloud-agent-next/drizzle/*` artifacts;
- `services/cloud-agent-next/src/byoc/vercel-runtime-artifacts.ts`
- `services/cloud-agent-next/src/server.ts`
- `services/cloud-agent-next/src/index.ts`
- `services/cloud-agent-next/src/types.ts`
- `services/cloud-agent-next/src/persistence/types.ts`
- `services/cloud-agent-next/wrangler.jsonc`
- `services/cloud-agent-next/worker-configuration.d.ts`
- `services/cloud-agent-next/package.json`
- `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`
- extracted/reused Vercel snapshot primitives

Deliver the state machine and reconciliation rules from §5. The CLI snapshot
script may be refactored to call shared primitives, but the DO must not spawn or
depend on the CLI script.

### Slice 5 — Routing and enrollment

Files:

- provider selection and routing helpers in `services/cloud-agent-next/src/`;
- `services/cloud-agent-next/src/session/session-registration.ts`;
- relevant router/session preparation tests;
- `services/cloud-agent-next/wrangler.jsonc`, `services/cloud-agent-next/src/types.ts`,
  generated worker configuration, `.dev.vars.example`, and `ENVIRONMENT.md` for
  the new `BYOC_VERCEL_ORG_IDS` kill switch.

Deliver:

- ready + allowlisted -> BYOC binding + `ses-*`;
- allowlisted but absent/not-ready -> explicit failure;
- existing sessions remain pinned;
- personal accounts and non-allowlisted orgs preserve current behavior.

### Slice 6 — Organization settings UI

Deliver the add/progress/retry/removal flow and exact warning behavior in §7.
UI polling may use the existing tRPC query invalidation/polling pattern; do not
add WebSockets or another event system for setup progress.

### Slice 7 — End-to-end pilot

- Run setup against a dedicated customer-like Vercel team/project.
- Start two sessions and prove they create two distinct `ses-*` sandboxes.
- Exercise prompt dispatch, reconnect, idle stop, stop retry, and reconciliation.
- Remove the credential while a session exists and verify the DB row disappears,
  future control fails closed, the user gets the warning/error path, and the
  Vercel dashboard still exposes the unmanaged sandbox.
- Inspect logs for token/envelope/header leakage.
- Enroll one design-partner organization only after all rollout gates pass.

---

## 10. Test and verification matrix

### 10.1 Required focused tests

Credential/API tests:

- only org owner/admin can read status, add, retry, or remove;
- add rejects a second row;
- plaintext token is never returned or logged;
- remove hard-deletes the row;
- internal GET returns `404` after removal and `Cache-Control: no-store`;
- stale generation PATCH updates zero rows;
- `ready` cannot be projected without the runtime snapshot and dashboard slugs.

Provider-binding tests:

- each union member selects exactly one adapter source;
- malformed/missing BYOC pointer is rejected;
- deleted row never falls back to platform Vercel;
- legacy metadata maps only to Cloudflare/platform Vercel;
- BYOC adapter is resolved again on each operation;
- session routing for BYOC is always `ses-*`.

Build-state tests:

- same-generation `start` is idempotent;
- stale alarm/generation cannot overwrite a newer setup;
- create response loss is recovered by `inspectByName`;
- inconclusive inspection does not issue another create;
- command replay checks its postcondition;
- snapshot response loss adopts exactly one correlated snapshot;
- ambiguous snapshot state fails without duplicate POST;
- missing credential causes local state to be forgotten;
- persisted/logged state contains no token/envelope.
- Workers-runtime alarm tests use `runDurableObjectAlarm` and verify replay from
  SQLite after object re-instantiation;
- retryable Worker-to-DO calls create a fresh stub through `withDORetry`.

Lifecycle tests:

- retryable stop calls `stop` again;
- active/no-work reconciliation restarts stop;
- unknown observation preserves provider reference and rearms;
- missing BYOC credential terminalizes work without clearing the provider as
  successfully stopped.

### 10.2 Narrow verification commands

Before implementation, read the root and affected package manifests and use
their exact scripts. At minimum, expect package-filtered equivalents of:

```sh
pnpm --filter cloud-agent-next typecheck
pnpm --filter cloud-agent-next test
pnpm --filter cloud-agent-next test:integration
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter @kilocode/db typecheck
pnpm lint
```

Use the `repository-verification` skill during implementation to choose the
actual supported commands. Root `pnpm test` is not proof that the Cloud Agent
service suite ran.

### 10.3 Security review checklist

- Search logs/tests/fixtures for the test token and encrypted envelope.
- Verify Sentry extras never receive input objects containing credentials.
- Verify provider errors are sanitized before persistence or UI display.
- Verify internal routes reject missing/wrong shared secrets.
- Verify every credential read checks both credential and organization IDs.
- Verify every build projection checks credential ID and generation.
- Verify no DO/session metadata contains ciphertext or plaintext.
- Verify deletion does not call Cloud Agent or Vercel and commits independently.

---

## 11. Deployment, rollout, and rollback

### 11.1 Deployment order

1. Land Slice 1 lifecycle fixes and observe existing providers.
2. Deploy DB migration and web internal endpoints.
3. Deploy Cloud Agent resolver, provider-binding compatibility, DO class,
   migration, embedded runtime artifacts, and internal build endpoints. The
   deployment must use the package script so `predeploy` rebuilds the artifacts.
4. Deploy settings API/UI with setup available but enrollment allowlist empty.
5. Complete an internal Vercel setup and E2E run.
6. Add one design-partner organization to `BYOC_VERCEL_ORG_IDS`.
7. Expand only after stop/reconciliation and Vercel spend telemetry are clean.

Durable Object class/binding/migration deployment must be validated in a
non-production environment before the production Worker deploy. Do not expose
the UI action until both directions of the web/Worker internal API are live.

### 11.2 Rollout gates

All must be true:

- Slice 0 proves create and snapshot ambiguity recovery.
- No unresolved stop/reconciliation correctness failures.
- Credential deletion and stale-generation tests pass.
- Two-session per-session E2E passes.
- Token leak audit is clean.
- Wrangler dry-run confirms the Worker bundle remains within its account limit.
- Alerts/metrics distinguish platform Vercel from BYOC without token/team
  values.
- Support runbook explains removed credentials and unmanaged Vercel sandboxes.
- Product/security explicitly accept MVP Kilo token exposure.

### 11.3 Kill switch and rollback

Primary kill switch: remove organizations from `BYOC_VERCEL_ORG_IDS`. This
stops new BYOC session registration but does not alter existing sessions or
delete credentials.

Rollback rules:

- Preserve metadata compatibility code while any BYOC session can exist.
- Do not roll back the DB migration while rows exist.
- Do not automatically delete customer credentials during a software rollback.
- Do not move existing BYOC sessions to Cloudflare/platform Vercel.
- If snapshot setup is broken, disable setup starts and enrollment; keep status
  and removal available.
- Credential removal remains irreversible from Kilo's side. A rollback cannot
  restore control of an already-unmanaged Vercel sandbox.

---

## 12. Observability and operations

Structured events should include safe identifiers only:

- `byoc_vercel_setup_started`
- `byoc_vercel_setup_step`
- `byoc_vercel_setup_failed`
- `byoc_vercel_setup_ready`
- `byoc_vercel_credential_removed`
- `byoc_vercel_credential_missing`
- `byoc_vercel_resource_uncontrollable`
- `byoc_vercel_snapshot_ambiguous`

Safe fields: organization ID, credential ID, build generation, operation ID,
sandbox ID, provider status, attempt count, duration, and sanitized error code.

Never include: token, encrypted envelope, Authorization header, internal API
secret, wrapper credential, Kilo token, or raw provider response bodies.

Operational dashboards should separate BYOC from platform Vercel for creates,
active resources, stops, reconciliation age, and failures. This is a source tag,
not the customer team/project value.

---

## 13. Residual risks accepted for Stage 1

1. Removing credentials immediately makes existing sessions uncontrollable;
   running resources may continue billing until the customer stops them in
   Vercel.
2. In-flight provider operations may finish after deletion.
3. Encrypted DB backups retain deleted ciphertext according to normal backup
   retention.
4. The RSA key pair cannot be rotated while BYOC rows exist.
5. Customer Vercel administrators may obtain `KILOCODE_TOKEN` from sandbox
   state.
6. Per-session VMs increase customer concurrency, spend, and cold starts.
7. Vercel API behavior is an external dependency; snapshot ambiguity recovery
   must be proven by Slice 0 before implementation proceeds.

These are explicit MVP limitations, not hidden follow-up machinery.

---

## 14. Definition of done

The feature is ready to enroll one design partner when:

- the Slice 0 provider gate passes;
- all required invariants and focused tests pass;
- setup reaches `ready` through the Durable Object after restart/replay tests;
- new enrolled sessions use the customer's Vercel project and unique `ses-*`
  sandboxes;
- existing sessions retain their original provider binding;
- credential removal hard-deletes the active DB row, leaves no credential copy
  in application state, and causes subsequent control to fail closed;
- removal and session UI direct the customer to Vercel for running resources;
- stop retry and reconciliation are proven for customer-paid resources;
- no secrets appear in logs, telemetry, metadata, DO storage, or responses;
- rollout/rollback runbooks are written and the allowlist is empty by default.

No credential rotation or Kilo-token containment work is required for Stage 1.
