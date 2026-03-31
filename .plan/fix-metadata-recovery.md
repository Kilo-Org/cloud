# Fix: Metadata Recovery Scoping for Multi-Instance

## Problem

When a user has multiple KiloClaw instances (personal + org), they share the same per-user Fly App. The metadata recovery logic in `attemptMetadataRecovery` (`reconcile.ts:662-664`) queries Fly's `listMachines` filtered only by `kiloclaw_user_id`. This returns ALL machines for that user across ALL instances. The recovery candidate selection then picks the "best" machine by state priority, potentially stealing another instance's machine.

Observed: provisioning an org instance triggered metadata recovery that claimed the personal instance's existing machine.

## Root Cause

```typescript
// reconcile.ts:662-664
const machines = await fly.listMachines(flyConfig, {
  [METADATA_KEY_USER_ID]: state.userId, // only filter
});
```

Machines are created with both `kiloclaw_user_id` AND `kiloclaw_sandbox_id` metadata (machine-config.ts:59-66), but recovery only filters by `kiloclaw_user_id`.

## Fix

### Change 1: `kiloclaw/src/durable-objects/kiloclaw-instance/reconcile.ts` ~line 662

Add `kiloclaw_sandbox_id` to the metadata filter:

```typescript
const machines = await fly.listMachines(flyConfig, {
  [METADATA_KEY_USER_ID]: state.userId,
  [METADATA_KEY_SANDBOX_ID]: state.sandboxId,
});
```

This is safe because:

- `state.sandboxId` is always set when `state.userId` is (both populated during provision at index.ts:397)
- `kiloclaw_sandbox_id` is already set on every machine at creation time (machine-config.ts:61)
- `listMachines` already supports multiple metadata filters (client.ts:347-353)
- Instance-keyed sandboxIds (`ki_` prefix) are unique per instance, so recovery will only find machines belonging to the correct instance

### Change 2: Import `METADATA_KEY_SANDBOX_ID` in reconcile.ts

Verify `METADATA_KEY_SANDBOX_ID` is imported from `../machine-config`. If not, add the import.

### Verification

- Existing test: `kiloclaw/src/durable-objects/kiloclaw-instance.test.ts` — update the metadata recovery test to pass both userId AND sandboxId in the mock `listMachines` filter
- Manual: provision an org instance when a personal instance already exists — the org instance should create a new machine instead of recovering the personal one

## Risk

Low. The filter is additive (more restrictive, not less). Existing personal instances have `kiloclaw_sandbox_id` set on their machines. The only edge case is machines created before `kiloclaw_sandbox_id` was added to machine metadata — but per the AGENTS.md, this metadata was always set.
