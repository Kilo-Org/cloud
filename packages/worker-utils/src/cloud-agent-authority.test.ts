import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  CloudAgentAuthoritySchema,
  cloudAgentAuthorityInputSchema,
  cloudAgentAuthorityProcedure,
  cloudAgentAuthorityProcedures,
  cloudAgentAuthorityProcedureKind,
  isCloudAgentAuthorityHttpPathAllowed,
  validateCloudAgentAuthorityRequest,
  type CloudAgentAuthority,
} from './cloud-agent-authority';
import {
  buildModernKiloTokenPayload,
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
  verifyKiloTokenForResource,
} from './kilo-token-policy';
import { verifyKiloToken } from './kilo-token';

const now = 1_900_000_000;
const secret = 'fixture-only-cloud-agent-authority-secret';
const organizationId = '11111111-1111-4111-8111-111111111111';
const scope: CloudAgentAuthority = {
  version: 1,
  ownerId: 'oauth/fixture-user',
  parentSessionId: 'workspace_parent',
  organizationId: null,
  authorizationId: '22222222-2222-4222-8222-222222222222',
  expiresAt: now + 24 * 60 * 60,
};
const launch = {
  githubRepo: 'acme/repo',
  model: 'provider/model',
  mode: 'code',
  prompt: 'Implement the child task',
  autoInitiate: true,
};

function claims(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    kiloUserId: scope.ownerId,
    apiTokenPepper: null,
    env: 'test',
    aud: 'kilo-api',
    iat: now,
    exp: scope.expiresAt,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    cloudAgentAuthority: scope,
    ...overrides,
  };
}
function sign(payload: Record<string, unknown>, signingSecret = secret) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(signingSecret));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now * 1000));
});
afterEach(() => vi.useRealTimers());

describe('scoped folder authority', () => {
  const worktreeId = 'worktree_33333333-3333-4333-8333-333333333333';
  const cloudAgentSessionId = 'workspace_44444444-4444-4444-8444-444444444444';
  const folderId = '55555555-5555-4555-8555-555555555555';

  it.each([null, organizationId])(
    'permits only scoped folder discovery and child workspace moves for %s',
    org => {
      const authority = { ...scope, organizationId: org };
      const listing = { organizationId: org };
      const assignment = { ...listing, cloudAgentSessionId, worktreeId, folderId };
      expect(
        validateCloudAgentAuthorityRequest(authority, 'workspaceFolders.list', listing)
      ).toEqual(listing);
      expect(
        validateCloudAgentAuthorityRequest(authority, 'workspaceFolders.moveWorktree', assignment)
      ).toEqual(assignment);
      expect(
        validateCloudAgentAuthorityRequest(authority, 'workspaceFolders.moveWorktree', {
          ...assignment,
          folderId: null,
        })
      ).toEqual({ ...assignment, folderId: null });
      expect(cloudAgentAuthorityProcedureKind('workspaceFolders.list')).toBe('query');
      expect(cloudAgentAuthorityProcedureKind('workspaceFolders.moveWorktree')).toBe('mutation');
      expect(
        isCloudAgentAuthorityHttpPathAllowed(
          authority,
          '/api/trpc/workspaceFolders.list,workspaceFolders.moveWorktree'
        )
      ).toBe(true);
      expect(
        cloudAgentAuthorityInputSchema(authority, 'workspaceFolders.moveWorktree')
      ).toMatchObject({
        properties: { organizationId: { const: org } },
        required: expect.arrayContaining([
          'organizationId',
          'cloudAgentSessionId',
          'worktreeId',
          'folderId',
        ]),
      });
    }
  );

  it.each([
    undefined,
    { organizationId },
    { organizationId: null, worktreeId },
    { organizationId: null, parentSessionId: scope.parentSessionId },
  ])('refuses missing or widened personal listing scope: %j', input => {
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'workspaceFolders.list', input)
    ).toThrow();
  });

  it.each([
    { organizationId: null, worktreeId, folderId },
    { organizationId: null, cloudAgentSessionId, folderId },
    { organizationId: null, cloudAgentSessionId, worktreeId },
    { organizationId, cloudAgentSessionId, worktreeId, folderId },
    { organizationId: null, cloudAgentSessionId, worktreeId: 'not-a-worktree', folderId },
    { organizationId: null, cloudAgentSessionId, worktreeId, folderId: 'not-a-folder' },
    {
      organizationId: null,
      cloudAgentSessionId,
      worktreeId,
      folderId,
      allowSubagentSessions: true,
    },
  ])('refuses incomplete or widened folder moves: %j', input => {
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'workspaceFolders.moveWorktree', input)
    ).toThrow();
  });

  it.each([
    'workspaceFolders.create',
    'workspaceFolders.update',
    'workspaceFolders.delete',
    'workspaceFolders.reorder',
    'organizations.workspaceFolders.list',
  ])('does not grant %s', procedure => {
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, procedure, { organizationId: null })
    ).toThrow();
    expect(
      isCloudAgentAuthorityHttpPathAllowed(scope, `/api/trpc/workspaceFolders.list,${procedure}`)
    ).toBe(false);
  });

  it('refuses expired folder authority', () => {
    expect(() =>
      validateCloudAgentAuthorityRequest(
        { ...scope, expiresAt: now - 1 },
        'workspaceFolders.list',
        { organizationId: null }
      )
    ).toThrow();
  });
});

describe('Cloud Agent authority contract', () => {
  it('accepts session-bound authority without repository, model, or depth policy', () => {
    expect(CloudAgentAuthoritySchema.parse(scope)).toEqual(scope);
    expect(cloudAgentAuthorityProcedure(scope)).toBe('cloudAgentNext.prepareSession');
  });
  it.each(['https://github.com/acme/repo', 'acme/repo/sub', 'acme', 'acme/'])(
    'rejects invalid repository %s',
    githubRepo => {
      expect(() =>
        validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', {
          ...launch,
          githubRepo,
        })
      ).toThrow();
    }
  );
  it.each([
    { remainingDepth: 2 },
    { extra: true },
    { procedures: [] },
    { procedures: ['other.procedure'] },
    { repositories: Array(101).fill('acme/repo') },
    { models: [] },
    { authorizationId: 'not-an-authorization-id' },
    { expiresAt: now + 0.5 },
  ])('rejects malformed or widened scope %j', overrides => {
    expect(CloudAgentAuthoritySchema.safeParse({ ...scope, ...overrides }).success).toBe(false);
  });
  it('allows only an explicit matching auto-initiated launch', () => {
    expect(
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', launch)
    ).toEqual(launch);
    const orgScope = {
      ...scope,
      organizationId,
    };
    expect(
      validateCloudAgentAuthorityRequest(orgScope, 'organizations.cloudAgentNext.prepareSession', {
        ...launch,
        organizationId,
      })
    ).toMatchObject({ organizationId });
  });
  it('allows normal repositories and models', () => {
    const request = {
      ...launch,
      githubRepo: 'Other-Org/AnotherRepo',
      model: 'another-provider/another-model',
    };
    expect(
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', request)
    ).toEqual(request);
    expect(cloudAgentAuthorityInputSchema(scope)).not.toHaveProperty(
      'properties.parentCloudAgentSessionId'
    );
    expect(cloudAgentAuthorityInputSchema(scope)).not.toHaveProperty(
      'properties.allowSubagentSessions'
    );
  });
  it('permits launches beyond fifteen minutes until session authorization expires', () => {
    expect(
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', launch, now + 3600)
    ).toEqual(launch);
  });
  it('accepts only the workspace callback destinations without widening spawn authority', () => {
    for (const target of [
      { url: 'workspace:new-chat' },
      { url: 'workspace:workspace_12345678-1234-4234-8234-123456789abc' },
    ]) {
      const request = { ...launch, callbackTarget: target };
      expect(
        validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', request)
      ).toEqual(request);
    }
    const schema = cloudAgentAuthorityInputSchema(scope);
    expect(schema).toHaveProperty('properties.callbackTarget.anyOf');
    expect(JSON.stringify(schema)).toContain('workspace:new-chat');
    expect(JSON.stringify(schema)).toContain('workspace:workspace_');
    expect(JSON.stringify(schema)).not.toContain('session:parent');
  });
  it.each([
    { parentCloudAgentSessionId: 'workspace_sibling' },
    { parentCloudAgentSessionId: scope.parentSessionId },
    { allowSubagentSessions: true },
    { autoInitiate: false },
    { autoInitiate: undefined },
    { organizationId },
    { mode: 'custom' },
    { gitlabProject: 'acme/repo' },
    { gitUrl: 'https://example.com' },
    { githubToken: 'fixture' },
    { githubIntegrationId: organizationId },
    { profileId: organizationId },
    { envVars: {} },
    { mcpServers: {} },
    { setupCommands: [] },
    { cloudAgentSpawn: {} },
    { attachments: {} },
    { initialPayload: {} },
    { cloneFromKiloSessionId: 'fixture' },
    { runtimeAgents: [] },
    { runtimeSkills: [] },
    { callbackTarget: {} },
    { callbackTarget: { url: 'https://example.com/callback' } },
    { callbackTarget: { url: 'session:parent' } },
    { callbackTarget: { url: 'session:workspace_sibling' } },
    { callbackTarget: { url: 'workspace:not-a-session' } },
    {
      callbackTarget: {
        url: 'workspace:workspace_12345678-1234-4234-8234-123456789abc',
        token: 'a'.repeat(64),
      },
    },
    { callbackTarget: { url: 'workspace:new-chat', headers: { Authorization: 'private' } } },
    { sandboxAllocation: {} },
    { egressMode: 'allowlist' },
    { egressMode: 'unrestricted' },
    { egressAllowlist: [] },
    { runtime: {} },
    { futureEscapeField: true },
  ])('rejects widened raw launch %j', overrides => {
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', {
        ...launch,
        ...overrides,
      })
    ).toThrow();
  });
  it('rejects wrong procedures, ownership surfaces and expired authority', () => {
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.sendMessage', launch)
    ).toThrow();
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'organizations.cloudAgentNext.prepareSession', {
        ...launch,
        organizationId,
      })
    ).toThrow();
    expect(() =>
      validateCloudAgentAuthorityRequest(
        scope,
        'cloudAgentNext.prepareSession',
        launch,
        scope.expiresAt
      )
    ).toThrow();
  });
  it.each([
    undefined,
    '/api/profile',
    '/api/trpc/cloudAgentNext.deleteSession',
    '/api/trpc/cloudAgentNext.prepareSession,user.getMe',
    '/api/trpc/',
    '/api/user/',
  ])('confines direct HTTP path %s', path => {
    expect(isCloudAgentAuthorityHttpPathAllowed(scope, path)).toBe(false);
  });
  it('allows identity verification and allowed procedure batches only until expiry', () => {
    expect(isCloudAgentAuthorityHttpPathAllowed(scope, '/api/user')).toBe(true);
    expect(
      isCloudAgentAuthorityHttpPathAllowed(scope, '/api/trpc/cloudAgentNext.prepareSession')
    ).toBe(true);
    vi.setSystemTime(new Date(scope.expiresAt * 1000));
    expect(isCloudAgentAuthorityHttpPathAllowed(scope, '/api/user')).toBe(false);
  });

  const childSessionId = 'workspace_33333333-3333-4333-8333-333333333333';
  const messageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
  const managementRequests = [
    ['listChildSessions', 'query', { limit: 5 }],
    ['getSession', 'query', { cloudAgentSessionId: childSessionId }],
    ['getMessageResult', 'query', { cloudAgentSessionId: childSessionId, messageId }],
    ['interruptSession', 'mutation', { sessionId: childSessionId }],
    [
      'sendMessage',
      'mutation',
      {
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: {
          type: 'prompt',
          prompt: 'Continue the child task',
          mode: 'code',
          model: 'provider/model',
        },
      },
    ],
  ] as const;

  it.each(managementRequests)('permits only the pinned scope for %s', (name, kind, input) => {
    const procedure = `cloudAgentNext.${name}`;
    expect(cloudAgentAuthorityProcedures(scope)).toContain(procedure);
    expect(cloudAgentAuthorityProcedureKind(procedure)).toBe(kind);
    expect(validateCloudAgentAuthorityRequest(scope, procedure, input)).toEqual(input);
    expect(isCloudAgentAuthorityHttpPathAllowed(scope, `/api/trpc/${procedure}`)).toBe(true);
    const orgScope = { ...scope, organizationId };
    const orgProcedure = `organizations.${procedure}`;
    expect(
      validateCloudAgentAuthorityRequest(orgScope, orgProcedure, { ...input, organizationId })
    ).toMatchObject(input);
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, orgProcedure, { ...input, organizationId })
    ).toThrow();
    expect(() => validateCloudAgentAuthorityRequest(orgScope, procedure, input)).toThrow();
    expect(() => validateCloudAgentAuthorityRequest(orgScope, orgProcedure, input)).toThrow();
    expect(() =>
      validateCloudAgentAuthorityRequest(orgScope, orgProcedure, {
        ...input,
        organizationId: 'other-org',
      })
    ).toThrow();
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, procedure, {
        ...input,
        parentCloudAgentSessionId: scope.parentSessionId,
      })
    ).toThrow();
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, procedure, input, scope.expiresAt)
    ).toThrow();
    expect(cloudAgentAuthorityInputSchema(scope, procedure)).toHaveProperty(
      'additionalProperties',
      false
    );
  });

  it('rejects follow-up configuration, commands, whitespace prompts, and malformed identities', () => {
    const request = {
      cloudAgentSessionId: childSessionId,
      messageId,
      payload: { type: 'prompt', prompt: 'Continue', mode: 'code', model: 'provider/model' },
    };
    for (const payload of [
      { ...request.payload, prompt: '   ' },
      { ...request.payload, mcpServers: {} },
      { type: 'command', command: 'run', arguments: '' },
    ]) {
      expect(() =>
        validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.sendMessage', {
          ...request,
          payload,
        })
      ).toThrow();
    }
    for (const extra of [
      { cloudAgentSessionId: 'ses_not_a_cloud_session' },
      { messageId: 'invalid-message-id' },
      { attachments: {} },
      { callbackTarget: { url: 'session:parent' } },
      { envVars: { TOKEN: 'not-allowed' } },
    ]) {
      expect(() =>
        validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.sendMessage', {
          ...request,
          ...extra,
        })
      ).toThrow();
    }
  });

  it('rejects unknown procedure kinds and mixed-scope batches', () => {
    expect(() => cloudAgentAuthorityProcedureKind('cloudAgentNext.deleteSession')).toThrow();
    expect(() => cloudAgentAuthorityProcedureKind('user.getMe')).toThrow();
    expect(
      isCloudAgentAuthorityHttpPathAllowed(
        scope,
        '/api/trpc/cloudAgentNext.getSession,cloudAgentNext.getMessageResult'
      )
    ).toBe(true);
    expect(
      isCloudAgentAuthorityHttpPathAllowed(
        scope,
        '/api/trpc/cloudAgentNext.getSession,organizations.cloudAgentNext.getSession'
      )
    ).toBe(false);
  });

  it('allows only the models.list discovery query for personal and organization authority', () => {
    expect(cloudAgentAuthorityProcedures(scope)).toEqual([
      'cloudAgentNext.prepareSession',
      'cloudAgentNext.listChildSessions',
      'cloudAgentNext.getSession',
      'cloudAgentNext.getMessageResult',
      'cloudAgentNext.interruptSession',
      'cloudAgentNext.sendMessage',
      'models.list',
      'workspaceFolders.list',
      'workspaceFolders.moveWorktree',
    ]);
    expect(cloudAgentAuthorityProcedures({ ...scope, organizationId })).toEqual([
      'organizations.cloudAgentNext.prepareSession',
      'organizations.cloudAgentNext.listChildSessions',
      'organizations.cloudAgentNext.getSession',
      'organizations.cloudAgentNext.getMessageResult',
      'organizations.cloudAgentNext.interruptSession',
      'organizations.cloudAgentNext.sendMessage',
      'models.list',
      'workspaceFolders.list',
      'workspaceFolders.moveWorktree',
    ]);
    expect(cloudAgentAuthorityProcedureKind('models.list')).toBe('query');
  });

  it.each([
    ['personal', scope],
    ['organization', { ...scope, organizationId }],
  ] as const)('accepts strict models.list discovery for %s authority', (_label, authority) => {
    expect(validateCloudAgentAuthorityRequest(authority, 'models.list', undefined)).toBeUndefined();
    expect(validateCloudAgentAuthorityRequest(authority, 'models.list', {})).toEqual({});
    expect(cloudAgentAuthorityInputSchema(authority, 'models.list')).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(cloudAgentAuthorityInputSchema(authority, 'models.list')).not.toHaveProperty(
      'properties.organizationId'
    );
    expect(isCloudAgentAuthorityHttpPathAllowed(authority, '/api/trpc/models.list')).toBe(true);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['extra field', { extra: true }],
    ['organizationId', { organizationId }],
    ['limit', { limit: 1 }],
  ] as const)('rejects widened models.list input: %s', (_label, input) => {
    expect(() => validateCloudAgentAuthorityRequest(scope, 'models.list', input)).toThrow();
    expect(() =>
      validateCloudAgentAuthorityRequest({ ...scope, organizationId }, 'models.list', input)
    ).toThrow();
  });

  it.each([
    'models.preferred',
    'models.customPricing',
    'models.get',
    'organizations.models.list',
    'organizations.cloudAgentNext.models.list',
  ])('does not permit adjacent models path %s', procedure => {
    expect(cloudAgentAuthorityProcedures(scope)).not.toContain(procedure);
    expect(() => cloudAgentAuthorityProcedureKind(procedure)).toThrow();
    expect(() => cloudAgentAuthorityInputSchema(scope, procedure)).toThrow();
    expect(() => validateCloudAgentAuthorityRequest(scope, procedure, {})).toThrow();
    expect(isCloudAgentAuthorityHttpPathAllowed(scope, `/api/trpc/${procedure}`)).toBe(false);
  });

  it('expires models.list discovery with the authority', () => {
    expect(() =>
      validateCloudAgentAuthorityRequest(scope, 'models.list', {}, scope.expiresAt)
    ).toThrow();
    expect(
      isCloudAgentAuthorityHttpPathAllowed(
        { ...scope, expiresAt: now - 1 },
        '/api/trpc/models.list'
      )
    ).toBe(false);
  });

  it('rejects HTTP batches mixing models.list with a forbidden or cross-scope path', () => {
    expect(
      isCloudAgentAuthorityHttpPathAllowed(scope, '/api/trpc/models.list,models.preferred')
    ).toBe(false);
    expect(isCloudAgentAuthorityHttpPathAllowed(scope, '/api/trpc/models.list,user.getMe')).toBe(
      false
    );
    expect(
      isCloudAgentAuthorityHttpPathAllowed(
        scope,
        '/api/trpc/models.list,organizations.cloudAgentNext.getSession'
      )
    ).toBe(false);
    expect(
      isCloudAgentAuthorityHttpPathAllowed(
        { ...scope, organizationId },
        '/api/trpc/models.list,cloudAgentNext.getSession'
      )
    ).toBe(false);
    expect(
      isCloudAgentAuthorityHttpPathAllowed(scope, '/api/trpc/models.list,cloudAgentNext.getSession')
    ).toBe(true);
    expect(
      isCloudAgentAuthorityHttpPathAllowed(
        { ...scope, organizationId },
        '/api/trpc/models.list,organizations.cloudAgentNext.getSession'
      )
    ).toBe(true);
  });
});

describe('scoped JWT policy', () => {
  it('retains verified scope and cannot exchange for a human credential', async () => {
    const auth = await verifyKiloTokenForPolicy(await sign(claims()), secret, {
      audience: 'kilo-api',
      mode: 'required',
    });
    expect(auth.claims.cloudAgentAuthority).toEqual(scope);
    expect(Object.isFrozen(auth.claims.cloudAgentAuthority)).toBe(true);
    expect(isKiloCredentialExchangeEligible(auth, { legacy: 'five-year-api' })).toBe(false);
  });
  it.each([
    { aud: ['kilo-api', 'cloud-agent-next'] },
    { aud: 'kilo-gateway' },
    { aud: undefined },
    { tokenPurpose: 'human-api' },
    { credentialExchange: true },
    { exp: scope.expiresAt + 1 },
    { iat: scope.expiresAt },
    { iat: now + 1 },
    { kiloUserId: 'other-user' },
    { organizationId },
    { apiTokenPepper: undefined },
    {
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: scope.ownerId,
        authorizationPepper: null,
      },
    },
    {
      runtimeAuthorization: {
        id: organizationId,
        resourceKind: 'cloud-agent-next',
        resourceId: scope.parentSessionId,
      },
    },
    { isAdmin: true },
    { unknownRestriction: false },
    { cloudAgentAuthority: { ...scope, extra: true } },
  ])('all verification paths reject widened claims %j', async overrides => {
    const token = await sign(claims(overrides));
    await expect(
      verifyKiloTokenForPolicy(token, secret, { audience: 'kilo-api', mode: 'allow-legacy' })
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForResource(token, secret, { audience: 'kilo-api', mode: 'allow-legacy' })
    ).rejects.toThrow();
    await expect(verifyKiloToken(token, secret, { audience: 'kilo-api' })).rejects.toThrow();
  });
  it('keeps a session-length credential valid after fifteen minutes', async () => {
    const token = await sign(claims({ iat: now - 1 }));
    vi.setSystemTime(new Date((now + 3600) * 1000));
    await expect(
      verifyKiloTokenForPolicy(token, secret, { audience: 'kilo-api', mode: 'required' })
    ).resolves.toMatchObject({ claims: { cloudAgentAuthority: scope } });
  });
  it('rejects forged and expired credentials without downgrade', async () => {
    await expect(
      verifyKiloTokenForPolicy(await sign(claims(), 'forged-fixture-secret'), secret, {
        audience: 'kilo-api',
        mode: 'allow-legacy',
      })
    ).rejects.toThrow();
    vi.setSystemTime(new Date(scope.expiresAt * 1000));
    await expect(
      verifyKiloTokenForPolicy(await sign(claims()), secret, {
        audience: 'kilo-api',
        mode: 'allow-legacy',
      })
    ).rejects.toThrow();
  });
  it('binds signed organization and preserves session expiration', () => {
    expect(() =>
      buildModernKiloTokenPayload({
        userId: scope.ownerId,
        pepper: null,
        audience: 'cloud-agent-next',
        issuedAt: now,
        expiresAt: scope.expiresAt,
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        extra: { cloudAgentAuthority: { ...scope, organizationId } },
      })
    ).toThrow();
    expect(
      buildModernKiloTokenPayload({
        userId: scope.ownerId,
        pepper: null,
        audience: 'cloud-agent-next',
        issuedAt: now,
        expiresAt: scope.expiresAt,
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        extra: { organizationId, cloudAgentAuthority: { ...scope, organizationId } },
      }).cloudAgentAuthority
    ).toMatchObject({ organizationId });
  });
});
