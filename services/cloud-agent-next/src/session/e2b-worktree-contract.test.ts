import { describe, expect, it } from 'vitest';
import {
  canDestroyCloudAgentWorktreeSandboxResultSchema,
  cloudAgentWorktreeDeletionStateSchema,
  cloudAgentWorktreeLocationSchema,
  createSessionForCloudAgentSchema,
  recordCloudAgentWorktreeCleanupSchema,
} from '@kilocode/session-ingest-contracts';

const worktreeId = 'worktree_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'ses_12345678901234567890123456';
const location = { sandboxId: 'ses-abcdef', provider: 'e2b' };

describe('E2B shared worktree contract readers', () => {
  it('preserves the E2B provider through creation, cleanup, and deletion state', () => {
    expect(
      createSessionForCloudAgentSchema.parse({
        sessionId,
        kiloUserId: 'oauth/user',
        cloudAgentSessionId,
        cloudAgentWorktreeId: worktreeId,
        cloudAgentWorktreeLocation: location,
        createdOnPlatform: 'cloud-agent-web',
      }).cloudAgentWorktreeLocation
    ).toEqual(location);
    expect(
      recordCloudAgentWorktreeCleanupSchema.parse({
        worktreeId,
        kiloUserId: 'oauth/user',
        runtimeLocations: [location],
      }).runtimeLocations
    ).toEqual([location]);
    expect(
      cloudAgentWorktreeDeletionStateSchema.parse({
        completed: false,
        manifest: { version: 1, sessions: [{ sessionId, cloudAgentSessionId }] },
        runtimeLocations: [location],
      }).runtimeLocations
    ).toEqual([location]);
  });

  it('keeps unresolved E2B cleanup ownership readable without embedding credentials', () => {
    const unresolved = {
      kind: 'unresolved',
      owners: [
        {
          worktreeId,
          organizationId: null,
          allocationLocation: location,
          sessions: [{ sessionId, cloudAgentSessionId }],
        },
      ],
    };
    expect(canDestroyCloudAgentWorktreeSandboxResultSchema.parse(unresolved)).toEqual(unresolved);
    expect(
      cloudAgentWorktreeLocationSchema.safeParse({
        ...location,
        credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }).success
    ).toBe(false);
    expect(
      cloudAgentWorktreeLocationSchema.safeParse({ ...location, provider: 'unsupported' }).success
    ).toBe(false);
  });
});
