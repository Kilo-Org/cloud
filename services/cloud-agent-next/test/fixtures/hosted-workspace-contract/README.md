# Hosted workspace contract fixture (v2)

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
| `listHostedWorkspaceProfiles` | query | Personal and organization profiles with default flags |
| `setHostedWorkspacePersonalDefaultProfile` | mutation | Set the caller's personal default profile |
| `clearHostedWorkspacePersonalDefaultProfile` | mutation | Clear the caller's personal default profile |
| `deleteHostedWorkspaceSession` | mutation | Delete one non-final root session |
| `deleteWorktree` | mutation | Destructively delete the workspace and every remaining root |

## Versioning

- `v1.json` is the released contract. It is **append-only**: never change an
  example, field list, enum or error code in place, because a provider pinned to
  v1 would silently change behavior.
- `v2.json` is the current contract. It adds the hosted workspace profile
  listing and personal-default mutations while retaining every v1 procedure and
  shape.
- Further breaking or additive contract changes create a new fixture plus a new
  `contractVersion`, and the README documents the difference.
- `test/unit/hosted-workspace-contract-fixture.test.ts` fails when a fixture
  field list, enum, error code, procedure registration or deletion-manifest
  version drifts from the handler schemas. That failure is the signal to add a
  new version, not to edit an existing one.
- `deletionManifestVersion` is the `cloudAgentWorktreeDeletionManifestSchema`
  version stored on a completed workspace tombstone.

## Consumers

- `test/e2e/scenarios-hosted-workspace-contract.ts` asserts the live behavior
  this file describes: authorization, idempotent creation, one sandbox per workspace
  that its sibling chats share, abort isolation, passive no-wake reads, idle shutdown and wake,
  separate repository workspaces, and journaled workspace deletion.
- A future Session Host or generated SDK should pin a version and assert against
  these examples rather than re-deriving shapes from ad-hoc notes.
