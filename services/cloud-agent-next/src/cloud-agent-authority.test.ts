import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  CloudAgentAuthoritySchema,
  type CloudAgentAuthority,
  type CloudAgentSpawnPolicy,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  assertCloudAgentParentAuthority,
  assertCloudAgentIsolatedAllocation,
  authorizeCloudAgentChild,
  CLOUD_AGENT_MCP_GRANT_KEY,
  issueCloudAgentMcpGrant,
  validateScopedWorkerPreparation,
  validateSpawnOptInPreparation,
} from './cloud-agent-authority.js';

const { renew, seal } = vi.hoisted(() => ({ renew: vi.fn(), seal: vi.fn() }));
vi.mock('@kilocode/worker-utils/runtime-authorization', async importActual => ({
  ...(await importActual<typeof RuntimeAuthorizationModule>()),
  renewRuntimeAuthorization: renew,
  sealRuntimeAuthorization: seal,
}));

const secret = 'cloud-agent-authority-fixture-secret';
const now = new Date('2026-10-13T19:00:00Z');
const parentSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const childSessionId = 'workspace_12345678-1234-4234-8234-123456789abd';
const policy: CloudAgentSpawnPolicy = {
  procedures: ['cloudAgentNext.prepareSession'],
  repositories: ['acme/widgets', 'acme/other'],
  models: ['kilo/test-model', 'kilo/other'],
  remainingDepth: 1,
};
const scope: CloudAgentAuthority = {
  ...policy,
  version: 1,
  ownerId: 'oauth/fixture-user',
  parentSessionId,
  organizationId: null,
  expiresAt: Math.floor(now.getTime() / 1000) + 900,
};
const launch = {
  prompt: 'Delegate a bounded task',
  githubRepo: 'acme/widgets',
  mode: 'code',
  model: 'kilo/test-model',
  autoInitiate: true,
  parentCloudAgentSessionId: parentSessionId,
};

function fixture() {
  const authorization: RuntimeAuthorization = {
    version: 1,
    id: '12345678-1234-4234-8234-123456789abc',
    resourceKind: 'cloud-agent-next',
    resourceId: parentSessionId,
    userId: scope.ownerId,
    authorizationUserId: 'trusted-authorizing-user',
    issuedAt: now.toISOString(),
    delegationExpiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    state: 'active',
    bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'b'.repeat(64) },
    source: {
      admissionSource: 'automation',
      tokenSource: 'trusted-automation',
      botId: 'trusted-bot',
    },
    env: 'production',
  };
  const metadata: SessionMetadata = {
    metadataSchemaVersion: 2,
    identity: { sessionId: parentSessionId, userId: scope.ownerId },
    auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'private-model-token' },
    cloudAgentSpawn: { policy },
    lifecycle: { version: now.getTime(), timestamp: now.getTime() },
  };
  const values = new Map<string, unknown>();
  const context = {
    metadata: vi.fn(async () => metadata),
    authorization: vi.fn(async () => authorization),
    live: vi.fn(async () => true),
    secret,
    connectionString: 'postgres://fixture',
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
    } as unknown as Pick<DurableObjectStorage, 'get' | 'put'>,
  };
  return { context, authorization, metadata, values };
}

describe('Cloud Agent spawn authority', () => {
  it('rejects shared allocation for opted-in parents and scoped children after saved-settings resolution', () => {
    for (const spawn of [{ policy }, { parentSessionId }]) {
      expect(() => assertCloudAgentIsolatedAllocation(spawn, 'cloudflare-shared')).toThrow(
        'isolated sandbox'
      );
      expect(() => assertCloudAgentIsolatedAllocation(spawn, 'vercel-small')).not.toThrow();
    }
    expect(() => assertCloudAgentIsolatedAllocation(undefined, 'cloudflare-shared')).not.toThrow();
  });

  it('refuses grants from already-persisted shared sandbox parents', () => {
    const { metadata, authorization } = fixture();
    metadata.workspace = { sandboxAllocation: 'cloudflare-shared' };
    expect(() => assertCloudAgentParentAuthority(metadata, authorization, scope)).toThrow();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    renew.mockImplementation(async ({ authorization }: { authorization: RuntimeAuthorization }) =>
      signModernKiloToken({
        userId: authorization.userId,
        pepper: 'current-account-pepper',
        secret,
        audience: ['kilo-api', 'kilo-gateway', 'session-ingest'],
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        expiresInSeconds: 3600,
        extra: {
          ...(authorization.organizationId ? { organizationId: authorization.organizationId } : {}),
          runtimeAuthorization: {
            id: authorization.id,
            resourceKind: authorization.resourceKind,
            resourceId: authorization.resourceId,
          },
        },
      })
    );
    seal.mockResolvedValue('private-child-authorization-seal');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not issue or inspect credentials without explicit opt-in, including scoped children', async () => {
    const { context, metadata } = fixture();
    delete metadata.cloudAgentSpawn;
    await expect(issueCloudAgentMcpGrant(context)).resolves.toBeUndefined();
    metadata.cloudAgentSpawn = { parentSessionId };
    await expect(issueCloudAgentMcpGrant(context)).resolves.toBeUndefined();
    expect(context.authorization).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(context.storage.put).not.toHaveBeenCalled();
  });

  it('binds organization grants and Worker request metadata to exactly one organization', async () => {
    const { context, metadata, authorization } = fixture();
    const organizationId = '22345678-1234-4234-8234-123456789abc';
    authorization.organizationId = organizationId;
    metadata.identity.orgId = organizationId;
    metadata.cloudAgentSpawn = {
      policy: { ...policy, procedures: ['organizations.cloudAgentNext.prepareSession'] },
    };
    const issued = await issueCloudAgentMcpGrant(context);
    const claims = jwt.decode(issued?.token ?? '');
    const organizationScope: CloudAgentAuthority = {
      ...scope,
      organizationId,
      procedures: ['organizations.cloudAgentNext.prepareSession'],
    };
    expect(claims).toMatchObject({ organizationId, cloudAgentAuthority: organizationScope });
    expect(
      validateScopedWorkerPreparation(organizationScope, {
        ...launch,
        kilocodeOrganizationId: organizationId,
      })
    ).toMatchObject({ organizationId });
    expect(() => validateScopedWorkerPreparation(organizationScope, launch)).toThrow();
    expect(() =>
      validateScopedWorkerPreparation(organizationScope, {
        ...launch,
        kilocodeOrganizationId: 'other',
      })
    ).toThrow();
  });

  it('issues only a short-lived MCP audience, never account/model/control authority', async () => {
    const { context, metadata } = fixture();
    const issued = await issueCloudAgentMcpGrant(context);
    expect(issued).toMatchObject({
      url: 'https://mcp.kiloapps.io/mcp',
      expiresAt: scope.expiresAt,
    });
    const claims = jwt.decode(issued?.token ?? '');
    expect(claims).toMatchObject({
      kiloUserId: scope.ownerId,
      aud: 'kilo-api',
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      cloudAgentAuthority: scope,
      exp: scope.expiresAt,
    });
    expect(claims).not.toHaveProperty('runtimeAuthorization');
    expect(claims).not.toHaveProperty('runtimeAdmission');
    expect(claims).not.toHaveProperty('botId');
    expect(issued?.token).not.toBe(metadata.auth.kilocodeToken);
    expect(metadata).not.toHaveProperty('cloudAgentMcp');
    expect(JSON.stringify(metadata)).not.toContain(issued?.token);
  });

  it('keeps the same expired bearer across warm retries without re-minting or disabling parent model work', async () => {
    const { context, values } = fixture();
    const first = await issueCloudAgentMcpGrant(context);
    vi.setSystemTime(now.getTime() + 10 * 60_000);
    expect(await issueCloudAgentMcpGrant(context)).toEqual(first);
    vi.setSystemTime(now.getTime() + 15 * 60_000);
    expect(await issueCloudAgentMcpGrant(context)).toEqual(first);
    expect(() => jwt.verify(first?.token ?? '', secret)).toThrow(/expired/);
    expect(values.get(CLOUD_AGENT_MCP_GRANT_KEY)).toMatchObject({
      expiresAt: scope.expiresAt,
      token: first?.token,
    });
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('does not reset expiry after an issuance dependency failure', async () => {
    const { context, values } = fixture();
    renew.mockRejectedValueOnce(new Error('membership unavailable'));
    await expect(issueCloudAgentMcpGrant(context)).rejects.toThrow('membership unavailable');
    expect(values.get(CLOUD_AGENT_MCP_GRANT_KEY)).toMatchObject({ expiresAt: scope.expiresAt });
    vi.setSystemTime(now.getTime() + 5 * 60_000);
    expect(await issueCloudAgentMcpGrant(context)).toMatchObject({ expiresAt: scope.expiresAt });
  });

  it('derives child model authority exclusively from the trusted parent record and consumes depth', async () => {
    const { context, authorization, values } = fixture();
    await issueCloudAgentMcpGrant(context);
    renew.mockClear();
    const result = await authorizeCloudAgentChild({
      ...context,
      authority: scope,
      childSessionId,
      grant: async () => values.get(CLOUD_AGENT_MCP_GRANT_KEY),
    });
    const record = renew.mock.calls[0][0].authorization;
    expect(record).toMatchObject({
      ...authorization,
      id: expect.any(String),
      resourceId: childSessionId,
      issuedAt: now.toISOString(),
      delegationExpiresAt: authorization.delegationExpiresAt,
    });
    expect(record.id).not.toBe(authorization.id);
    expect(record.bindings).toEqual(authorization.bindings);
    expect(record.source).toEqual(authorization.source);
    expect(result.seal).toBe('private-child-authorization-seal');
    expect(jwt.decode(result.token)).not.toHaveProperty('cloudAgentAuthority');
  });

  it.each([
    ['owner', { ownerId: 'other' }],
    ['parent', { parentSessionId: childSessionId }],
    ['organization', { organizationId: 'other-org' }],
    ['repository', { repositories: ['acme/ungranted'] }],
    ['model', { models: ['kilo/ungranted'] }],
    ['procedure', { procedures: ['organizations.cloudAgentNext.prepareSession'] }],
    ['depth', { remainingDepth: 2 }],
    ['expiry', { expiresAt: Math.floor(now.getTime() / 1000) }],
  ])('rejects mismatched %s before minting', (_name, changes) => {
    const { metadata, authorization } = fixture();
    expect(() =>
      assertCloudAgentParentAuthority(metadata, authorization, {
        ...scope,
        ...changes,
      } as CloudAgentAuthority)
    ).toThrow();
  });

  it('accepts only narrowed policy and fails revoked/missing/live-parent and current-membership checks', async () => {
    const { context, authorization, metadata, values } = fixture();
    expect(() =>
      assertCloudAgentParentAuthority(metadata, authorization, {
        ...scope,
        repositories: ['acme/widgets'],
        models: ['kilo/test-model'],
      })
    ).not.toThrow();
    await issueCloudAgentMcpGrant(context);
    const input = {
      ...context,
      authority: scope,
      childSessionId,
      grant: async () => values.get(CLOUD_AGENT_MCP_GRANT_KEY),
    };
    context.live.mockResolvedValue(false);
    await expect(authorizeCloudAgentChild(input)).rejects.toThrow('not live');
    context.live.mockResolvedValue(true);
    renew.mockRejectedValueOnce(new Error('membership revoked'));
    await expect(authorizeCloudAgentChild(input)).rejects.toThrow('membership revoked');
    authorization.state = 'revoked';
    await expect(authorizeCloudAgentChild(input)).rejects.toThrow('parent authority denied');
  });

  it('rejects stale grants after parent authorization replacement', async () => {
    const { context, authorization, values } = fixture();
    await issueCloudAgentMcpGrant(context);
    authorization.id = crypto.randomUUID();
    await expect(
      authorizeCloudAgentChild({
        ...context,
        authority: scope,
        childSessionId,
        grant: async () => values.get(CLOUD_AGENT_MCP_GRANT_KEY),
      })
    ).rejects.toThrow('no longer current');
  });

  it('replays the same expired grant after human runtime recovery without restoring launch authority', async () => {
    const { context, authorization, values } = fixture();
    const first = await issueCloudAgentMcpGrant(context);
    vi.setSystemTime(now.getTime() + 20 * 60_000);
    authorization.id = crypto.randomUUID();
    expect(await issueCloudAgentMcpGrant(context)).toEqual(first);
    expect(() => jwt.verify(first?.token ?? '', secret)).toThrow(/expired/);
    await expect(
      authorizeCloudAgentChild({
        ...context,
        authority: scope,
        childSessionId,
        grant: async () => values.get(CLOUD_AGENT_MCP_GRANT_KEY),
      })
    ).rejects.toThrow('no longer current');
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('rejects a parent changed during current-binding validation', async () => {
    const { context, authorization, values } = fixture();
    await issueCloudAgentMcpGrant(context);
    renew.mockImplementationOnce(async () => {
      authorization.state = 'revoked';
      return { token: 'must-not-escape' };
    });
    await expect(
      authorizeCloudAgentChild({
        ...context,
        authority: scope,
        childSessionId,
        grant: async () => values.get(CLOUD_AGENT_MCP_GRANT_KEY),
      })
    ).rejects.toThrow('parent authority denied');
    expect(seal).not.toHaveBeenCalled();
  });

  it('rejects parent sessions with legacy credentials or inherited spawn policy', async () => {
    const { metadata, authorization } = fixture();
    metadata.identity.sessionId = 'agent_legacy';
    expect(() => assertCloudAgentParentAuthority(metadata, authorization, scope)).toThrow();
    metadata.identity.sessionId = parentSessionId;
    metadata.cloudAgentSpawn = { policy, parentSessionId };
    expect(() => assertCloudAgentParentAuthority(metadata, authorization, scope)).toThrow();
  });

  it('validates scoped raw input before unsafe fields can be stripped', () => {
    expect(
      validateScopedWorkerPreparation(scope, {
        ...launch,
        platform: 'github',
        createdOnPlatform: 'cloud-agent-web',
      })
    ).toEqual(launch);
    for (const forbidden of [
      'cloudAgentSpawn',
      'envVars',
      'mcpServers',
      'gitToken',
      'cloneFromKiloSessionId',
      'runtimeAgents',
      'profileId',
      'sandboxAllocation',
    ]) {
      expect(() =>
        validateScopedWorkerPreparation(scope, { ...launch, [forbidden]: {} })
      ).toThrow();
    }
    expect(() =>
      validateScopedWorkerPreparation(scope, {
        ...launch,
        parentCloudAgentSessionId: childSessionId,
      })
    ).toThrow();
    expect(() =>
      validateScopedWorkerPreparation(scope, { ...launch, autoInitiate: false })
    ).toThrow();
    expect(() =>
      validateScopedWorkerPreparation(scope, { ...launch, kilocodeOrganizationId: 'wrong-org' })
    ).toThrow();
    expect(() =>
      validateScopedWorkerPreparation(scope, {
        ...launch,
        githubRepo: 'https://github.com/acme/widgets',
      })
    ).toThrow();
    expect(() =>
      validateScopedWorkerPreparation(scope, { ...launch, model: 'kilo/ungranted' })
    ).toThrow();
    expect(() => CloudAgentAuthoritySchema.parse({ ...scope, remainingDepth: 2 })).toThrow();
  });

  it('requires safe explicit auto-initiation for opt-in, while ordinary creation stays unchanged', () => {
    const { parentCloudAgentSessionId: _parent, ...parentLaunch } = launch;
    expect(() =>
      validateSpawnOptInPreparation({ ...parentLaunch, cloudAgentSpawn: policy })
    ).not.toThrow();
    expect(() =>
      validateSpawnOptInPreparation({ prompt: 'ordinary', gitUrl: 'https://example.test/repo' })
    ).not.toThrow();
    for (const override of [
      { autoInitiate: false },
      { githubRepo: undefined },
      { model: undefined },
      { mcpServers: {} },
      { cloudAgentSpawn: { ...policy, remainingDepth: 2 } },
      { parentCloudAgentSessionId: parentSessionId },
    ]) {
      expect(() =>
        validateSpawnOptInPreparation({ ...parentLaunch, cloudAgentSpawn: policy, ...override })
      ).toThrow();
    }
  });
});
