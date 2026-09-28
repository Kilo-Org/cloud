import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { reconcileSandboxReferences, sessionRuntimeLocator } from './worktree-ownership';
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
const otherControlId = 'workspace_33333333-3333-4333-8333-333333333333';

function buildFixture(sourceWorktreeId: string | null, sourceSessionId: string) {
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
  const getRuntimeLocation = vi.fn<() => Promise<Record<string, unknown> | null>>(async () => ({
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

function fixture(worktree = false) {
  return buildFixture(worktree ? otherWorktreeId : null, controlId);
}

function legacyFixture() {
  return buildFixture(null, legacyId);
}

beforeEach(() => vi.resetAllMocks());

describe('sandbox reference reconciliation', () => {
  it('resolves a legacy root as exclusive without consulting its runtime locator', async () => {
    const f = legacyFixture();
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
    expect(mocks.sandboxSession).not.toHaveBeenCalled();
  });

  it('does not consult a legacy root whose persisted locator names the target', async () => {
    const f = legacyFixture();
    f.getStoredMetadata.mockResolvedValue({
      ...f.metadata,
      workspace: { sandboxId: location.sandboxId },
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
    expect(mocks.sandboxSession).not.toHaveBeenCalled();
  });

  it('does not walk legacy no-worktree owners with no recorded evidence', async () => {
    const f = legacyFixture();
    f.getStoredMetadata.mockResolvedValue(null);
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: Array.from({ length: 5 }, (_, index) => ({
        worktreeId: null,
        organizationId: null,
        sessions: [
          { sessionId: kiloId, cloudAgentSessionId: `agent_${crypto.randomUUID()}${index}` },
        ],
      })),
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
    expect(mocks.sandboxSession).not.toHaveBeenCalled();
  });

  it('blocks on a legacy owner\u2019s recorded allocation without any runtime lookup', async () => {
    const f = legacyFixture();
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          allocationLocation: location,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: legacyId }],
        },
      ],
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: true,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
    expect(mocks.sandboxSession).not.toHaveBeenCalled();
  });

  it('blocks a control-plane no-worktree owner whose locator names the target', async () => {
    const f = fixture();
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: userId,
      organizationId: null,
      sessionId: kiloId,
      worktreeId: null,
      location,
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: true,
      unavailable: false,
    });
    expect(mocks.sandboxSession).toHaveBeenCalledTimes(1);
    expect(mocks.legacySession).not.toHaveBeenCalled();
  });

  it('blocks a worktree owner whose locator names the target', async () => {
    const f = fixture(true);
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: userId,
      organizationId: null,
      sessionId: kiloId,
      worktreeId: otherWorktreeId,
      location,
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: true,
      unavailable: false,
    });
  });

  it('returns unavailable for a control-plane no-worktree owner with no locator or allocation', async () => {
    const f = fixture();
    f.getRuntimeLocation.mockResolvedValue(null);
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: false,
      unavailable: true,
    });
    expect(mocks.sandboxSession).toHaveBeenCalledTimes(1);
    expect(mocks.legacySession).not.toHaveBeenCalled();
  });

  it('keeps walking a no-worktree owner whose sessions mix control and legacy ids', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue(null);
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          sessions: [
            { sessionId: kiloId, cloudAgentSessionId: controlId },
            { sessionId: kiloId, cloudAgentSessionId: legacyId },
          ],
        },
      ],
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.sandboxSession).toHaveBeenCalledTimes(1);
  });

  it('walks both survivor kinds when a control no-worktree owner and a worktree owner are present', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue({
      ...f.metadata,
      identity: { sessionId: legacyId, userId },
      workspace: { sandboxId: otherLocation.sandboxId, worktreeId: otherWorktreeId },
      auth: { kiloSessionId: kiloId },
    });
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
        },
        {
          worktreeId: otherWorktreeId,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: legacyId }],
        },
      ],
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.sandboxSession).toHaveBeenCalledTimes(1);
    expect(mocks.legacySession).toHaveBeenCalledTimes(1);
  });

  it('resolves migrated worktrees using a read-only locator without fencing unrelated sessions', async () => {
    const f = fixture(true);
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(f.getRuntimeLocation).toHaveBeenCalledTimes(1);
    expect(mocks.legacySession).not.toHaveBeenCalled();
  });

  it('uses canonical allocation history for a legacy ownership-only root with no runtime metadata', async () => {
    const f = legacyFixture();
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
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
  });

  it('prefers a control-plane locator over the original allocation after a route change', async () => {
    const f = fixture();
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: userId,
      organizationId: null,
      sessionId: kiloId,
      worktreeId: null,
      location,
    });
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          allocationLocation: otherLocation,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
        },
      ],
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: true,
      unavailable: false,
    });
    expect(mocks.sandboxSession).toHaveBeenCalledTimes(1);
  });

  it('treats a legacy no-worktree owner with no evidence as exclusive', async () => {
    const f = legacyFixture();
    f.getStoredMetadata.mockResolvedValue(null);
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
    expect(mocks.sandboxSession).not.toHaveBeenCalled();
  });

  it('still validates later owners after encountering missing historical ownership', async () => {
    const f = fixture(true);
    f.getStoredMetadata.mockResolvedValue(null);
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: legacyId }],
        },
        {
          worktreeId: otherWorktreeId,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
        },
      ],
    });
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: 'another-owner',
      organizationId: null,
      sessionId: kiloId,
      worktreeId: otherWorktreeId,
      location: otherLocation,
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).rejects.toThrow(
      'worktree_runtime_history_unavailable'
    );
    expect(f.getStoredMetadata).not.toHaveBeenCalled();
  });

  it('rejects a malformed control-plane locator rather than treating it as expired', async () => {
    const f = fixture();
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: userId,
      organizationId: null,
      sessionId: kiloId,
      worktreeId: null,
      location: { sandboxId: 123 },
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).rejects.toThrow();
  });

  it.each(['ownership', 'getRuntimeLocation'] as const)(
    'propagates real %s I/O failures instead of allowing cleanup',
    async method => {
      const f = fixture();
      f[method].mockRejectedValue(new Error('storage unavailable'));
      await expect(reconcileSandboxReferences(f.env, f.params)).rejects.toThrow(
        'storage unavailable'
      );
    }
  );

  it('rejects conflicting ownership metadata instead of inferring a route', async () => {
    const f = fixture(true);
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: 'another-owner',
      organizationId: null,
      sessionId: kiloId,
      worktreeId: otherWorktreeId,
      location: otherLocation,
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).rejects.toThrow(
      'worktree_runtime_history_unavailable'
    );
  });

  it('does not accept an older ambiguous boolean ownership response', async () => {
    const f = fixture();
    f.ownership.mockResolvedValue(false);
    await expect(reconcileSandboxReferences(f.env, f.params)).rejects.toThrow();
    expect(f.getStoredMetadata).not.toHaveBeenCalled();
  });

  it('does not include credentials or transcripts in read-only runtime locators', () => {
    const f = fixture();
    const locator = sessionRuntimeLocator(parseSessionMetadata(f.metadata));
    expect(locator).toMatchObject({ kiloUserId: userId, location: otherLocation });
    expect(JSON.stringify(locator)).not.toContain('private-test-token');
  });

  it('returns a blocking verdict for a shared ledger response without certifying completeness', async () => {
    const f = fixture();
    f.ownership.mockResolvedValue({ kind: 'shared' });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: true,
      unavailable: false,
    });
    expect(f.getRuntimeLocation).not.toHaveBeenCalled();
  });

  it('returns complete only when every owner resolved and none named the sandbox', async () => {
    const f = fixture();
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
        },
        {
          worktreeId: otherWorktreeId,
          organizationId: null,
          sessions: [{ sessionId: null, cloudAgentSessionId: legacyId }],
        },
      ],
    });
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: userId,
      organizationId: null,
      sessionId: kiloId,
      worktreeId: otherWorktreeId,
      location: otherLocation,
    });
    f.getStoredMetadata.mockResolvedValue({
      ...f.metadata,
      identity: { sessionId: legacyId, userId },
      workspace: { sandboxId: otherLocation.sandboxId, worktreeId: otherWorktreeId },
      auth: { kiloSessionId: kiloId },
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: true,
      foreign: false,
      unavailable: false,
    });
  });

  it('returns unavailable rather than complete for an owner with neither locator nor allocation', async () => {
    const f = fixture(true);
    f.getRuntimeLocation.mockResolvedValue(null);
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: false,
      unavailable: true,
    });
  });

  it('returns incomplete instead of throwing when the reconciliation budget expires', async () => {
    const f = fixture(true);
    f.getRuntimeLocation.mockImplementation(() => new Promise<never>(() => {}));
    await expect(
      reconcileSandboxReferences(f.env, f.params, {
        budgetMs: 30,
        concurrency: 8,
        callTimeoutMs: 5_000,
      })
    ).resolves.toEqual({ complete: false, foreign: false, unavailable: false });
  });

  it('bounds a stalled ledger RPC by the same budget', async () => {
    const f = fixture();
    f.ownership.mockImplementation(() => new Promise<never>(() => {}));
    await expect(
      reconcileSandboxReferences(f.env, f.params, {
        budgetMs: 30,
        concurrency: 8,
        callTimeoutMs: 5_000,
      })
    ).resolves.toEqual({ complete: false, foreign: false, unavailable: false });
  });

  it('shares one deadline across the ledger and the locator pool', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const owners = Array.from({ length: 9 }, () => ({
        worktreeId: null,
        organizationId: null,
        sessions: [{ sessionId: null, cloudAgentSessionId: controlId }],
      }));
      f.ownership.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ kind: 'unresolved', owners }), 40))
      );
      f.getRuntimeLocation.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(null), 30))
      );
      const reconciliation = reconcileSandboxReferences(f.env, f.params, {
        budgetMs: 120,
        concurrency: 2,
        callTimeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(reconciliation).resolves.toEqual({
        complete: false,
        foreign: false,
        unavailable: false,
      });
      expect(mocks.sandboxSession).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an earlier owner\u2019s foreign allocation instead of a later owner\u2019s identity conflict', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue(null);
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: 'another-owner',
      organizationId: null,
      sessionId: kiloId,
      worktreeId: otherWorktreeId,
      location: otherLocation,
    });
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          allocationLocation: location,
          sessions: [{ sessionId: null, cloudAgentSessionId: legacyId }],
        },
        {
          worktreeId: otherWorktreeId,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
        },
      ],
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).resolves.toEqual({
      complete: false,
      foreign: true,
      unavailable: false,
    });
    expect(mocks.legacySession).not.toHaveBeenCalled();
  });

  it('throws an earlier owner\u2019s identity conflict instead of accepting a later owner\u2019s foreign allocation', async () => {
    const f = fixture();
    f.getStoredMetadata.mockResolvedValue(null);
    f.getRuntimeLocation.mockResolvedValue({
      cloudAgentSessionId: controlId,
      kiloUserId: 'another-owner',
      organizationId: null,
      sessionId: kiloId,
      worktreeId: otherWorktreeId,
      location: otherLocation,
    });
    f.ownership.mockResolvedValue({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: otherWorktreeId,
          organizationId: null,
          sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
        },
        {
          worktreeId: null,
          organizationId: null,
          allocationLocation: location,
          sessions: [{ sessionId: null, cloudAgentSessionId: legacyId }],
        },
      ],
    });
    await expect(reconcileSandboxReferences(f.env, f.params)).rejects.toThrow(
      'worktree_runtime_history_unavailable'
    );
  });

  it('returns incomplete when an earlier owner exhausts the budget before a later owner errors', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      mocks.sandboxSession.mockImplementation(
        (_env: unknown, _ownerId: unknown, sessionId: string) =>
          sessionId === controlId
            ? { getRuntimeLocation: () => new Promise<never>(() => {}) }
            : {
                getRuntimeLocation: async () => ({
                  cloudAgentSessionId: otherControlId,
                  kiloUserId: 'another-owner',
                  organizationId: null,
                  sessionId: kiloId,
                  worktreeId: otherWorktreeId,
                  location: otherLocation,
                }),
              }
      );
      f.ownership.mockResolvedValue({
        kind: 'unresolved',
        owners: [
          {
            worktreeId: null,
            organizationId: null,
            sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
          },
          {
            worktreeId: otherWorktreeId,
            organizationId: null,
            sessions: [{ sessionId: kiloId, cloudAgentSessionId: otherControlId }],
          },
        ],
      });
      const reconciliation = expect(
        reconcileSandboxReferences(f.env, f.params, {
          budgetMs: 1_000,
          concurrency: 2,
          callTimeoutMs: 5_000,
        })
      ).resolves.toEqual({
        complete: false,
        foreign: false,
        unavailable: false,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.sandboxSession).toHaveBeenCalledWith(f.env, userId, controlId);
      await vi.advanceTimersByTimeAsync(1_100);
      await reconciliation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws an earlier owner\u2019s error even when a later owner exhausts the budget', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      mocks.sandboxSession.mockImplementation(
        (_env: unknown, _ownerId: unknown, sessionId: string) =>
          sessionId === controlId
            ? { getRuntimeLocation: () => new Promise<never>(() => {}) }
            : {
                getRuntimeLocation: async () => ({
                  cloudAgentSessionId: otherControlId,
                  kiloUserId: 'another-owner',
                  organizationId: null,
                  sessionId: kiloId,
                  worktreeId: otherWorktreeId,
                  location: otherLocation,
                }),
              }
      );
      f.ownership.mockResolvedValue({
        kind: 'unresolved',
        owners: [
          {
            worktreeId: otherWorktreeId,
            organizationId: null,
            sessions: [{ sessionId: kiloId, cloudAgentSessionId: otherControlId }],
          },
          {
            worktreeId: null,
            organizationId: null,
            sessions: [{ sessionId: kiloId, cloudAgentSessionId: controlId }],
          },
        ],
      });
      const rejection = expect(
        reconcileSandboxReferences(f.env, f.params, {
          budgetMs: 1_000,
          concurrency: 2,
          callTimeoutMs: 5_000,
        })
      ).rejects.toThrow('worktree_runtime_history_unavailable');
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.sandboxSession).toHaveBeenCalledWith(f.env, userId, controlId);
      await vi.advanceTimersByTimeAsync(1_100);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops dispatching locators once the reconciliation budget expires', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.ownership.mockResolvedValue({
        kind: 'unresolved',
        owners: Array.from({ length: 20 }, () => ({
          worktreeId: null,
          organizationId: null,
          sessions: [{ sessionId: null, cloudAgentSessionId: controlId }],
        })),
      });
      f.getRuntimeLocation.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(null), 30))
      );
      const reconciliation = reconcileSandboxReferences(f.env, f.params, {
        budgetMs: 100,
        concurrency: 2,
        callTimeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(200);
      const dispatched = mocks.sandboxSession.mock.calls.length;
      expect(dispatched).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.sandboxSession.mock.calls.length).toBe(dispatched);
      await expect(reconciliation).resolves.toEqual({
        complete: false,
        foreign: false,
        unavailable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not seed references from locators or owners', async () => {
    const f = fixture();
    const result = await reconcileSandboxReferences(f.env, f.params);
    expect(Object.keys(result).sort()).toEqual(['complete', 'foreign', 'unavailable']);
  });
});
