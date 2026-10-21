import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  CloudAgentAuthoritySchema,
  cloudAgentAuthorityInputSchema,
  cloudAgentAuthorityProcedure,
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
  it.each([true, false, undefined])('allows normal repositories/models and flag %s', flag => {
    const request = {
      ...launch,
      githubRepo: 'Other-Org/AnotherRepo',
      model: 'another-provider/another-model',
      ...(flag === undefined ? {} : { allowSubagentSessions: flag }),
    };
    expect(
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', request)
    ).toEqual(request);
    expect(cloudAgentAuthorityInputSchema(scope)).not.toHaveProperty(
      'properties.parentCloudAgentSessionId'
    );
  });
  it('permits launches beyond fifteen minutes until session authorization expires', () => {
    expect(
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', launch, now + 3600)
    ).toEqual(launch);
  });
  it('accepts only the parent callback destination without widening spawn authority', () => {
    const request = { ...launch, callbackTarget: { url: 'session:parent' } };
    expect(
      validateCloudAgentAuthorityRequest(scope, 'cloudAgentNext.prepareSession', request)
    ).toEqual(request);
    expect(cloudAgentAuthorityInputSchema(scope)).toHaveProperty(
      'properties.callbackTarget.properties.url.const',
      'session:parent'
    );
  });
  it.each([
    { parentCloudAgentSessionId: 'workspace_sibling' },
    { parentCloudAgentSessionId: scope.parentSessionId },
    { allowSubagentSessions: 'true' },
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
    { images: {} },
    { initialPayload: {} },
    { cloneFromKiloSessionId: 'fixture' },
    { runtimeAgents: [] },
    { runtimeSkills: [] },
    { callbackTarget: {} },
    { callbackTarget: { url: 'https://example.com/callback' } },
    { callbackTarget: { url: 'session:workspace_sibling' } },
    { callbackTarget: { url: 'session:parent', headers: { Authorization: 'private' } } },
    { callbackTarget: { url: 'session:parent', sessionId: 'workspace_sibling' } },
    { sandboxAllocation: {} },
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
    '/api/gastown/token',
    '/api/wasteland/token',
    '/api/profile',
    '/api/trpc/cloudAgentNext.sendMessage',
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
