import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { resolveSandboxExclusivity, sessionRuntimeLocator } from './worktree-ownership';
import { parseSessionMetadata } from '../persistence/session-metadata';

const mocks = vi.hoisted(() => ({ sandboxSession: vi.fn(), legacySession: vi.fn() }));
vi.mock('../sandbox-session/session-stub', () => ({
  getSandboxSessionStub: mocks.sandboxSession,
  resolveSessionStub: mocks.legacySession,
}));

const userId = 'oauth/github:runtime-owner';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const otherWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const location = { sandboxId: `usr-${'a'.repeat(48)}`, provider: 'cloudflare' as const };
const otherLocation = { sandboxId: `usr-${'b'.repeat(48)}`, provider: 'cloudflare' as const };
const kiloId = 'ses_00000000000000000000000001';
const legacyId = 'agent_33333333-3333-4333-8333-333333333333';
const controlId = 'workspace_22222222-2222-4222-8222-222222222222';

function fixture(controlPlane = false) {
  const sourceWorktreeId = controlPlane ? otherWorktreeId : null;
  const sourceSessionId = controlPlane ? controlId : legacyId;
  const ownership = vi.fn<() => Promise<unknown>>(async () => ({
    kind: 'unresolved',
    owners: [
      {
        worktreeId: sourceWorktreeId,
        organizationId: null,
        sessions: [{ sessionId: kiloId, cloudAgentSessionId: sourceSessionId }],
      },
    ],
  }));
  const env: Env = { SESSION_INGEST: { canDestroyCloudAgentWorktreeSandbox: ownership } } as never;
  const getRuntimeLocation = vi.fn(async () => ({
    cloudAgentSessionId: sourceSessionId,
    kiloUserId: userId,
    organizationId: null,
    sessionId: kiloId,
    worktreeId: sourceWorktreeId,
    location: otherLocation,
  }));
  const metadata = {
    metadataSchemaVersion: 2,
    identity: { sessionId: sourceSessionId, userId },
    auth: { kiloSessionId: kiloId, kilocodeToken: 'private-test-token' },
    workspace: { sandboxId: otherLocation.sandboxId },
    lifecycle: { timestamp: 1, version: 1 },
  };
  const getStoredMetadata = vi.fn<() => Promise<unknown>>(async () => metadata);
  mocks.sandboxSession.mockReturnValue({ getRuntimeLocation });
  mocks.legacySession.mockReturnValue({
    getRuntimeLocation: async () => {
      const stored = await getStoredMetadata();
      return stored ? sessionRuntimeLocator(parseSessionMetadata(stored)) : null;
    },
  });
  const params = { worktreeId, kiloUserId: userId, location, releasedWorktreeIds: [] } as const;
  return {
    env,
    params: { ...params, releasedWorktreeIds: [] },
    metadata,
    getStoredMetadata,
    getRuntimeLocation,
    ownership,
  };
}

beforeEach(() => vi.resetAllMocks());

describe('physical sandbox ownership resolution', () => {
  it('resolves unrelated legacy roots from original metadata instead of treating the whole owner as sharing', async () => {
    const f = fixture();
    await expect(resolveSandboxExclusivity(f.env, f.params)).resolves.toBe(true);
    expect(mocks.legacySession).toHaveBeenCalledWith(f.env, userId, legacyId);
  });

  it('preserves confirmed legacy sharing on the exact persisted route', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue({
      ...f.metadata,
      workspace: { sandboxId: location.sandboxId },
    });
    await expect(resolveSandboxExclusivity(f.env, f.params)).resolves.toBe(false);
  });

  it('resolves migrated worktrees using a read-only locator without fencing unrelated sessions', async () => {
    const f = fixture(true);
    await expect(resolveSandboxExclusivity(f.env, f.params)).resolves.toBe(true);
    expect(f.getRuntimeLocation).toHaveBeenCalledTimes(1);
    expect(mocks.legacySession).not.toHaveBeenCalled();
  });

  it('uses canonical allocation history for a legacy ownership-only root with no runtime metadata', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue(null);
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          allocationLocation: otherLocation,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: legacyId }],
        },
      ],
    });
    await expect(resolveSandboxExclusivity(f.env, f.params)).resolves.toBe(true);
  });

  it('prefers current persisted legacy routing over the original allocation after a route change', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue({
      ...f.metadata,
      workspace: { sandboxId: location.sandboxId },
    });
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          allocationLocation: otherLocation,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: legacyId }],
        },
      ],
    });
    await expect(resolveSandboxExclusivity(f.env, f.params)).resolves.toBe(false);
  });

  it('does not report unknown history as confirmed sharing', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue(null);
    await expect(resolveSandboxExclusivity(f.env, f.params)).rejects.toThrow(
      'worktree_runtime_history_unavailable'
    );
  });

  it('rejects conflicting ownership metadata instead of inferring a route', async () => {
    const f = fixture(true);
    f.getRuntimeLocation.mockResolvedValue({
      ...(await f.getRuntimeLocation()),
      kiloUserId: 'another-owner',
    });
    await expect(resolveSandboxExclusivity(f.env, f.params)).rejects.toThrow(
      'worktree_runtime_history_unavailable'
    );
  });

  it('does not accept an older ambiguous boolean ownership response', async () => {
    const f = fixture();
    f.ownership.mockResolvedValue(false);
    await expect(resolveSandboxExclusivity(f.env, f.params)).rejects.toThrow();
    expect(f.getStoredMetadata).not.toHaveBeenCalled();
  });

  it('does not include credentials or transcripts in read-only runtime locators', () => {
    const f = fixture();
    const locator = sessionRuntimeLocator(parseSessionMetadata(f.metadata));
    expect(locator).toMatchObject({ kiloUserId: userId, location: otherLocation });
    expect(JSON.stringify(locator)).not.toContain('private-test-token');
  });
});
