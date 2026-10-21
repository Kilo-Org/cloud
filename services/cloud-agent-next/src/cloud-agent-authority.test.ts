import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  CloudAgentAuthoritySchema,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  assertCloudAgentParentAuthority,
  assertCloudAgentIsolatedAllocation,
  authorizeCloudAgentChild,
  issueCloudAgentMcpGrant,
  resolveCloudAgentMcpUrl,
  validateScopedWorkerPreparation,
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
const scope: CloudAgentAuthority = {
  version: 1,
  ownerId: 'oauth/fixture-user',
  parentSessionId,
  organizationId: null,
  authorizationId: '12345678-1234-4234-8234-123456789abc',
  expiresAt: Math.floor(now.getTime() / 1000) + 24 * 3600,
};
const launch = {
  prompt: 'Delegate a bounded task',
  githubRepo: 'acme/widgets',
  mode: 'code',
  model: 'kilo/test-model',
  autoInitiate: true,
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
    allowSubagentSessions: true,
    lifecycle: { version: now.getTime(), timestamp: now.getTime() },
  };
  const context = {
    metadata: vi.fn(async () => metadata),
    authorization: vi.fn(async () => authorization),
    secret,
    connectionString: 'postgres://fixture',
  };
  return { context, authorization, metadata };
}

describe('Cloud Agent spawn authority', () => {
  it('rejects shared allocation for opted-in parents and scoped children after saved-settings resolution', () => {
    expect(() => assertCloudAgentIsolatedAllocation(true, 'cloudflare-shared')).toThrow(
      'isolated sandbox'
    );
    expect(() => assertCloudAgentIsolatedAllocation(true, 'vercel-small')).not.toThrow();
    expect(() => assertCloudAgentIsolatedAllocation(false, 'cloudflare-shared')).not.toThrow();
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
    delete metadata.allowSubagentSessions;
    await expect(issueCloudAgentMcpGrant(context)).resolves.toBeUndefined();
    metadata.allowSubagentSessions = false;
    metadata.parentCloudAgentSessionId = parentSessionId;
    await expect(issueCloudAgentMcpGrant(context)).resolves.toBeUndefined();
    expect(context.authorization).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });

  it('binds organization grants and Worker request metadata to exactly one organization', async () => {
    const { context, metadata, authorization } = fixture();
    const organizationId = '22345678-1234-4234-8234-123456789abc';
    authorization.organizationId = organizationId;
    metadata.identity.orgId = organizationId;
    const issued = await issueCloudAgentMcpGrant(context);
    const claims = jwt.decode(issued?.token ?? '');
    const organizationScope: CloudAgentAuthority = {
      ...scope,
      organizationId,
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

  it('pins the production MCP URL unless a valid local override is configured', async () => {
    expect(resolveCloudAgentMcpUrl()).toBe('https://mcp.kiloapps.io/mcp');
    expect(resolveCloudAgentMcpUrl('not a url')).toBe('https://mcp.kiloapps.io/mcp');
    expect(resolveCloudAgentMcpUrl('ftp://localhost:8815/mcp')).toBe('https://mcp.kiloapps.io/mcp');
    expect(resolveCloudAgentMcpUrl('http://localhost:8815/mcp')).toBe(
      'http://host.docker.internal:8815/mcp'
    );
    expect(resolveCloudAgentMcpUrl('http://host.docker.internal:8815/mcp')).toBe(
      'http://host.docker.internal:8815/mcp'
    );
    const { context } = fixture();
    const issued = await issueCloudAgentMcpGrant({
      ...context,
      mcpUrl: 'http://localhost:11715/mcp',
    });
    expect(issued).toMatchObject({ url: 'http://host.docker.internal:11715/mcp' });
  });

  it('uses the normal parent delegation expiry, never account/model/control authority', async () => {
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
    expect(jwt.verify(issued?.token ?? '', secret)).toMatchObject({ cloudAgentAuthority: scope });
    expect(metadata).not.toHaveProperty('cloudAgentMcp');
    expect(JSON.stringify(metadata)).not.toContain(issued?.token);
  });

  it('still launches after fifteen minutes without any sandbox or wrapper liveness dependency', async () => {
    const { context } = fixture();
    const first = await issueCloudAgentMcpGrant(context);
    vi.setSystemTime(now.getTime() + 45 * 60_000);
    expect(jwt.verify(first?.token ?? '', secret)).toMatchObject({ cloudAgentAuthority: scope });
    await expect(
      authorizeCloudAgentChild({ ...context, authority: scope, childSessionId })
    ).resolves.toMatchObject({ seal: 'private-child-authorization-seal' });
    const renewed = await issueCloudAgentMcpGrant(context);
    expect(renewed?.expiresAt).toBe(scope.expiresAt);
    expect(renewed?.token).not.toBe(first?.token);
  });

  it('does not reset expiry after an issuance dependency failure', async () => {
    const { context } = fixture();
    renew.mockRejectedValueOnce(new Error('membership unavailable'));
    await expect(issueCloudAgentMcpGrant(context)).rejects.toThrow('membership unavailable');
    vi.setSystemTime(now.getTime() + 5 * 60_000);
    expect(await issueCloudAgentMcpGrant(context)).toMatchObject({ expiresAt: scope.expiresAt });
  });

  it('derives child model authority exclusively from the trusted parent record', async () => {
    const { context, authorization } = fixture();
    const result = await authorizeCloudAgentChild({
      ...context,
      authority: scope,
      childSessionId,
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
    ['authorization', { authorizationId: '12345678-1234-4234-8234-123456789abd' }],
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

  it('fails disabled, revoked and current account or membership checks', async () => {
    const { context, authorization, metadata } = fixture();
    const input = {
      ...context,
      authority: scope,
      childSessionId,
    };
    metadata.allowSubagentSessions = false;
    await expect(authorizeCloudAgentChild(input)).rejects.toThrow('parent authority denied');
    metadata.allowSubagentSessions = true;
    renew.mockRejectedValueOnce(new Error('membership revoked'));
    await expect(authorizeCloudAgentChild(input)).rejects.toThrow('membership revoked');
    authorization.state = 'revoked';
    await expect(authorizeCloudAgentChild(input)).rejects.toThrow('parent authority denied');
  });

  it.each(['account blocked', 'membership revoked', 'pepper changed'])(
    'preserves normal %s validation on minting and launch',
    async reason => {
      const { context } = fixture();
      renew.mockRejectedValue(new Error(reason));
      await expect(issueCloudAgentMcpGrant(context)).rejects.toThrow(reason);
      await expect(
        authorizeCloudAgentChild({ ...context, authority: scope, childSessionId })
      ).rejects.toThrow(reason);
      expect(seal).not.toHaveBeenCalled();
    }
  );

  it('rejects stale grants after parent authorization replacement', async () => {
    const { context, authorization } = fixture();
    authorization.id = crypto.randomUUID();
    await expect(
      authorizeCloudAgentChild({
        ...context,
        authority: scope,
        childSessionId,
      })
    ).rejects.toThrow('parent authority denied');
  });

  it('refreshes scope after normal runtime authorization recovery without replaying expired grants', async () => {
    const { context, authorization } = fixture();
    const first = await issueCloudAgentMcpGrant(context);
    vi.setSystemTime(now.getTime() + 25 * 3600_000);
    authorization.id = crypto.randomUUID();
    authorization.issuedAt = new Date().toISOString();
    authorization.delegationExpiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const renewed = await issueCloudAgentMcpGrant(context);
    expect(renewed?.token).not.toBe(first?.token);
    expect(jwt.verify(renewed?.token ?? '', secret)).toMatchObject({
      cloudAgentAuthority: {
        authorizationId: authorization.id,
        expiresAt: Math.floor(Date.parse(authorization.delegationExpiresAt) / 1000),
      },
    });
    expect(() => jwt.verify(first?.token ?? '', secret)).toThrow(/expired/);
    await expect(
      authorizeCloudAgentChild({
        ...context,
        authority: scope,
        childSessionId,
      })
    ).rejects.toThrow('parent authority denied');
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('rejects a parent changed during current-binding validation', async () => {
    const { context, authorization } = fixture();
    renew.mockImplementationOnce(async () => {
      authorization.state = 'revoked';
      return { token: 'must-not-escape' };
    });
    await expect(
      authorizeCloudAgentChild({
        ...context,
        authority: scope,
        childSessionId,
      })
    ).rejects.toThrow('parent authority denied');
    expect(seal).not.toHaveBeenCalled();
  });

  it('rejects legacy parents but permits an opted-in child to launch its own child', async () => {
    const { metadata, authorization } = fixture();
    metadata.identity.sessionId = 'agent_legacy';
    expect(() => assertCloudAgentParentAuthority(metadata, authorization, scope)).toThrow();
    metadata.identity.sessionId = parentSessionId;
    metadata.parentCloudAgentSessionId = 'workspace_grandparent';
    expect(() => assertCloudAgentParentAuthority(metadata, authorization, scope)).not.toThrow();
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
    expect(
      validateScopedWorkerPreparation(scope, {
        ...launch,
        githubRepo: 'new-owner/new-repo',
        model: 'kilo/other',
        allowSubagentSessions: true,
      })
    ).toMatchObject({
      githubRepo: 'new-owner/new-repo',
      model: 'kilo/other',
      allowSubagentSessions: true,
    });
    expect(() => CloudAgentAuthoritySchema.parse({ ...scope, remainingDepth: 2 })).toThrow();
  });

  it('never reissues an expired or revoked parent authorization', async () => {
    const { context, authorization } = fixture();
    vi.setSystemTime(now.getTime() + 24 * 3600_000);
    await expect(issueCloudAgentMcpGrant(context)).rejects.toThrow('parent authority denied');
    vi.setSystemTime(now);
    authorization.state = 'revoked';
    await expect(issueCloudAgentMcpGrant(context)).rejects.toThrow('parent authority denied');
    expect(renew).not.toHaveBeenCalled();
  });
});
