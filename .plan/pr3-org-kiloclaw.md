# PR 3: Org KiloClaw Instances — Implementation Plan

## Summary

Add org-scoped KiloClaw provisioning and management. Org members can provision, start/stop, configure, and destroy KiloClaw instances within their organization. Gated behind a `kiloclaw-org-support` PostHog feature flag. Includes the **launch blocker**: org member removal must destroy the removed user's org instance.

All worker-side plumbing is already complete from PRs 1 and 2:

- Instance DO accepts/persists `orgId`, returns it in `getStatus()`
- Registry DO supports `org:{orgId}` keying
- Platform routes handle `instanceId` + `orgId` threading
- `buildEnvVars` injects `KILOCODE_ORGANIZATION_ID`
- `/i/:instanceId` proxy route exists with access check (`status.userId === authed userId`)

This PR is **Next.js backend + frontend**, with no worker changes needed.

## Architecture: Cloud Agent Pattern for Dashboard Reuse

Following the Cloud Agent precedent, the KiloClaw dashboard will use the **`organizationId` prop-drilling pattern with inline tRPC branching**:

1. **Shared components** accept `organizationId?: string` prop
2. **Inside components**, queries/mutations branch inline:
   ```tsx
   const statusQuery = useQuery(
     organizationId
       ? trpc.organizations.kiloclaw.getStatus.queryOptions({ organizationId })
       : trpc.kiloclaw.getStatus.queryOptions()
   );
   ```
3. **Org page** wraps shared components with `OrganizationByPageLayout`, passes `organizationId`
4. **Personal page** renders same components without `organizationId`

This avoids the need for separate hooks files or a context provider — the branching is self-contained in each component.

## Implementation Steps

### Step 1: Backend — Instance Registry Functions

**Edit: `src/lib/kiloclaw/instance-registry.ts`**

Add three new functions:

```ts
// Get active org instance for a user within an org
export async function getActiveOrgInstance(
  userId: string,
  orgId: string
): Promise<ActiveKiloClawInstance | null>;
// WHERE user_id = userId AND organization_id = orgId AND destroyed_at IS NULL

// List all active instances for an org (admin use, member removal cleanup)
export async function listActiveOrgInstances(orgId: string): Promise<ActiveKiloClawInstance[]>;
// WHERE organization_id = orgId AND destroyed_at IS NULL

// Soft-delete all instances for a user within an org (for member removal)
export async function destroyOrgInstancesForUser(
  userId: string,
  orgId: string
): Promise<{ instanceId: string; sandboxId: string }[]>;
// Returns destroyed instance metadata so caller can trigger worker cleanup
```

### Step 2: Backend — Org tRPC Router

**New file: `src/routers/organizations/organization-kiloclaw-router.ts`**

Full set of procedures matching the personal router, minus billing/earlybird and Kilo CLI Run. Uses `organizationMemberProcedure` for reads, `organizationMemberMutationProcedure` for mutations.

**Feature flag gate**: Middleware at the top checks `isFeatureFlagEnabled('kiloclaw-org-support')`. If off, throws `TRPCError({ code: 'NOT_FOUND' })`.

**Key pattern** — every instance-targeting procedure:

1. `getActiveOrgInstance(ctx.user.id, input.organizationId)` → get the row
2. `workerInstanceId(instance)` → extract instanceId (or undefined for legacy)
3. `client.someMethod(ctx.user.id, instanceId)` → call worker

**Provision flow**:

1. Check cardinality: `getActiveOrgInstance(userId, orgId)` — if exists, error (1 instance per org+user in Phase 1)
2. `ensureActiveInstance(userId, { orgId })` — Postgres creates row with `organization_id`, returns `{ id, sandboxId }`
3. Create API token for the instance
4. `client.provision(userId, config, { instanceId, orgId })` — worker provisions
5. On failure: `markInstanceDestroyedById(instanceId)` to rollback

**Destroy flow**:

1. `getActiveOrgInstance(userId, orgId)` → get instance
2. `markInstanceDestroyedById(instanceId)` — Postgres soft-delete
3. `client.destroy(userId, instanceId)` — worker teardown
4. On worker failure: `restoreDestroyedInstance(instanceId)` to rollback

**Procedures**:

| Procedure                     | Base procedure                        | Notes                                   |
| ----------------------------- | ------------------------------------- | --------------------------------------- |
| `getStatus`                   | `organizationMemberProcedure`         |                                         |
| `provision`                   | `organizationMemberMutationProcedure` | Cardinality check + full provision flow |
| `updateConfig`                | `organizationMemberMutationProcedure` | Re-provision alias                      |
| `start`                       | `organizationMemberMutationProcedure` |                                         |
| `stop`                        | `organizationMemberMutationProcedure` |                                         |
| `destroy`                     | `organizationMemberMutationProcedure` |                                         |
| `getConfig`                   | `organizationMemberProcedure`         |                                         |
| `patchConfig`                 | `organizationMemberMutationProcedure` |                                         |
| `patchChannels`               | `organizationMemberMutationProcedure` |                                         |
| `patchSecrets`                | `organizationMemberMutationProcedure` |                                         |
| `patchExecPreset`             | `organizationMemberMutationProcedure` |                                         |
| `restartMachine`              | `organizationMemberMutationProcedure` |                                         |
| `restartOpenClaw`             | `organizationMemberMutationProcedure` |                                         |
| `runDoctor`                   | `organizationMemberMutationProcedure` |                                         |
| `restoreConfig`               | `organizationMemberMutationProcedure` |                                         |
| `gatewayStatus`               | `organizationMemberProcedure`         |                                         |
| `gatewayReady`                | `organizationMemberProcedure`         |                                         |
| `controllerVersion`           | `organizationMemberProcedure`         |                                         |
| `getChannelCatalog`           | `organizationMemberProcedure`         |                                         |
| `getSecretCatalog`            | `organizationMemberProcedure`         |                                         |
| `listPairingRequests`         | `organizationMemberProcedure`         |                                         |
| `approvePairingRequest`       | `organizationMemberMutationProcedure` |                                         |
| `listDevicePairingRequests`   | `organizationMemberProcedure`         |                                         |
| `approveDevicePairingRequest` | `organizationMemberMutationProcedure` |                                         |
| `renameInstance`              | `organizationMemberMutationProcedure` |                                         |
| `listAvailableVersions`       | `organizationMemberProcedure`         | Global data, no instance needed         |
| `latestVersion`               | `organizationMemberProcedure`         | Global data                             |
| `getChangelog`                | `organizationMemberProcedure`         | Global data                             |
| `serviceDegraded`             | `organizationMemberProcedure`         | Global data                             |

**Deferred** (add in follow-up PRs):

- Kilo CLI Run (`startKiloCliRun`, `getKiloCliRunStatus`, `cancelKiloCliRun`, `listKiloCliRuns`)
- Stream Chat (`getStreamChatCredentials`, `sendChatMessage`)
- Google integration (`getGoogleSetupCommand`, `disconnectGoogle`, `setGmailNotifications`)
- Billing/earlybird (org billing deferred per plan)
- File tree / read file (`fileTree`, `readFile`)

**Org billing note**: `organizationMemberMutationProcedure` already calls `requireActiveSubscriptionOrTrial` for the org. This is the billing gate for now. Add `// TODO: org-specific kiloclaw billing gate` at the top of the provision procedure.

### Step 3: Backend — Mount Router

**Edit: `src/routers/organizations/organization-router.ts`**

```ts
import { organizationKiloclawRouter } from './organization-kiloclaw-router';
// In the router object:
kiloclaw: organizationKiloclawRouter,
```

### Step 4: Backend — Org Member Removal Cleanup (LAUNCH BLOCKER)

**Edit: `src/routers/organizations/organization-members-router.ts` — `remove` procedure**

After `removeUserFromOrganization(organizationId, memberId, user.id)` returns successfully:

1. Call `destroyOrgInstancesForUser(memberId, organizationId)` — soft-deletes Postgres rows (returns instanceIds)
2. For each destroyed instance, fire-and-forget `client.destroy(memberId, instanceId)` with error logging
3. Log success/failure for observability

The Postgres soft-delete is the critical path — even if worker destroy fails, the instance row is marked destroyed and the user can no longer look it up via `getActiveOrgInstance`. Worker-side reconciliation will clean up orphaned Fly machines.

**Why in the tRPC handler, not in `removeUserFromOrganization`**: The `removeUserFromOrganization` function is a pure DB transaction. Adding worker HTTP calls inside a transaction is an anti-pattern (network calls can hang, holding the transaction open). The tRPC handler is the right place for orchestrating DB + worker side effects.

### Step 5: Frontend — Refactor ClawDashboard for `organizationId` prop

Following the Cloud Agent pattern, add `organizationId?: string` to shared components and branch tRPC calls inline.

**Components to modify** (add `organizationId?: string` prop + inline query branching):

| Component            | File                                                   | What changes                                                                   |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `ClawDashboard`      | `src/app/(app)/claw/components/ClawDashboard.tsx`      | Accept `organizationId`, pass to children, branch `useKiloClawMutations` calls |
| `InstanceControls`   | `src/app/(app)/claw/components/InstanceControls.tsx`   | Accept `organizationId`, branch mutation hooks                                 |
| `SettingsTab`        | `src/app/(app)/claw/components/SettingsTab.tsx`        | Accept `organizationId`, branch config/secret/channel queries                  |
| `InstanceTab`        | `src/app/(app)/claw/components/InstanceTab.tsx`        | Accept `organizationId`, branch gateway status query                           |
| `ChatTab`            | `src/app/(app)/claw/components/ChatTab.tsx`            | Defer — Stream Chat not in MVP                                                 |
| `CreateInstanceCard` | `src/app/(app)/claw/components/CreateInstanceCard.tsx` | Accept `organizationId`, branch provision mutation                             |
| `ClawHeader`         | `src/app/(app)/claw/components/ClawHeader.tsx`         | Accept `organizationId` for URL construction                                   |
| `PairingSection`     | `src/app/(app)/claw/components/PairingSection.tsx`     | Accept `organizationId`, branch pairing queries                                |
| `VersionPinCard`     | `src/app/(app)/claw/components/VersionPinCard.tsx`     | Accept `organizationId`, branch version queries                                |

**`useKiloClaw.ts` hooks** — Modify existing hooks to accept optional `organizationId` and branch internally:

```ts
export function useKiloClawStatus(organizationId?: string) {
  return useQuery(
    organizationId
      ? trpc.organizations.kiloclaw.getStatus.queryOptions({ organizationId })
      : trpc.kiloclaw.getStatus.queryOptions()
  );
}
```

This way, there's no separate `useOrgKiloClaw.ts` file — the existing hooks handle both contexts based on the presence of `organizationId`.

### Step 6: Frontend — Org Claw Page

**New file: `src/app/(app)/organizations/[id]/claw/page.tsx`**

```tsx
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawDashboardClient } from './OrgClawDashboardClient';

export default async function OrgClawPage({ params }) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <OrgClawDashboardClient organizationId={organization.id} />}
    />
  );
}
```

**New file: `src/app/(app)/organizations/[id]/claw/OrgClawDashboardClient.tsx`**

Client component that:

1. Checks `useFeatureFlagEnabled('kiloclaw-org-support')` — if off, show not-found
2. Calls `useKiloClawStatus(organizationId)` (the modified hook)
3. Renders `<ClawDashboard organizationId={organizationId} status={...} />`
4. **No billing wrapper** — org doesn't use personal billing UI
5. **No onboarding wizard** — org instances skip the wizard, go straight to provision

### Step 7: Frontend — Sidebar Nav Entry

**Edit: `src/app/(app)/components/OrganizationAppSidebar.tsx`**

Add to `cloudItems` array (gated by feature flag):

```tsx
const kiloclawOrgEnabled = useFeatureFlagEnabled('kiloclaw-org-support');

// In cloudItems array:
...(kiloclawOrgEnabled ? [{
  title: 'KiloClaw',
  icon: KiloCrabIcon,
  url: `/organizations/${organizationId}/claw`,
}] : []),
```

### Step 8: Frontend — Billing Differences for Org

- **Skip**: `BillingWrapper`, `BillingBanner`, `AccessLockedDialog`, `WelcomePage`, `PlanSelectionDialog`
- **Skip**: Subscription tab in the tab bar
- **Skip**: `ensureProvisionAccess` / earlybird flow
- **Keep**: `CreateInstanceCard` (provision button), all operational tabs (Gateway Process, Settings)

In `ClawDashboard`, conditionally skip billing UI when `organizationId` is present:

```tsx
// No billing wrapper for org instances
if (organizationId) {
  return <ClawDashboardContent organizationId={organizationId} status={status} />;
}
// Personal: wrap with billing
return (
  <BillingWrapper>
    <ClawDashboardContent status={status} />
  </BillingWrapper>
);
```

## File Change Summary

| File                                                               | Action  | Description                                                                        |
| ------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| **Backend**                                                        |         |                                                                                    |
| `src/lib/kiloclaw/instance-registry.ts`                            | Edit    | Add `getActiveOrgInstance`, `listActiveOrgInstances`, `destroyOrgInstancesForUser` |
| `src/routers/organizations/organization-kiloclaw-router.ts`        | **New** | Full org-scoped tRPC router (~30 procedures)                                       |
| `src/routers/organizations/organization-router.ts`                 | Edit    | Mount `kiloclaw` sub-router                                                        |
| `src/routers/organizations/organization-members-router.ts`         | Edit    | Add KiloClaw cleanup after member removal                                          |
| **Frontend — existing component refactors**                        |         |                                                                                    |
| `src/hooks/useKiloClaw.ts`                                         | Edit    | Add `organizationId?` param to all hooks                                           |
| `src/app/(app)/claw/components/ClawDashboard.tsx`                  | Edit    | Accept `organizationId`, skip billing for org                                      |
| `src/app/(app)/claw/components/InstanceControls.tsx`               | Edit    | Accept `organizationId`, branch mutations                                          |
| `src/app/(app)/claw/components/SettingsTab.tsx`                    | Edit    | Accept `organizationId`, branch queries                                            |
| `src/app/(app)/claw/components/InstanceTab.tsx`                    | Edit    | Accept `organizationId`, branch queries                                            |
| `src/app/(app)/claw/components/CreateInstanceCard.tsx`             | Edit    | Accept `organizationId`, branch provision                                          |
| `src/app/(app)/claw/components/ClawHeader.tsx`                     | Edit    | Accept `organizationId` for gateway URL                                            |
| `src/app/(app)/claw/components/PairingSection.tsx`                 | Edit    | Accept `organizationId`                                                            |
| `src/app/(app)/claw/components/VersionPinCard.tsx`                 | Edit    | Accept `organizationId`                                                            |
| `src/app/(app)/claw/page.tsx`                                      | Edit    | Pass `organizationId={undefined}` explicitly                                       |
| **Frontend — new org pages**                                       |         |                                                                                    |
| `src/app/(app)/organizations/[id]/claw/page.tsx`                   | **New** | Org claw server page                                                               |
| `src/app/(app)/organizations/[id]/claw/OrgClawDashboardClient.tsx` | **New** | Org claw client wrapper                                                            |
| `src/app/(app)/components/OrganizationAppSidebar.tsx`              | Edit    | Add KiloClaw nav entry (feature-flag gated)                                        |

## Execution Order

1. **Instance registry functions** — foundation for all backend work
2. **Org tRPC router** — the API surface
3. **Mount router** — wire it into the org router
4. **Member removal cleanup** — the launch blocker
5. **Hook refactoring** — add `organizationId` param to existing hooks
6. **Component refactoring** — thread `organizationId` through dashboard components
7. **Org page + sidebar** — the new pages
8. **Typecheck + test** — verify everything compiles and works

## Decisions Made

| Decision               | Choice                                                 | Rationale                                          |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| Dashboard reuse        | Cloud Agent pattern (prop-drilling + inline branching) | Matches existing codebase convention               |
| Procedure scope        | Full set from day 1                                    | Feature-flag gated anyway, less incremental work   |
| Member removal destroy | After transaction in tRPC handler                      | Keeps DB transaction lean, no network calls in tx  |
| Cardinality            | 1 per (org, user) in Phase 1                           | Enforced in tRPC router provision procedure        |
| Worker changes         | None needed                                            | Proxy access check already correct per plan        |
| Separate hooks file    | No — modify existing hooks                             | Cleaner: one hook per concern, branches internally |
