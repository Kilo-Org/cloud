# Hosted workspace contract fixture (v1)

Versioned request/response examples, procedure list, status enums and stable
error codes for the Cloud workspace-first surface an Agent Manager Session Host
consumes.

| Procedure | Kind | Purpose |
|---|---|---|
| `listHostedWorkspaces` | query | Owner-scoped workspace catalog |
| `getHostedWorkspace` | query | One workspace with its root sessions |
| `getHostedWorkspaceStatus` | query | Passive compute/activity/wake/billing/deletion projection |
| `createHostedWorkspace` | mutation | Create a workspace and its first root |
| `createHostedWorkspaceSession` | mutation | Add a root session to an existing workspace |
| `deleteHostedWorkspaceSession` | mutation | Delete one non-final root session |
| `deleteWorktree` | mutation | Destructively delete the workspace and every remaining root |

## Versioning

- `v1.json` is the released contract. It is **append-only**: never change an
  example, field list, enum or error code in place, because a provider pinned to
  v1 would silently change behavior.
- A breaking or additive contract change creates `v2.json` plus a new
  `contractVersion`, and the README documents the difference.
- `test/unit/hosted-workspace-contract-fixture.test.ts` fails when a fixture
  field list, enum, error code, procedure registration or deletion-manifest
  version drifts from the handler schemas. That failure is the signal to add a
  new version, not to edit v1.
- `deletionManifestVersion` is the `cloudAgentWorktreeDeletionManifestSchema`
  version stored on a completed workspace tombstone.

## Consumers

- `test/e2e/scenarios-hosted-workspace-contract.ts` asserts the live behavior
  this file describes: authorization, idempotent creation, one shared sandbox per
  workspace, abort isolation, passive no-wake reads, idle shutdown and wake,
  separate repository workspaces, and journaled workspace deletion.
- A future Session Host or generated SDK should pin a version and assert against
  these examples rather than re-deriving shapes from ad-hoc notes.
