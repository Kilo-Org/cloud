import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  CloudAgentAuthoritySchema,
  validateCloudAgentAuthorityClaims,
  validateCloudAgentAuthorityRequest,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  CLOUD_AGENT_PARENT_AUTHORITY_DENIED,
  assertWorkspaceAuthority,
  deriveWorkspaceRuntimeAuthorization,
  isWorkspaceAnchorMetadata,
  matchesWorkspaceMcpBinding,
  resolveCloudAgentMcpUrl,
  signWorkspaceMcpGrant,
  validateScopedWorkerPreparation,
  workspaceAuthorityFromAnchor,
  workspaceAuthorityScope,
  workspaceAuthorityUnavailableReason,
  workspaceSessionIdForScope,
  type WorkspaceAuthorityRecord,
} from './cloud-agent-authority.js';

const secret = 'cloud-agent-authority-fixture-secret';
const now = new Date('2026-10-13T19:00:00Z');
const parentSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const childSessionId = 'workspace_12345678-1234-4234-8234-123456789abd';
const worktreeId = 'worktree_12345678-1234-4234-8234-123456789abc';
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
  operationKey: '33333333-3333-4333-8333-333333333333',
};
const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';
const webForwardedLaunch = {
  ...launch,
  platform: 'github',
  createdOnPlatform: 'cloud-agent-web',
  githubAccessPurpose: 'agent',
  clientProvenance: 'browser',
  githubIntegrationId,
};

function authorization(overrides: Partial<RuntimeAuthorization> = {}): RuntimeAuthorization {
  return {
    version: 1,
    id: scope.authorizationId,
    resourceKind: 'cloud-agent-next',
    resourceId: parentSessionId,
    userId: scope.ownerId,
    authorizationUserId: scope.ownerId,
    issuedAt: now.toISOString(),
    delegationExpiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    state: 'active',
    bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'b'.repeat(64) },
    source: { admissionSource: 'user', createdOnPlatform: 'cloud-agent-web' },
    env: 'production',
    ...overrides,
  };
}

function anchorMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: parentSessionId,
      userId: scope.ownerId,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'private-model-token' },
    allowSubagentSessions: true,
    workspace: { worktreeId },
    lifecycle: { version: now.getTime(), timestamp: now.getTime() },
    ...overrides,
  };
}

function record(overrides: Partial<RuntimeAuthorization> = {}): WorkspaceAuthorityRecord {
  const adopted = workspaceAuthorityFromAnchor(
    { metadata: anchorMetadata(), authorization: authorization(overrides) },
    now.getTime()
  );
  if (adopted === undefined) throw new Error('fixture did not adopt');
  return adopted;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('workspace identity', () => {
  it('names one workspace for every chat in a worktree without electing a chat', () => {
    expect(workspaceSessionIdForScope(worktreeId, parentSessionId)).toBe(parentSessionId);
    expect(workspaceSessionIdForScope(worktreeId, childSessionId)).toBe(parentSessionId);
    expect(workspaceSessionIdForScope(undefined, childSessionId)).toBe(childSessionId);
    expect(workspaceSessionIdForScope('worktree_invalid', childSessionId)).toBeUndefined();
    expect(isWorkspaceAnchorMetadata(anchorMetadata())).toBe(true);
    expect(
      isWorkspaceAnchorMetadata(
        anchorMetadata({ identity: { sessionId: childSessionId, userId: scope.ownerId } })
      )
    ).toBe(false);
  });
});

describe('workspace authority adoption', () => {
  it('adopts the creating chat authorization once, bound to the workspace, owner and organization', () => {
    expect(record()).toMatchObject({
      workspaceSessionId: parentSessionId,
      worktreeId,
      ownerId: scope.ownerId,
      organizationId: null,
      createdOnPlatform: 'cloud-agent-web',
      authorization: { id: scope.authorizationId, resourceId: parentSessionId },
    });
  });

  it('records the workspace egress policy for its children', () => {
    const adopted = workspaceAuthorityFromAnchor(
      {
        metadata: anchorMetadata({
          workspace: { worktreeId, egressMode: 'allowlist', egressAllowlist: ['example.com'] },
        }),
        authorization: authorization(),
      },
      now.getTime()
    );
    expect(adopted?.egress).toEqual({ egressMode: 'allowlist', egressAllowlist: ['example.com'] });
  });

  it.each([
    ['a sibling chat', { identity: { sessionId: childSessionId, userId: scope.ownerId } }],
    ['a chat without launch permission', { allowSubagentSessions: false }],
    [
      'a legacy shared sandbox',
      { workspace: { worktreeId, sandboxAllocation: 'cloudflare-shared' } },
    ],
  ] as const)('refuses to adopt from %s', (_name, overrides) => {
    expect(
      workspaceAuthorityFromAnchor(
        {
          metadata: anchorMetadata(overrides as Partial<SessionMetadata>),
          authorization: authorization(),
        },
        now.getTime()
      )
    ).toBeUndefined();
  });

  it.each([
    ['owner', { userId: 'other-user' }],
    ['organization', { organizationId: 'other-org' }],
    ['resource', { resourceId: childSessionId }],
  ] as const)('refuses an authorization for another %s', (_name, mismatch) => {
    expect(
      workspaceAuthorityFromAnchor(
        { metadata: anchorMetadata(), authorization: authorization(mismatch) },
        now.getTime()
      )
    ).toBeUndefined();
  });

  it('keeps an expired or revoked authorization as stored, so adoption restores nothing', () => {
    const expired = record({
      issuedAt: new Date(now.getTime() - 25 * 3600_000).toISOString(),
      delegationExpiresAt: new Date(now.getTime() - 3600_000).toISOString(),
    });
    expect(workspaceAuthorityUnavailableReason(expired, now.getTime())).toBe('delegation_expired');
    expect(workspaceAuthorityUnavailableReason(record({ state: 'revoked' }), now.getTime())).toBe(
      'stored_authorization_revoked'
    );
  });
});

describe('workspace authority checks', () => {
  it('accepts only the current workspace authorization', () => {
    const current = record();
    expect(() => assertWorkspaceAuthority(current, scope, now.getTime())).not.toThrow();
    for (const mismatch of [
      { parentSessionId: childSessionId },
      { ownerId: 'other-user' },
      { organizationId: '22345678-1234-4234-8234-123456789abc' },
      { authorizationId: '12345678-1234-4234-8234-123456789abd' },
      { expiresAt: scope.expiresAt + 1 },
    ]) {
      expect(() =>
        assertWorkspaceAuthority(current, { ...scope, ...mismatch }, now.getTime())
      ).toThrow(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
    }
    expect(() => assertWorkspaceAuthority(undefined, scope, now.getTime())).toThrow(
      CLOUD_AGENT_PARENT_AUTHORITY_DENIED
    );
    expect(() =>
      assertWorkspaceAuthority(current, { ...scope, extra: true }, now.getTime())
    ).toThrow(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
  });

  it('rejects a revoked, expired or last-second workspace delegation', () => {
    expect(() =>
      assertWorkspaceAuthority(record({ state: 'revoked' }), scope, now.getTime())
    ).toThrow();
    expect(() => assertWorkspaceAuthority(record(), scope, scope.expiresAt * 1000)).toThrow();
    const lastSecond = record({ delegationExpiresAt: new Date(now.getTime() + 500).toISOString() });
    expect(workspaceAuthorityUnavailableReason(lastSecond, now.getTime())).toBe(
      'delegation_expired'
    );
  });

  it('rejects an authority presented after the workspace renewed its authorization', () => {
    const renewed = record({ id: '12345678-1234-4234-8234-123456789abd' });
    expect(() => assertWorkspaceAuthority(renewed, scope, now.getTime())).toThrow();
    expect(() =>
      assertWorkspaceAuthority(renewed, workspaceAuthorityScope(renewed), now.getTime())
    ).not.toThrow();
  });

  it('binds the MCP credential to the route workspace, owner and organization', () => {
    const binding = {
      workspaceSessionId: parentSessionId,
      worktreeId,
      ownerId: scope.ownerId,
      organizationId: null,
    };
    expect(matchesWorkspaceMcpBinding(record(), binding)).toBe(true);
    for (const mismatch of [
      { workspaceSessionId: childSessionId },
      { worktreeId: childSessionId.replace('workspace_', 'worktree_') },
      { ownerId: 'other-user' },
      { organizationId: 'other-organization' },
    ]) {
      expect(matchesWorkspaceMcpBinding(record(), { ...binding, ...mismatch })).toBe(false);
    }
  });
});

describe('workspace MCP credential', () => {
  it('carries the workspace authority and ends with the workspace delegation', async () => {
    const issued = await signWorkspaceMcpGrant({
      record: record(),
      pepper: 'current-account-pepper',
      secret,
      now: now.getTime(),
    });
    expect(issued).toMatchObject({
      url: 'https://mcp.kiloapps.io/mcp',
      expiresAt: scope.expiresAt,
    });
    const claims = jwt.verify(issued.token, secret);
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
    expect(validateCloudAgentAuthorityClaims(claims)).toEqual(scope);
  });

  it('binds an organization credential to exactly one organization', async () => {
    const organizationId = '22345678-1234-4234-8234-123456789abc';
    const adopted = workspaceAuthorityFromAnchor(
      {
        metadata: anchorMetadata({
          identity: { sessionId: parentSessionId, userId: scope.ownerId, orgId: organizationId },
        }),
        authorization: authorization({ organizationId }),
      },
      now.getTime()
    );
    if (adopted === undefined) throw new Error('fixture did not adopt');
    const issued = await signWorkspaceMcpGrant({
      record: adopted,
      pepper: null,
      secret,
      now: now.getTime(),
    });
    expect(jwt.decode(issued.token)).toMatchObject({
      organizationId,
      cloudAgentAuthority: { ...scope, organizationId },
    });
  });

  it('uses a valid local MCP override only', async () => {
    const issued = await signWorkspaceMcpGrant({
      record: record(),
      pepper: null,
      secret,
      mcpUrl: 'http://localhost:11715/mcp',
      now: now.getTime(),
    });
    expect(issued.url).toBe('http://host.docker.internal:11715/mcp');
  });
});

describe('workspace delegation', () => {
  it('derives an independent authorization for a direct child or a new chat', () => {
    const delegated = deriveWorkspaceRuntimeAuthorization(record(), childSessionId, now.getTime());
    expect(delegated).toMatchObject({
      resourceId: childSessionId,
      userId: scope.ownerId,
      bindings: authorization().bindings,
      delegationExpiresAt: authorization().delegationExpiresAt,
    });
    expect(delegated.id).not.toBe(scope.authorizationId);
  });

  it('refuses the workspace itself and non-workspace targets', () => {
    expect(() =>
      deriveWorkspaceRuntimeAuthorization(record(), parentSessionId, now.getTime())
    ).toThrow();
    expect(() =>
      deriveWorkspaceRuntimeAuthorization(record(), 'agent_legacy', now.getTime())
    ).toThrow();
  });
});

describe('scoped worker preparation', () => {
  it('pins the production MCP URL unless a valid local override is configured', () => {
    expect(resolveCloudAgentMcpUrl()).toBe('https://mcp.kiloapps.io/mcp');
    expect(resolveCloudAgentMcpUrl('not a url')).toBe('https://mcp.kiloapps.io/mcp');
    expect(resolveCloudAgentMcpUrl('ftp://localhost:8815/mcp')).toBe('https://mcp.kiloapps.io/mcp');
    expect(resolveCloudAgentMcpUrl('http://localhost:8815/mcp')).toBe(
      'http://host.docker.internal:8815/mcp'
    );
    expect(resolveCloudAgentMcpUrl('http://host.docker.internal:8815/mcp')).toBe(
      'http://host.docker.internal:8815/mcp'
    );
  });

  it('accepts the full web-forwarded personal preparation input without widening the public scoped schema', () => {
    expect(validateScopedWorkerPreparation(scope, webForwardedLaunch)).toEqual({
      ...launch,
    });
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', webForwardedLaunch)
    ).toThrow();
  });

  it('accepts the full web-forwarded organization preparation input without widening the public scoped schema', () => {
    const organizationId = '22345678-1234-4234-8234-123456789abc';
    const organizationScope: CloudAgentAuthority = { ...scope, organizationId };
    const input = {
      ...webForwardedLaunch,
      kilocodeOrganizationId: organizationId,
    };
    expect(validateScopedWorkerPreparation(organizationScope, input)).toEqual({
      ...launch,
      organizationId,
    });
    expect(() =>
      validateCloudAgentAuthorityRequest(
        organizationScope,
        'organizations.cloudAgentNext.prepareSession',
        input
      )
    ).toThrow();
  });

  it('accepts a requested environment and rejects widened nested fields on scoped preparation', () => {
    const organizationId = '22345678-1234-4234-8234-123456789abc';
    const organizationScope: CloudAgentAuthority = { ...scope, organizationId };
    const requestedEnvironment = {
      id: '32345678-1234-4234-8234-123456789abc',
      repositories: [{ repoFullName: 'acme/other', branch: 'feature/child' }],
    };
    const input = {
      ...webForwardedLaunch,
      kilocodeOrganizationId: organizationId,
      requestedEnvironment,
    };

    expect(validateScopedWorkerPreparation(organizationScope, input)).toEqual({
      ...launch,
      organizationId,
      requestedEnvironment,
    });

    for (const invalid of [
      { ...requestedEnvironment, extra: true },
      { ...requestedEnvironment, id: 'not-a-uuid' },
      {
        ...requestedEnvironment,
        repositories: [{ repoFullName: 'acme/other', branch: 'b'.repeat(256) }],
      },
      {
        ...requestedEnvironment,
        repositories: [{ repoFullName: 'acme/other', extra: true }],
      },
    ]) {
      expect(() =>
        validateScopedWorkerPreparation(organizationScope, {
          ...input,
          requestedEnvironment: invalid,
        })
      ).toThrow();
    }
    for (const requireEnvironmentChoice of [true, false]) {
      expect(() =>
        validateScopedWorkerPreparation(organizationScope, {
          ...input,
          requireEnvironmentChoice,
        })
      ).toThrow();
    }
  });

  it('rejects a malformed trusted GitHub integration identity', () => {
    expect(() =>
      validateScopedWorkerPreparation(scope, {
        ...webForwardedLaunch,
        githubIntegrationId: 'not-a-uuid',
      })
    ).toThrow();
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
      })
    ).toMatchObject({
      githubRepo: 'new-owner/new-repo',
      model: 'kilo/other',
    });
    expect(() =>
      validateScopedWorkerPreparation(scope, {
        ...launch,
        allowSubagentSessions: true,
      })
    ).toThrow();
    expect(() => CloudAgentAuthoritySchema.parse({ ...scope, remainingDepth: 2 })).toThrow();
  });
  it('accepts the web-resolved stacked branch, commit, and connection at the internal boundary', () => {
    const parentWorktreeId = 'worktree_12345678-1234-4234-8234-123456789abc';
    expect(
      validateScopedWorkerPreparation(scope, {
        ...launch,
        githubIntegrationId: '44444444-4444-4444-8444-444444444444',
        platform: 'github',
        baseBranch: 'feature/parent',
        baseSha: 'a'.repeat(40),
        parentWorktreeId,
        operationKey: '33333333-3333-4333-8333-333333333333',
      })
    ).toEqual({
      ...launch,
      stackOnWorktreeId: parentWorktreeId,
      operationKey: '33333333-3333-4333-8333-333333333333',
    });
  });
  it.each([
    { stackOnWorktreeId: 'worktree_12345678-1234-4234-8234-123456789abc' },
    { baseBranch: 'main', baseSha: 'a'.repeat(40) },
    { parentWorktreeId: 'worktree_12345678-1234-4234-8234-123456789abc' },
    {
      parentWorktreeId: 'worktree_12345678-1234-4234-8234-123456789abc',
      baseBranch: 'feature/parent',
      baseSha: 'invalid-sha',
    },
    {
      parentWorktreeId: 'worktree_12345678-1234-4234-8234-123456789abc',
      baseBranch: 'feature/parent',
      baseSha: 'a'.repeat(40),
      upstreamBranch: 'main',
      operationKey: '33333333-3333-4333-8333-333333333333',
    },
  ])('rejects incomplete or conflicting internal stack metadata %j', metadata => {
    expect(() => validateScopedWorkerPreparation(scope, { ...launch, ...metadata })).toThrow();
  });

  it('binds organization worker preparation to exactly one organization', () => {
    const organizationId = '22345678-1234-4234-8234-123456789abc';
    const organizationScope: CloudAgentAuthority = { ...scope, organizationId };
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
});
