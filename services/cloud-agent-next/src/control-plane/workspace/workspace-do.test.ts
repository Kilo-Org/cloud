import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';
import {
  RuntimeAuthorizationRevokedError,
  sealRuntimeAuthorization,
  unsealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { WorkspaceAuthoritySeed } from '../../cloud-agent-authority.js';
import type { Env } from '../../types.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { renew } = vi.hoisted(() => ({ renew: vi.fn() }));
vi.mock('@kilocode/worker-utils/runtime-authorization', async importActual => ({
  ...(await importActual<typeof RuntimeAuthorizationModule>()),
  renewRuntimeAuthorization: renew,
}));

const { CloudAgentWorkspaceDO } = await import('./workspace-do.js');

const secret = 'workspace-authority-fixture-secret';
const now = new Date('2026-10-13T19:00:00Z');
const ownerId = 'oauth/fixture-user';
const workspaceSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const siblingSessionId = 'workspace_12345678-1234-4234-8234-123456789abd';
const childSessionId = 'workspace_22345678-1234-4234-8234-123456789abc';
const worktreeId = 'worktree_12345678-1234-4234-8234-123456789abc';
const authorizationId = '12345678-1234-4234-8234-123456789abc';
const binding = { workspaceSessionId, worktreeId, ownerId, organizationId: null };

function authorization(overrides: Partial<RuntimeAuthorization> = {}): RuntimeAuthorization {
  return {
    version: 1,
    id: authorizationId,
    resourceKind: 'cloud-agent-next',
    resourceId: workspaceSessionId,
    userId: ownerId,
    authorizationUserId: ownerId,
    issuedAt: now.toISOString(),
    delegationExpiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    state: 'active',
    bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'a'.repeat(64) },
    source: { admissionSource: 'user', createdOnPlatform: 'cloud-agent-web' },
    env: 'production',
    ...overrides,
  };
}

function anchorMetadata(): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: workspaceSessionId,
      userId: ownerId,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: 'ses_12345678901234567890123456' },
    allowSubagentSessions: true,
    workspace: { worktreeId },
    lifecycle: { version: now.getTime(), timestamp: now.getTime() },
  };
}

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === 'string') {
      this.values.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, structuredClone(entryValue));
    }
  }
  async delete(key: string | string[]): Promise<void> {
    for (const entry of Array.isArray(key) ? key : [key]) this.values.delete(entry);
  }
  async list(options: { prefix?: string; startAfter?: string; limit?: number }) {
    const keys = [...this.values.keys()]
      .filter(key => key.startsWith(options.prefix ?? ''))
      .filter(key => options.startAfter === undefined || key > options.startAfter)
      .sort()
      .slice(0, options.limit ?? 1000);
    return new Map(keys.map(key => [key, structuredClone(this.values.get(key))]));
  }
}

type Fixture = {
  workspace: InstanceType<typeof CloudAgentWorkspaceDO>;
  storage: MemoryStorage;
  seed: { current: WorkspaceAuthoritySeed | null };
  exportSeed: ReturnType<typeof vi.fn>;
};

function fixture(options: { name?: string } = {}): Fixture {
  const storage = new MemoryStorage();
  const seed: { current: WorkspaceAuthoritySeed | null } = {
    current: {
      metadata: anchorMetadata(),
      authorization: authorization(),
      children: [{ cloudAgentSessionId: childSessionId, initialMessageId: 'msg_initial' }],
    },
  };
  const exportSeed = vi.fn(async () => structuredClone(seed.current));
  const env = {
    NEXTAUTH_SECRET: secret,
    HYPERDRIVE: { connectionString: 'postgres://fixture' },
    SANDBOX_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ exportWorkspaceAuthoritySeed: exportSeed }),
    },
  } as unknown as Env;
  const ctx = {
    id: { name: options.name ?? `${ownerId}:${workspaceSessionId}` },
    storage,
  } as unknown as DurableObjectState;
  return { workspace: new CloudAgentWorkspaceDO(ctx, env), storage, seed, exportSeed };
}

function scopeOf(token: string | undefined) {
  return (jwt.decode(token ?? '') as { cloudAgentAuthority: Record<string, unknown> })
    .cloudAgentAuthority;
}

async function freshSeal(overrides: Partial<RuntimeAuthorization> = {}) {
  return sealRuntimeAuthorization(
    authorization({
      id: '32345678-1234-4234-8234-123456789abc',
      issuedAt: new Date().toISOString(),
      delegationExpiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      ...overrides,
    }),
    secret
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  renew.mockReset();
  renew.mockImplementation(
    async ({ authorization: record }: { authorization: RuntimeAuthorization }) =>
      signModernKiloToken({
        userId: record.userId,
        pepper: 'current-account-pepper',
        secret,
        audience: ['kilo-api', 'kilo-gateway', 'session-ingest'],
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        expiresInSeconds: 3600,
        extra: {
          runtimeAuthorization: {
            id: record.id,
            resourceKind: record.resourceKind,
            resourceId: record.resourceId,
          },
        },
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('workspace MCP authority', () => {
  it('adopts the creating chat once and issues a workspace-scoped credential', async () => {
    const { workspace, exportSeed } = fixture();
    const issued = await workspace.issueMcpGrant(binding);
    expect(scopeOf(issued?.token)).toEqual({
      version: 1,
      ownerId,
      parentSessionId: workspaceSessionId,
      organizationId: null,
      authorizationId,
      expiresAt: Math.floor(now.getTime() / 1000) + 24 * 3600,
    });
    await workspace.issueMcpGrant(binding);
    expect(exportSeed).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(await workspace.listChildren({ limit: 5 })).toEqual({
      sessions: [{ cloudAgentSessionId: childSessionId, initialMessageId: 'msg_initial' }],
    });
  });

  it('keeps issuing after the creating chat is deleted', async () => {
    const { workspace, seed } = fixture();
    await workspace.describe();
    seed.current = null;
    await expect(workspace.issueMcpGrant(binding)).resolves.toMatchObject({
      expiresAt: Math.floor(now.getTime() / 1000) + 24 * 3600,
    });
  });

  it('issues nothing for a workspace whose creating chat cannot launch or is gone', async () => {
    const { workspace, seed } = fixture();
    seed.current = null;
    await expect(workspace.issueMcpGrant(binding)).resolves.toBeUndefined();
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'unestablished' });
    expect(renew).not.toHaveBeenCalled();
  });

  it('asks a creating chat that cannot launch again only after a bounded wait', async () => {
    const { workspace, seed, exportSeed } = fixture();
    seed.current = null;
    await workspace.describe();
    await workspace.issueMcpGrant(binding);
    expect(exportSeed).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now.getTime() + 10 * 60_000 + 1);
    await workspace.describe();
    expect(exportSeed).toHaveBeenCalledTimes(2);
  });

  it.each([
    { worktreeId: 'worktree_22345678-1234-4234-8234-123456789abc' },
    { ownerId: 'other-user' },
    { organizationId: 'other-organization' },
    { workspaceSessionId: siblingSessionId },
  ])('issues nothing for a route bound elsewhere %j', async mismatch => {
    const { workspace } = fixture();
    await expect(workspace.issueMcpGrant({ ...binding, ...mismatch })).resolves.toBeUndefined();
    expect(renew).not.toHaveBeenCalled();
  });

  it('refuses a Durable Object named for a different owner than the adopted chat', async () => {
    const { workspace } = fixture({ name: `other-user:${workspaceSessionId}` });
    await expect(
      workspace.issueMcpGrant({ ...binding, ownerId: 'other-user' })
    ).resolves.toBeUndefined();
  });
});

describe('workspace authority expiry and renewal', () => {
  it('issues nothing once expired, and restores only through a fresh owner delegation', async () => {
    const { workspace } = fixture();
    const first = await workspace.issueMcpGrant(binding);
    vi.setSystemTime(now.getTime() + 24 * 3600_000 + 1_000);
    await expect(workspace.issueMcpGrant(binding)).resolves.toBeUndefined();
    await expect(workspace.describe()).resolves.toMatchObject({
      state: 'expired',
      authorizationId,
    });

    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: authorizationId,
        runtimeAuthorizationSeal: await freshSeal(),
      })
    ).resolves.toEqual({ status: 'renewed' });
    const renewed = await workspace.issueMcpGrant(binding);
    expect(scopeOf(renewed?.token)).toMatchObject({
      authorizationId: '32345678-1234-4234-8234-123456789abc',
    });
    await expect(workspace.assertAuthority(scopeOf(first?.token))).rejects.toThrow(
      'Cloud Agent parent authority denied'
    );
    await expect(workspace.assertAuthority(scopeOf(renewed?.token))).resolves.toBeUndefined();
  });

  it.each([
    ['another owner', { userId: 'other-user' }],
    ['another organization', { organizationId: 'other-organization' }],
    ['another resource', { resourceId: siblingSessionId }],
    ['a revoked delegation', { state: 'revoked' as const }],
  ])('refuses renewal from %s', async (_name, overrides) => {
    const { workspace } = fixture();
    await workspace.describe();
    vi.setSystemTime(now.getTime() + 24 * 3600_000 + 1_000);
    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: authorizationId,
        runtimeAuthorizationSeal: await freshSeal(overrides),
      })
    ).resolves.toEqual({ status: 'denied' });
  });

  it('leaves an active authority unchanged and retries on a changed one', async () => {
    const { workspace } = fixture();
    await workspace.describe();
    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: authorizationId,
        runtimeAuthorizationSeal: await freshSeal(),
      })
    ).resolves.toEqual({ status: 'not-needed' });
    vi.setSystemTime(now.getTime() + 24 * 3600_000 + 1_000);
    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: '42345678-1234-4234-8234-123456789abc',
        runtimeAuthorizationSeal: await freshSeal(),
      })
    ).resolves.toEqual({ status: 'retry' });
  });
});

describe('workspace authority revocation', () => {
  it('persists a failed live binding check, which no renewal, restart or stale token restores', async () => {
    const { workspace } = fixture();
    const issued = await workspace.issueMcpGrant(binding);
    renew.mockImplementationOnce(async ({ onBindingRejected }) => {
      onBindingRejected?.('membership_missing');
      throw new RuntimeAuthorizationRevokedError();
    });
    await expect(workspace.assertAuthority(scopeOf(issued?.token))).rejects.toThrow(
      'Cloud Agent parent authority denied'
    );
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'revoked' });
    await expect(workspace.issueMcpGrant(binding)).resolves.toBeUndefined();
    await expect(workspace.assertAuthority(scopeOf(issued?.token))).rejects.toThrow();
    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: authorizationId,
        runtimeAuthorizationSeal: await freshSeal(),
      })
    ).resolves.toEqual({ status: 'denied' });
    await expect(
      workspace.authorizeChild({
        authority: scopeOf(issued?.token) as never,
        childSessionId: siblingSessionId,
      })
    ).rejects.toThrow();
  });

  it('adopts a creating chat whose authorization is already revoked as revoked', async () => {
    const { workspace, seed } = fixture();
    if (seed.current) seed.current.authorization = authorization({ state: 'revoked' });
    await expect(workspace.issueMcpGrant(binding)).resolves.toBeUndefined();
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'revoked' });
  });

  it('treats a transient binding read failure as unavailable, not revoked', async () => {
    const { workspace } = fixture();
    const issued = await workspace.issueMcpGrant(binding);
    renew.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(workspace.assertAuthority(scopeOf(issued?.token))).rejects.toThrow(
      'database unavailable'
    );
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'active' });
  });

  it('ends every authority once the workspace is deleted, without adopting again', async () => {
    const { workspace, exportSeed, storage } = fixture();
    const issued = await workspace.issueMcpGrant(binding);
    await workspace.markDeleted();
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'deleted' });
    await expect(workspace.issueMcpGrant(binding)).resolves.toBeUndefined();
    await expect(workspace.assertAuthority(scopeOf(issued?.token))).rejects.toThrow();
    await storage.put(`child:${childSessionId}`, { createdAt: Date.now() });
    await expect(workspace.listChildren({ limit: 5 })).rejects.toThrow('denied');
    expect(exportSeed).toHaveBeenCalledTimes(1);
  });

  it('deletes registry entries beyond the storage list limit', async () => {
    const { workspace, storage } = fixture();
    for (let i = 0; i < 1001; i += 1) {
      await storage.put(`child:workspace_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, {
        createdAt: Date.now(),
      });
    }
    await workspace.markDeleted();
    expect(await storage.list({ prefix: 'child:' })).toEqual(new Map());
  });
});

describe('workspace delegation and child registry', () => {
  it('delegates to a direct child within the workspace delegation', async () => {
    const { workspace } = fixture();
    const issued = await workspace.issueMcpGrant(binding);
    const delegated = await workspace.authorizeChild({
      authority: scopeOf(issued?.token) as never,
      childSessionId: siblingSessionId,
    });
    const record = await unsealRuntimeAuthorization(delegated.seal, secret, {
      resourceKind: 'cloud-agent-next',
      resourceId: siblingSessionId,
      userId: ownerId,
      organizationId: undefined,
    });
    expect(record.delegationExpiresAt).toBe(authorization().delegationExpiresAt);
    expect(record.id).not.toBe(authorizationId);
    await expect(
      workspace.authorizeChild({
        authority: scopeOf(issued?.token) as never,
        childSessionId: workspaceSessionId,
      })
    ).rejects.toThrow();
  });

  it('delegates a callback chat in this worktree', async () => {
    const { workspace } = fixture();
    await expect(
      workspace.authorizeChat({ chatSessionId: siblingSessionId })
    ).resolves.toMatchObject({ worktreeId, organizationId: null });
    vi.setSystemTime(now.getTime() + 24 * 3600_000 + 1_000);
    await expect(workspace.authorizeChat({ chatSessionId: siblingSessionId })).rejects.toThrow(
      'Cloud Agent parent authority denied'
    );
  });

  it('records, pages and forgets direct children idempotently', async () => {
    const { workspace } = fixture();
    const ids = [
      'workspace_32345678-1234-4234-8234-123456789abc',
      'workspace_42345678-1234-4234-8234-123456789abc',
    ];
    for (const id of ids) await workspace.recordChild({ cloudAgentSessionId: id });
    await workspace.recordChild({ cloudAgentSessionId: ids[0], initialMessageId: 'msg_replay' });
    const first = await workspace.listChildren({ limit: 2 });
    expect(first.sessions.map(entry => entry.cloudAgentSessionId)).toEqual([
      childSessionId,
      ids[0],
    ]);
    expect(first.sessions[1]).not.toHaveProperty('initialMessageId');
    const second = await workspace.listChildren({ limit: 2, cursor: first.nextCursor });
    expect(second).toEqual({ sessions: [{ cloudAgentSessionId: ids[1] }] });
    await workspace.forgetChild(ids[1]);
    await expect(workspace.listChildren({ limit: 5 })).resolves.toMatchObject({
      sessions: [{ cloudAgentSessionId: childSessionId }, { cloudAgentSessionId: ids[0] }],
    });
    await expect(
      workspace.recordChild({ cloudAgentSessionId: workspaceSessionId })
    ).rejects.toThrow();
  });
});
