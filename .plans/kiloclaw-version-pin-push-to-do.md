# Push kiloclaw version pin to DO on set/remove

## Problem

Setting an admin version pin in the Kilo admin UI writes a row to
`kiloclaw_version_pins` but never touches the instance's Durable Object.
`DO.restartMachine` (the user-facing "Redeploy" path) also never reads
the pin table. Result: after pinning `2026-04-09`, clicking Redeploy
still boots `2026-04-15` because `state.trackedImageTag` is stale.

See `admin-kiloclaw-versions-router.ts:305` (setPin — DB-only) and
`services/kiloclaw/src/durable-objects/kiloclaw-instance/index.ts:3179`
(restartMachine — never reads pin).

Live Worker Status screenshot confirms `openclawVersion`, `imageTag`,
and `imageDigest` in DO state remain stale after `setPin`.

## Approach

Make the admin `setPin` / `removePin` mutations push the resolved
pin state into the DO immediately. The DB row stays the source of
truth, but DO state is updated as a side effect so the next
restart / redeploy picks it up through the existing
`resolveImageTag(state, env)` path.

Do **not** change `DO.restartMachine` to re-read the pin table. That
would add a cross-service DB dependency to every restart; it's simpler
to keep the DO authoritative for `trackedImageTag` and have the admin
mutation keep it in sync.

## Changes

### 1. DO: new RPC `applyPinnedVersion`

File: `services/kiloclaw/src/durable-objects/kiloclaw-instance/index.ts`

New method on `KiloClawInstance`:

```ts
async applyPinnedVersion(imageTag: string | null): Promise<{
  openclawVersion: string | null;
  imageTag: string;
  imageDigest: string | null;
  variant: ImageVariant | null;
}>
```

Behavior:

- **`imageTag` is a tag**: resolve against KV (`resolveVersionByTag`)
  then Postgres catalog (`lookupCatalogVersion`) — identical to the
  block at `index.ts:597-659` in `provision`. Write `openclawVersion`,
  `imageVariant`, `trackedImageTag`, `trackedImageDigest`. If catalog
  lookup fails, fall back to storing the raw tag (matching provision's
  current behavior).
- **`imageTag === null`** (pin removed): run
  `selectImageVersionForInstance(...)` to pick the current rollout
  target (latest or candidate for early-access users). Write the same
  four fields. This mirrors the non-pinned branch in provision
  (`index.ts:660+`).

Factor the pin-resolution block out of `provision()` into a private
helper (e.g. `resolvePinnedImageState`) and call it from both sites
to avoid duplication.

The method does **not** touch the machine or restart anything —
the next Redeploy / alarm-driven reconciliation uses the new
`trackedImageTag` via `resolveImageTag(state, env)`
(`durable-objects/kiloclaw-instance/config.ts:19`).

### 2. Worker: platform route

File: `services/kiloclaw/src/routes/platform.ts`

New route:

```
POST /api/platform/instances/:instanceId/pinned-version
Body: { userId: string, imageTag: string | null }
```

Resolves the DO stub via the existing `resolveInstanceDoKey` +
`withResolvedDORetry` helpers (same pattern as other per-instance
platform routes), calls `stub.applyPinnedVersion(imageTag)`, returns
the resolved metadata.

Input validated with Zod. Internal-API-key auth (already enforced
on `/api/platform/*`).

### 3. Worker client

File: `apps/web/src/lib/kiloclaw/kiloclaw-internal-client.ts`

```ts
async applyPinnedVersion(
  userId: string,
  instanceId: string,
  imageTag: string | null,
): Promise<{
  openclawVersion: string | null;
  imageTag: string;
  imageDigest: string | null;
  variant: string | null;
}>
```

### 4. Admin router wiring

File: `apps/web/src/routers/admin-kiloclaw-versions-router.ts`

In `setPin` (line 305): after the DB upsert succeeds, call
`client.applyPinnedVersion(userId, instanceId, input.imageTag)`. If
the DO call fails, log the error but **do not** roll back the DB row —
the pin is still the intent of record, and the DO will eventually
converge when the instance is next provisioned or the admin retries.
Surface a warning flag in the response so the UI can say "pin saved,
worker sync failed — retry available".

In `removePin` (line 346): after the DB delete, call
`applyPinnedVersion(userId, instanceId, null)` to reset the DO to the
current rollout target.

Both sites need the `userId` of the instance owner — look it up via
`requireActivePersonalInstance` / the existing instance row (the
`setPin` handler already has the resolved instance id).

### 5. Tests

- `services/kiloclaw/src/durable-objects/kiloclaw-instance.test.ts`:
  new tests for `applyPinnedVersion` — tag resolves from catalog, tag
  not in catalog falls through, `null` invokes rollout selector.
- `apps/web/src/routers/admin-kiloclaw-versions-router.test.ts` (or
  create if missing): assert the worker client is called with the
  resolved `(userId, instanceId, imageTag)` after setPin/removePin.
  Use a fake `KiloClawInternalClient` implementation passed via the
  existing DI seam rather than mocks.

## Out of scope

- Changing `DO.restartMachine` to read the pin table. If the DO state
  drifts from the DB, a follow-up reconciliation job can fix it; we
  don't need to take on that cost in the hot path.
- Per-user early-access interaction with pins. Pins already bypass
  rollout gating entirely in the existing provision code (see the
  "Pinned instances bypass rollout gating" comment at
  `index.ts:626-631`); this plan preserves that.
- Auto-restarting the machine when a pin is applied. The admin can
  hit Redeploy separately; doing it implicitly from `setPin` would
  surprise users.

## Rollout

Single PR, no migration needed (the DB column/table already exists).
Feature can ship behind no flag since the failure mode is
"pin sync logs a warning" — strictly better than today where the
pin silently does nothing.
