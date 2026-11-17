import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from '../../runtime-credential-proxy.js';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import {
  authorizeSessionSyncLive,
  type SessionSyncLiveSnapshot,
  type SessionSyncLiveRootPeer,
} from './session-sync-live-authority.js';
import { addAcceptedHandleSync, digestRuntimeProxyHandle } from './accepted-handles.js';
import { OrganizationAccessRevokedError } from './organization-membership.js';

async function fixture() {
  const env = { NEXTAUTH_SECRET: 'synthetic-sandbox-live-signing-secret' };
  const sessionId = 'workspace_syntheticroot';
  const kiloSessionId = `ses_${'a'.repeat(26)}`;
  const fence = {
    plane: 'control' as const,
    allocationId: 'synthetic-allocation',
    providerInstanceId: 'synthetic-provider',
    connectionId: 'synthetic-connection',
    wrapperInstanceId: 'synthetic-wrapper',
  };
  const rawGrant = createRuntimeProxyGrant({
    ...fence,
    authorizationId: crypto.randomUUID(),
    sessionId,
    kiloSessionId,
    userId: 'synthetic-owner',
    mode: 'contained',
    leaseExpiresAt: Date.now() + 300_000,
    state: 'active',
  });
  const handle = await issueRuntimeCredentialProxyHandle(env, rawGrant);
  const grant = {
    scopeId: 'worktree_synthetic',
    directory: '/workspace/synthetic',
    userId: rawGrant.userId,
    expiresAt: Date.now() + 3_600_000,
    members: [{ sessionId, kiloSessionId }],
    kilo: {
      runtimeProxy: { members: [{ sessionId, kiloSessionId, handle: 'synthetic-new-canonical' }] },
    },
  } as SessionCredentialGrant;
  const route = {
    sessionId,
    state: 'ready',
    spec: { sessionId, kiloSessionId, directory: grant.directory },
    grant,
    credentialSource: { userId: rawGrant.userId, kiloSessionId, chat: { transport: 'relay' } },
    attemptDeadlineAt: Date.now() + 60_000,
  } as SessionSyncLiveSnapshot['routes'][number];
  const snapshot: SessionSyncLiveSnapshot = {
    ownerId: rawGrant.userId,
    fence,
    harness: 'kilo2',
    grants: [grant],
    routes: [route],
  };
  const values = new Map<string, unknown>();
  const kv = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: (key: string) => values.delete(key),
    list: () => values.entries(),
  };
  const storage = {
    get: async <T>(key: string) => kv.get<T>(key),
    put: async (key: string, value: unknown) => kv.put(key, value),
    delete: async (key: string) => kv.delete(key),
  };
  addAcceptedHandleSync(kv, `${grant.scopeId}:runtime`, {
    handle,
    handleDigest: await digestRuntimeProxyHandle(handle),
    issuerSessionId: sessionId,
    scopeId: grant.scopeId,
    exp: rawGrant.leaseExpiresAt,
    fence: { ...fence },
  });
  const peer: SessionSyncLiveRootPeer = {
    getSessionSyncLiveRootGrantProof: vi.fn(async input => {
      const { handle: _handle, ...context } = input;
      return { type: 'allowed', ...context, expiresAt: rawGrant.leaseExpiresAt };
    }),
    getRuntimeProxyDelegationExpiresAt: vi.fn(async () => Date.now() + 3_600_000),
  };
  const dependencies = {
    env,
    sandboxId: 'synthetic-sandbox',
    storage,
    read: async () => structuredClone(snapshot),
    peer: () => peer,
    requireMembership: vi.fn(async () => {}),
  };
  const request = {
    authorization: { type: 'handle' as const, handle },
    ownerId: rawGrant.userId,
    sessionId,
    kiloSessionId,
    nativeSessionId: kiloSessionId,
    directory: grant.directory,
    deadlineAt: Date.now() + 4_000,
  };
  return { snapshot, grant, route, request, dependencies, peer, values, handle };
}

describe('Sandbox Session Sync live authority', () => {
  it('accepts an older exact unexpired same-fence handle, not only the canonical string', async () => {
    const f = await fixture();
    const result = await authorizeSessionSyncLive(f.request, f.dependencies);
    expect(result).toMatchObject({
      type: 'allowed',
      authorization: { liveIdentity: { allocationId: f.snapshot.fence?.allocationId } },
    });
    expect(f.peer.getSessionSyncLiveRootGrantProof).not.toHaveBeenCalled();
    if (result.type === 'allowed')
      expect(result.authorization.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it.each(['allocation', 'provider', 'wrapper', 'member', 'scope', 'owner', 'expired'])(
    'denies a stale %s',
    async mismatch => {
      const f = await fixture();
      if (mismatch === 'allocation' && f.snapshot.fence)
        f.snapshot.fence.allocationId = 'synthetic-old-allocation';
      if (mismatch === 'provider' && f.snapshot.fence)
        f.snapshot.fence.providerInstanceId = 'synthetic-old-provider';
      if (mismatch === 'wrapper' && f.snapshot.fence)
        f.snapshot.fence.wrapperInstanceId = 'synthetic-old-wrapper';
      if (mismatch === 'member') f.grant.members = [];
      if (mismatch === 'scope') f.grant.scopeId = 'worktree_other';
      if (mismatch === 'owner') f.snapshot.ownerId = 'synthetic-other-owner';
      if (mismatch === 'expired') f.grant.expiresAt = Date.now() - 1;
      expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
        type: 'denied',
      });
    }
  );

  it('requires positive local proof when a provisioned standalone has no accepted entries', async () => {
    const f = await fixture();
    f.values.clear();
    f.grant.scopeId = f.request.sessionId;
    if (f.grant.kilo.runtimeProxy) f.grant.kilo.runtimeProxy.members[0].handle = f.handle;
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'allowed',
    });
    expect(f.peer.getSessionSyncLiveRootGrantProof).toHaveBeenCalledOnce();
    vi.mocked(f.peer.getSessionSyncLiveRootGrantProof).mockResolvedValue({ type: 'denied' });
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'denied',
    });
  });

  it('rejects physical replacement during the local root proof await', async () => {
    const f = await fixture();
    f.values.clear();
    f.grant.scopeId = f.request.sessionId;
    if (f.grant.kilo.runtimeProxy) f.grant.kilo.runtimeProxy.members[0].handle = f.handle;
    const original = f.peer.getSessionSyncLiveRootGrantProof;
    f.peer.getSessionSyncLiveRootGrantProof = async input => {
      const proof = await original(input);
      if (f.snapshot.fence) f.snapshot.fence.providerInstanceId = 'synthetic-replacement';
      return proof;
    };
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'denied',
    });
  });

  it('denies membership removal and re-reads membership state after external I/O', async () => {
    const f = await fixture();
    f.dependencies.requireMembership.mockImplementation(async () => {
      f.grant.members = [];
    });
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'denied',
    });
    const revoked = await fixture();
    revoked.dependencies.requireMembership.mockRejectedValue(new OrganizationAccessRevokedError());
    expect(await authorizeSessionSyncLive(revoked.request, revoked.dependencies)).toMatchObject({
      type: 'denied',
    });
  });

  it('rechecks issued identity without a long handle and survives canonical refresh and socket reconnect', async () => {
    const f = await fixture();
    const mint = await authorizeSessionSyncLive(f.request, f.dependencies);
    if (mint.type !== 'allowed') throw new Error('Expected mint');
    f.values.clear();
    if (f.snapshot.fence) f.snapshot.fence.connectionId = 'synthetic-reconnected';
    const { expiresAt: _expiry, ...identity } = mint.authorization;
    const request = { ...f.request, authorization: { type: 'ticket', ...identity } };
    expect(await authorizeSessionSyncLive(request, f.dependencies)).toMatchObject({
      type: 'allowed',
    });
    vi.mocked(f.peer.getRuntimeProxyDelegationExpiresAt).mockResolvedValue(null);
    expect(await authorizeSessionSyncLive(request, f.dependencies)).toMatchObject({
      type: 'denied',
    });
  });

  it('bounds pending adoption, denies failed/cap-refused routes, and rejects known v1', async () => {
    const f = await fixture();
    f.snapshot.grants = [];
    f.route.grant = null;
    f.route.state = 'preparing';
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'unavailable',
    });
    f.route.attemptDeadlineAt = Date.now() - 1;
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'denied',
    });
    f.route.state = 'failed';
    f.route.attemptDeadlineAt = Date.now() + 60_000;
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'denied',
    });
    f.route.state = 'preparing';
    f.snapshot.harness = 'kilo';
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toEqual({
      type: 'denied',
      code: 'hosted_live_not_enabled',
    });
  });

  it('returns unavailable for a dependency outage without inventing authority', async () => {
    const f = await fixture();
    vi.mocked(f.peer.getRuntimeProxyDelegationExpiresAt).mockRejectedValue(
      new Error('synthetic outage')
    );
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toEqual({
      type: 'unavailable',
      code: 'auth_unavailable',
    });
  });

  it('uses the shared retry owner for a transient dependency failure', async () => {
    const f = await fixture();
    vi.mocked(f.peer.getRuntimeProxyDelegationExpiresAt).mockRejectedValueOnce(
      Object.assign(new Error('Synthetic transient outage'), { retryable: true })
    );
    expect(await authorizeSessionSyncLive(f.request, f.dependencies)).toMatchObject({
      type: 'allowed',
    });
    expect(f.peer.getRuntimeProxyDelegationExpiresAt).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled dependency within one four-second authorization budget', async () => {
    const blocked = await fixture();
    vi.useFakeTimers();
    try {
      blocked.dependencies.requireMembership.mockImplementation(() => new Promise(() => {}));
      const start = Date.now();
      const pending = authorizeSessionSyncLive(blocked.request, blocked.dependencies);
      await vi.waitFor(() => expect(blocked.dependencies.requireMembership).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(blocked.request.deadlineAt - Date.now());
      expect(await pending).toEqual({ type: 'unavailable', code: 'auth_unavailable' });
      expect(Date.now() - start).toBeLessThanOrEqual(4_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
