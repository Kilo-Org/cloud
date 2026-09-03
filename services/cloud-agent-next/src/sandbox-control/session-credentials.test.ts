import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env, GitTokenService } from '../types.js';
import { createControlPlaneCredential, parseControlPlaneCredential } from './managed-credential.js';
import {
  buildControlNetworkPolicy,
  isContainedSessionCredentialGrant,
  prepareSessionCredentials,
  removeSessionCredentialMembership,
  resolveSessionCredential,
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from './session-credentials.js';
import { findMatchingCredentialInjectionRule } from './vercel-network-policy.js';

vi.mock('../logger.js', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return { logger };
});

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const SANDBOX_ID = 'usr-a1b2c3';
const ALLOCATION_ID = 'usr-d4e5f6';
const OUTBOUND_CONTAINER_ID = `contained:${ALLOCATION_ID}`;
const VERCEL_SANDBOX_ID = 'ses-a1b2c3';
const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SECOND_SESSION_ID = 'workspace_22222222-2222-4222-8222-222222222222';
const THIRD_SESSION_ID = 'workspace_33333333-3333-4333-8333-333333333333';
const ROOT_ID = 'ses_abcdefghijklmnopqrstuvwxyz';
const SECOND_ROOT_ID = 'ses_zyxwvutsrqponmlkjihgfedcba';
const THIRD_ROOT_ID = 'ses_01234567890123456789012345';
const KILO_TOKEN = 'test-real-kilo-token';
const GITHUB_TOKEN = 'test-real-github-token';
const BROKER_ERROR_SECRET = 'fixture-secret-in-broker-exception';
const INTEGRATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPOSITORY_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type CredentialEnv = Parameters<typeof prepareSessionCredentials>[0]['env'];
type KiloSubject = Parameters<GitTokenService['issueKiloSessionCapability']>[0];

function expectSecretSafeLogs(): void {
  const mockedLogger = vi.mocked(logger);
  const logs = JSON.stringify([
    mockedLogger.info.mock.calls,
    mockedLogger.warn.mock.calls,
    mockedLogger.error.mock.calls,
    mockedLogger.withFields.mock.calls,
  ]);
  for (const secret of [KILO_TOKEN, GITHUB_TOKEN, BROKER_ERROR_SECRET]) {
    expect(logs).not.toContain(secret);
  }
}

function createBroker() {
  let serial = 0;
  const kiloSubjects = new Map<string, KiloSubject>();
  const broker = {
    getTokenForRepo: vi.fn<GitTokenService['getTokenForRepo']>(async () => ({
      success: true,
      token: GITHUB_TOKEN,
      installationId: '42',
      accountLogin: 'acme',
      appType: 'standard',
    })),
    getToken: vi.fn<GitTokenService['getToken']>(async () => GITHUB_TOKEN),
    getCloudAgentAuthForRepo: vi.fn<NonNullable<GitTokenService['getCloudAgentAuthForRepo']>>(
      async () => ({
        success: true,
        githubToken: GITHUB_TOKEN,
        installationId: '42',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'user',
        gitAuthor: { name: 'bot', email: 'bot@example.com' },
      })
    ),
    issueKiloSessionCapability: vi.fn<GitTokenService['issueKiloSessionCapability']>(
      async subject => {
        const capability = `kka1.test-${++serial}`;
        kiloSubjects.set(capability, subject);
        return { success: true, capability };
      }
    ),
    issueGitHubSessionCapability: vi.fn<GitTokenService['issueGitHubSessionCapability']>(
      async () => ({
        success: true,
        capability: `kgh2.test-${++serial}`,
        installationId: '42',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'bot', email: 'bot@example.com' },
      })
    ),
    issueGitLabSessionCapability: vi.fn<GitTokenService['issueGitLabSessionCapability']>(
      async () => ({
        success: true,
        capability: `kgl2.test-${++serial}`,
        instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
        instanceHost: 'gitlab.example.com:8443',
        projectPath: 'acme/platform/repo',
        integrationId: INTEGRATION_ID,
        authType: 'pat',
        identity: { accountId: '123', accountLogin: 'acme' },
        source: { type: 'integration' },
        glabIsOAuth2: false,
      })
    ),
    issueBitbucketSessionCapability: vi.fn<
      NonNullable<GitTokenService['issueBitbucketSessionCapability']>
    >(async () => ({
      success: true,
      capability: `kbb1.test-${++serial}`,
      gitUrl: 'https://bitbucket.org/acme/canonical-repo.git',
    })),
    getGitLabToken: vi.fn<GitTokenService['getGitLabToken']>(async () => ({
      success: true,
      token: 'test-real-gitlab-token',
      instanceUrl: 'https://gitlab.example.com:8443/gitlab',
      glabIsOAuth2: false,
    })),
    getBitbucketToken: vi.fn<NonNullable<GitTokenService['getBitbucketToken']>>(async () => ({
      success: true,
      token: 'test-real-bitbucket-token',
    })),
    redeemKiloSessionCapability: vi.fn<GitTokenService['redeemKiloSessionCapability']>(),
    redeemGitHubSessionCapability: vi.fn<GitTokenService['redeemGitHubSessionCapability']>(),
    redeemGitLabSessionCapability: vi.fn<GitTokenService['redeemGitLabSessionCapability']>(),
    redeemBitbucketSessionCapability:
      vi.fn<NonNullable<GitTokenService['redeemBitbucketSessionCapability']>>(),
  } satisfies GitTokenService;
  return { broker, kiloSubjects };
}

function environment(broker?: GitTokenService): CredentialEnv {
  const namespace = (name: string) =>
    ({
      idFromName: (id: string) => ({ toString: () => `${name}:${id}` }),
    }) as Env['Sandbox'];
  return {
    Sandbox: namespace('standard'),
    SandboxContainment: namespace('contained'),
    SandboxSmall: namespace('small'),
    SandboxSmallContainment: namespace('contained-small'),
    SandboxCodeReview: namespace('review'),
    SandboxCodeReviewContainment: namespace('contained-review'),
    SandboxDIND: namespace('dind'),
    ...(broker ? { GIT_TOKEN_SERVICE: broker } : {}),
    KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com',
    KILO_OPENROUTER_BASE: 'https://provider.example.com/api/openrouter',
    KILO_SESSION_INGEST_URL: 'https://ingest.example.com',
  };
}

function metadata(
  overrides: Partial<SessionMetadata> = {},
  scopeId: CloudAgentWorktreeId | null = 'worktree_11111111-1111-4111-8111-111111111111'
): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: SESSION_ID,
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
    repository: { type: 'github', repo: 'acme/repo', githubIntegrationId: INTEGRATION_ID },
    lifecycle: { version: 1, timestamp: NOW },
    ...overrides,
    workspace: {
      sandboxId: SANDBOX_ID,
      sandboxProvider: 'cloudflare',
      workspacePath: '/workspace/worktree-a',
      ...(scopeId ? { worktreeId: scopeId } : {}),
      ...overrides.workspace,
    },
  };
}

function secondRoot(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return metadata({
    identity: { ...metadata().identity, sessionId: SECOND_SESSION_ID },
    auth: { kiloSessionId: SECOND_ROOT_ID, kilocodeToken: KILO_TOKEN },
    ...overrides,
  });
}

async function prepare(
  env: CredentialEnv,
  data = metadata(),
  existing?: SessionCredentialGrant,
  now = NOW
) {
  const result = await prepareSessionCredentials({
    env,
    metadata: data,
    sandboxId: data.workspace?.sandboxId ?? SANDBOX_ID,
    ...(data.workspace?.sandboxProvider === 'vercel'
      ? {}
      : { outboundContainerId: OUTBOUND_CONTAINER_ID }),
    existing,
    now,
  });
  if (!isContainedSessionCredentialGrant(result.grant)) throw new Error('Expected contained grant');
  return { ...result, grant: result.grant };
}

function resolve(
  env: CredentialEnv,
  grant: SessionCredentialGrant,
  overrides: Partial<Parameters<typeof resolveSessionCredential>[0]> = {}
) {
  return resolveSessionCredential({
    env,
    grant,
    credential: grant.kilo.alias ?? grant.kilo.token,
    url: 'https://provider.example.com/api/openrouter/chat/completions',
    method: 'POST',
    outboundContainerId: OUTBOUND_CONTAINER_ID,
    now: NOW,
    ...overrides,
  });
}

function vercelMetadata(
  overrides: Partial<SessionMetadata> = {},
  scopeId: CloudAgentWorktreeId = 'worktree_11111111-1111-4111-8111-111111111111'
) {
  return metadata(
    {
      ...overrides,
      workspace: {
        sandboxId: VERCEL_SANDBOX_ID,
        sandboxProvider: 'vercel',
        ...overrides.workspace,
      },
    },
    scopeId
  );
}

describe('trusted worktree credential preparation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('contains Kilo and managed GitHub tokens and derives targets from the real Kilo token', async () => {
    const { broker, kiloSubjects } = createBroker();
    const env = environment(broker);
    const token = `https://selected-provider.example.com/api/openrouter:${KILO_TOKEN}`;
    const data = metadata({
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: token },
      profile: {
        envVars: {
          KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: token } }),
          PUBLIC_VALUE: 'kept',
        },
        setupCommands: [`run --token=${token}`],
      },
    });
    const { grant, payload } = await prepare(env, data);
    const capability = grant.kilo.capabilities[SESSION_ID];

    expect(grant.kilo.token).toBe(token);
    expect(payload.kilo).toEqual({
      scopeId: 'worktree_11111111-1111-4111-8111-111111111111',
      token: grant.kilo.alias,
      targets: grant.kilo.targets,
    });
    expect(payload.kilo.targets.providerBaseUrl).toBe(
      'https://selected-provider.example.com/api/openrouter'
    );
    expect(payload.env).toMatchObject({
      KILOCODE_TOKEN: grant.kilo.alias,
      GH_TOKEN: grant.scm?.alias,
      PUBLIC_VALUE: 'kept',
    });
    expect(JSON.parse(payload.env?.KILO_AUTH_CONTENT ?? '{}')).toEqual({
      kilo: { type: 'api', key: grant.kilo.alias },
    });
    expect(payload.git).toEqual({
      url: 'https://github.com/acme/repo.git',
      platform: 'github',
      token: grant.scm?.alias,
    });
    expect(capability && kiloSubjects.get(capability.credential)).toEqual({
      userId: 'user-a',
      cloudAgentSessionId: SESSION_ID,
      kiloSessionId: ROOT_ID,
      outboundContainerId: OUTBOUND_CONTAINER_ID,
      userToken: token,
      targets: grant.kilo.targets,
    });
    expect(broker.issueGitHubSessionCapability).toHaveBeenCalledWith({
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      githubRepo: 'acme/repo',
      expectedIntegrationId: INTEGRATION_ID,
      allowUserAuthorization: true,
      outboundContainerId: OUTBOUND_CONTAINER_ID,
    });
    for (const secret of [
      token,
      KILO_TOKEN,
      GITHUB_TOKEN,
      capability?.credential,
      grant.scm?.capability?.credential,
    ]) {
      if (secret) expect(JSON.stringify(payload)).not.toContain(secret);
    }
    expect(sessionCredentialGrantSchema.parse(JSON.parse(JSON.stringify(grant)))).toEqual(grant);
    expect(data.auth.kilocodeToken).toBe(token);
  });

  it('keeps logical alias routing separate from its exact native container binding', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const data = metadata();
    const { grant } = await prepare(env, data);

    expect(parseControlPlaneCredential(grant.kilo.alias)?.sandboxId).toBe(SANDBOX_ID);
    expect(grant.outboundContainerId).toBe(OUTBOUND_CONTAINER_ID);
    expect(grant.kilo.capabilities[SESSION_ID].outboundContainerId).toBe(OUTBOUND_CONTAINER_ID);
    expect(
      await resolve(env, grant, { outboundContainerId: `contained:${SANDBOX_ID}` })
    ).toBeNull();
    await expect(
      prepareSessionCredentials({
        env,
        metadata: data,
        sandboxId: SANDBOX_ID,
        outboundContainerId: 'contained:usr-replacement',
        existing: grant,
        now: NOW,
      })
    ).rejects.toThrow('Invalid contained worktree credentials');
    expect(broker.issueKiloSessionCapability).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit native binding before issuing Cloudflare capabilities', async () => {
    const { broker } = createBroker();
    await expect(
      prepareSessionCredentials({
        env: environment(broker),
        metadata: metadata(),
        sandboxId: SANDBOX_ID,
        now: NOW,
      })
    ).rejects.toThrow('Invalid contained worktree credentials');
    expect(broker.issueKiloSessionCapability).not.toHaveBeenCalled();
    expect(broker.issueGitHubSessionCapability).not.toHaveBeenCalled();
  });

  it('shares aliases only across explicit roots of the same worktree and preserves exact family subjects', async () => {
    const { broker, kiloSubjects } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    const second = await prepare(env, secondRoot(), first.grant);

    expect(second.grant.members).toEqual([
      { sessionId: SESSION_ID, kiloSessionId: ROOT_ID },
      { sessionId: SECOND_SESSION_ID, kiloSessionId: SECOND_ROOT_ID },
    ]);
    expect(second.payload.kilo).toEqual(first.payload.kilo);
    expect(second.payload.git?.token).toBe(first.payload.git?.token);
    expect(first.grant.members).toHaveLength(1);
    for (const [sessionId, rootId] of [
      [SESSION_ID, ROOT_ID],
      [SECOND_SESSION_ID, SECOND_ROOT_ID],
    ]) {
      for (const [operation, method] of [
        ['export', 'GET'],
        ['ingest', 'POST'],
      ]) {
        const result = await resolve(env, second.grant, {
          url: `https://ingest.example.com/api/session/${rootId}/${operation}`,
          method,
        });
        expect(result).not.toBeNull();
        expect(result && kiloSubjects.get(result.credential)).toMatchObject({
          cloudAgentSessionId: sessionId,
          kiloSessionId: rootId,
        });
        expect(result?.organizationId).toBe(INTEGRATION_ID);
        for (const rejected of [
          {
            url: `https://ingest.example.com/api/session/${rootId}/${operation}`,
            method: method === 'GET' ? 'POST' : 'GET',
          },
          { url: `https://ingest.example.com/api/session/${rootId}/${operation}/extra`, method },
          { url: `https://ingest.example.com/api/session/${rootId}-other/${operation}`, method },
        ]) {
          expect(await resolve(env, second.grant, rejected)).toBeNull();
        }
      }
    }
    for (const [operation, method] of [
      ['export', 'GET'],
      ['ingest', 'POST'],
    ]) {
      expect(
        await resolve(env, second.grant, {
          url: `https://ingest.example.com/api/session/${THIRD_ROOT_ID}/${operation}`,
          method,
        })
      ).toBeNull();
    }
    const repeated = await prepare(env, secondRoot(), second.grant);
    expect(repeated.grant.members).toEqual(second.grant.members);
    expect(await resolve(env, second.grant)).toMatchObject({
      credential: first.grant.kilo.capabilities[SESSION_ID]?.credential,
    });
  });

  it('falls back to the session scope and trusted workspace path helper without a worktree id', async () => {
    const { broker } = createBroker();
    const data = metadata({ workspace: { workspacePath: undefined } }, null);
    const { grant, payload } = await prepare(environment(broker), data);
    expect(grant.scopeId).toBe(SESSION_ID);
    expect(grant.directory).toBe(`/workspace/${INTEGRATION_ID}/user-a/sessions/${SESSION_ID}`);
    expect(payload.directory).toBe(grant.directory);
  });

  it('renews warm credentials after the previous backing capability expired without replacing aliases', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    const renewed = await prepare(env, metadata(), first.grant, NOW + 5 * HOUR);

    expect(renewed.grant.kilo.alias).toBe(first.grant.kilo.alias);
    expect(renewed.grant.scm?.alias).toBe(first.grant.scm?.alias);
    expect(renewed.grant.kilo.capabilities[SESSION_ID]?.credential).not.toBe(
      first.grant.kilo.capabilities[SESSION_ID]?.credential
    );
    expect(renewed.grant.scm?.capability?.credential).not.toBe(
      first.grant.scm?.capability?.credential
    );
    expect(renewed.grant.expiresAt).toBe(NOW + 9 * HOUR);
    expect(await resolve(env, renewed.grant, { now: NOW + 5 * HOUR })).toMatchObject({
      credential: renewed.grant.kilo.capabilities[SESSION_ID]?.credential,
    });
    expect(renewed.payload.kilo.token).toBe(first.payload.kilo.token);
  });

  it('refreshes backing capabilities during redemption without extending the trusted worktree lease', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const { grant } = await prepare(env);
    const now = NOW + 3 * HOUR;
    const kilo = await resolve(env, grant, { now });
    const github = await resolve(env, grant, {
      now,
      credential: grant.scm?.alias,
      url: 'https://api.github.com/repos/acme/repo',
      method: 'GET',
    });

    expect(kilo?.credential).not.toBe(grant.kilo.capabilities[SESSION_ID]?.credential);
    expect(github?.credential).not.toBe(grant.scm?.capability?.credential);
    expect(kilo?.grant.expiresAt).toBe(grant.expiresAt);
    expect(github?.grant.expiresAt).toBe(grant.expiresAt);
    expect(kilo?.grant.preparedAt).toBe(NOW);
    expect(grant.kilo.capabilities[SESSION_ID]?.issuedAt).toBe(NOW);
    expect(await resolve(env, kilo?.grant ?? grant, { now: NOW + 4 * HOUR })).toBeNull();
    expect(
      await resolve(env, github?.grant ?? grant, {
        now: NOW + 4 * HOUR,
        credential: grant.scm?.alias,
      })
    ).toBeNull();
    expect(broker.issueKiloSessionCapability).toHaveBeenCalledTimes(2);
    expect(broker.issueGitHubSessionCapability).toHaveBeenCalledTimes(2);
  });

  it('invalidates all root capability caches when trusted preparation rotates the Kilo token', async () => {
    const { broker, kiloSubjects } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    const second = await prepare(env, secondRoot(), first.grant);
    const rotated = await prepare(
      env,
      metadata({ auth: { kiloSessionId: ROOT_ID, kilocodeToken: 'test-rotated-kilo-token' } }),
      second.grant,
      NOW + 1
    );
    expect(rotated.grant.kilo.capabilities[SECOND_SESSION_ID]).toBeUndefined();
    const resolved = await resolve(env, rotated.grant, {
      now: NOW + 2,
      url: `https://ingest.example.com/api/session/${SECOND_ROOT_ID}/export`,
      method: 'GET',
    });
    expect(resolved && kiloSubjects.get(resolved.credential)).toMatchObject({
      userToken: 'test-rotated-kilo-token',
      cloudAgentSessionId: SECOND_SESSION_ID,
      kiloSessionId: SECOND_ROOT_ID,
    });
    expect(rotated.grant.kilo.alias).toBe(first.grant.kilo.alias);
  });

  it.each([
    [
      'owner',
      () =>
        secondRoot({
          identity: { ...metadata().identity, sessionId: SECOND_SESSION_ID, userId: 'other-user' },
        }),
    ],
    [
      'organization',
      () =>
        secondRoot({
          identity: {
            ...metadata().identity,
            sessionId: SECOND_SESSION_ID,
            orgId: REPOSITORY_UUID,
          },
        }),
    ],
    ['directory', () => secondRoot({ workspace: { workspacePath: '/workspace/other' } })],
    [
      'worktree',
      () =>
        metadata(
          {
            auth: { kiloSessionId: SECOND_ROOT_ID, kilocodeToken: KILO_TOKEN },
            identity: { ...metadata().identity, sessionId: SECOND_SESSION_ID },
          },
          'worktree_22222222-2222-4222-8222-222222222222'
        ),
    ],
    [
      'repository',
      () =>
        secondRoot({
          repository: { type: 'github', repo: 'acme/other', githubIntegrationId: INTEGRATION_ID },
        }),
    ],
    [
      'integration',
      () =>
        secondRoot({
          repository: { type: 'github', repo: 'acme/repo', githubIntegrationId: REPOSITORY_UUID },
        }),
    ],
    [
      'platform context',
      () =>
        secondRoot({
          identity: {
            ...metadata().identity,
            sessionId: SECOND_SESSION_ID,
            createdOnPlatform: 'code-review',
          },
        }),
    ],
    ['sandbox', () => secondRoot({ workspace: { sandboxId: 'usr-deadbeef' } })],
    ['provider', () => secondRoot({ workspace: { sandboxProvider: 'vercel' } })],
  ] as const)(
    'rejects worktree %s mismatches before requesting more capabilities',
    async (_name, createMetadata) => {
      const { broker } = createBroker();
      const env = environment(broker);
      const first = await prepare(env);
      await expect(prepare(env, createMetadata(), first.grant)).rejects.toThrow(
        'Invalid contained worktree credentials'
      );
      expect(broker.issueKiloSessionCapability).toHaveBeenCalledTimes(1);
      expect(broker.issueGitHubSessionCapability).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    'KILOCODE_BACKEND_BASE_URL',
    'KILO_OPENROUTER_BASE',
    'KILO_SESSION_INGEST_URL',
  ] as const)('rejects a changed %s for an existing worktree', async key => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    await expect(
      prepare({ ...env, [key]: 'https://different.example.com' }, secondRoot(), first.grant)
    ).rejects.toThrow('Invalid contained worktree credentials');
  });

  it('rejects root identity replacement and ambiguous family membership', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    await expect(
      prepare(
        env,
        metadata({ auth: { kiloSessionId: SECOND_ROOT_ID, kilocodeToken: KILO_TOKEN } }),
        first.grant
      )
    ).rejects.toThrow('Invalid contained worktree credentials');
    await expect(
      prepare(
        env,
        secondRoot({ auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN } }),
        first.grant
      )
    ).rejects.toThrow('Invalid contained worktree credentials');
  });

  it.each([undefined, '', 'with\nnewline', 'kka1.test-capability'])(
    'requires a real nonempty Kilo token: %s',
    async kilocodeToken => {
      const { broker } = createBroker();
      await expect(
        prepare(environment(broker), metadata({ auth: { kiloSessionId: ROOT_ID, kilocodeToken } }))
      ).rejects.toThrow('Invalid contained worktree credentials');
      expect(broker.issueKiloSessionCapability).not.toHaveBeenCalled();
    }
  );

  it('rejects DIND and devcontainer metadata', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    await expect(
      prepare(env, metadata({ workspace: { sandboxId: 'dind-a1b2c3' } }))
    ).rejects.toThrow('Invalid contained worktree credentials');
    await expect(
      prepare(env, metadata({ workspace: { devcontainerRequested: true } }))
    ).rejects.toThrow('Invalid contained worktree credentials');
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'supports public generic Git with required Kilo containment on %s',
    async provider => {
      const { broker } = createBroker();
      const data = metadata({
        repository: { type: 'git', url: 'https://public.example.com/acme/repo.git' },
        workspace: {
          sandboxId: provider === 'vercel' ? VERCEL_SANDBOX_ID : SANDBOX_ID,
          sandboxProvider: provider,
        },
      });
      const { grant, payload } = await prepare(environment(broker), data);
      expect(payload.git).toEqual({ url: 'https://public.example.com/acme/repo.git' });
      expect(payload.kilo.token).toBe(grant.kilo.alias);
      expect(grant.scm).toBeUndefined();
      expect(broker.getTokenForRepo).not.toHaveBeenCalled();
      expect(broker.issueGitHubSessionCapability).not.toHaveBeenCalled();
      expect(JSON.stringify(payload)).not.toContain(KILO_TOKEN);
    }
  );

  const credentialedRepositoryUrl = new URL('https://public.example.com/repo.git');
  credentialedRepositoryUrl.username = 'fake-user';
  credentialedRepositoryUrl.password = 'fake-password';

  it.each([
    { type: 'git', url: 'https://public.example.com/repo.git', token: 'custom-token' },
    { type: 'git', url: credentialedRepositoryUrl.href },
    { type: 'git', url: 'https://user@public.example.com/repo.git' },
    { type: 'git', url: 'https://public.example.com/repo.git?token=custom-token' },
    { type: 'github', repo: 'acme/repo', token: 'custom-token', githubInstallationId: '42' },
    { type: 'gitlab', url: 'https://gitlab.example.com/acme/repo.git', token: 'custom-token' },
  ] satisfies Array<SessionMetadata['repository']>)(
    'never replaces unsupported custom repository authentication: $type',
    async repository => {
      const { broker } = createBroker();
      await expect(prepare(environment(broker), metadata({ repository }))).rejects.toThrow(
        'Invalid contained worktree credentials'
      );
      expect(broker.issueKiloSessionCapability).not.toHaveBeenCalled();
      expect(broker.getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it('does not add SCM auth to public encoded repository paths or repository-free worktrees', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const { payload } = await prepare(
      env,
      metadata({
        repository: { type: 'git', url: 'https://public.example.com/acme/repo%20name.git' },
      })
    );
    expect(payload.git).toEqual({ url: 'https://public.example.com/acme/repo%20name.git' });
    const empty = await prepare(env, metadata({ repository: undefined }));
    expect(empty.grant.scm).toBeUndefined();
    expect(empty.payload.git).toBeUndefined();
    expect(empty.payload.kilo.token).toBe(empty.grant.kilo.alias);
  });

  it('fails closed with a missing Kilo capability broker', async () => {
    await expect(prepare(environment())).rejects.toThrow('Kilo capability issuance is unavailable');
  });

  it.each(['missing', 'throwing', 'raw-result'] as const)(
    'never resolves raw GitHub auth when strict issuance is %s',
    async mode => {
      const { broker } = createBroker();
      if (mode === 'throwing')
        broker.issueGitHubSessionCapability.mockRejectedValue(new Error('unavailable'));
      if (mode === 'raw-result')
        broker.issueGitHubSessionCapability.mockResolvedValue({
          success: true,
          capability: GITHUB_TOKEN,
          installationId: '42',
          accountLogin: 'acme',
          appType: 'standard',
          source: 'installation',
          gitAuthor: { name: 'bot', email: 'bot@example.com' },
        });
      const env = environment(
        mode === 'missing'
          ? ({ ...broker, issueGitHubSessionCapability: undefined } as never)
          : broker
      );
      await expect(prepare(env)).rejects.toMatchObject({
        name: 'Error',
        message:
          mode === 'raw-result'
            ? 'Invalid contained worktree credentials'
            : 'GitHub capability issuance is unavailable',
      });
      expectSecretSafeLogs();
      expect(broker.getTokenForRepo).not.toHaveBeenCalled();
      expect(broker.getCloudAgentAuthForRepo).not.toHaveBeenCalled();
    }
  );

  it.each<Record<string, string>>([
    { GH_TOKEN: 'custom-gh', GITHUB_TOKEN: 'custom-github' },
    { GITHUB_TOKEN: 'custom-github' },
  ])(
    'preserves user profile GitHub overrides and the GITHUB_TOKEN-only CLI precedence',
    async envVars => {
      const { broker } = createBroker();
      const { payload } = await prepare(environment(broker), metadata({ profile: { envVars } }));
      expect(payload.env?.GITHUB_TOKEN).toBe('custom-github');
      expect(payload.env?.GH_TOKEN).toBe(envVars.GH_TOKEN ?? 'custom-github');
      expect(payload.git?.token).not.toBe(payload.env?.GH_TOKEN);
    }
  );

  it('uses canonical managed GitLab auth and replaces managed profile carriers', async () => {
    const { broker } = createBroker();
    const { grant, payload } = await prepare(
      environment(broker),
      metadata({
        repository: {
          type: 'gitlab',
          url: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo',
          token: 'old-managed-gitlab-token',
          gitlabTokenManaged: true,
        },
        identity: { ...metadata().identity, createdOnPlatform: 'code-review' },
        profile: {
          envVars: {
            GITLAB_TOKEN: 'old-managed-gitlab-token',
            GLAB_IS_OAUTH2: 'true',
            GITLAB_HOST: 'stale.example.com',
          },
        },
      })
    );
    expect(payload.git).toEqual({
      url: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
      platform: 'gitlab',
      token: grant.scm?.alias,
    });
    expect(payload.env).toMatchObject({
      GITLAB_TOKEN: grant.scm?.alias,
      GLAB_IS_OAUTH2: 'false',
      GITLAB_HOST: 'gitlab.example.com:8443',
      GITLAB_SUBFOLDER: 'gitlab',
    });
    expect(broker.issueGitLabSessionCapability).toHaveBeenCalledWith({
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      outboundContainerId: OUTBOUND_CONTAINER_ID,
      gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
      createdOnPlatform: 'code-review',
    });
    expect(JSON.stringify(payload)).not.toContain('old-managed-gitlab-token');
    expect(broker.getGitLabToken).not.toHaveBeenCalled();
  });

  it('renews managed GitLab capabilities without changing pinned integration identity or aliases', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const { grant } = await prepare(
      env,
      metadata({
        repository: {
          type: 'gitlab',
          url: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
        },
      })
    );
    const result = await resolve(env, grant, {
      credential: grant.scm?.alias,
      url: 'https://gitlab.example.com:8443/gitlab/api/v4/projects/acme%2Fplatform%2Frepo',
      method: 'GET',
      now: NOW + 3 * HOUR,
    });
    expect(result).not.toBeNull();
    expect(result?.credential).not.toBe(grant.scm?.capability?.credential);
    expect(result?.grant.scm?.gitlab).toEqual(grant.scm?.gitlab);
    expect(result?.grant.scm?.alias).toBe(grant.scm?.alias);
    expect(result?.grant.expiresAt).toBe(grant.expiresAt);
    broker.issueGitLabSessionCapability.mockResolvedValue({
      success: true,
      capability: 'kgl2.different-integration',
      instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
      instanceHost: 'gitlab.example.com:8443',
      projectPath: 'acme/platform/repo',
      integrationId: REPOSITORY_UUID,
      authType: 'pat',
      identity: { accountId: '123', accountLogin: 'acme' },
      source: { type: 'integration' },
      glabIsOAuth2: false,
    });
    expect(
      await resolve(env, grant, {
        credential: grant.scm?.alias,
        url: 'https://gitlab.example.com:8443/gitlab/api/v4/projects/acme%2Fplatform%2Frepo',
        method: 'GET',
        now: NOW + 3 * HOUR,
      })
    ).toBeNull();
    expect(broker.getGitLabToken).not.toHaveBeenCalled();
  });

  it('uses canonical Bitbucket broker URLs while retaining exact UUID and integration scope', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const data = metadata({
      repository: {
        type: 'bitbucket',
        url: 'https://bitbucket.org/acme/old-name.git',
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid: REPOSITORY_UUID,
        bitbucketIntegrationId: INTEGRATION_ID,
      },
    });
    const { grant, payload } = await prepare(env, data);
    expect(payload.git).toEqual({
      url: 'https://bitbucket.org/acme/canonical-repo.git',
      platform: 'bitbucket',
      token: grant.scm?.alias,
    });
    expect(payload.env).toMatchObject({
      BITBUCKET_TOKEN: grant.scm?.alias,
      KILO_BITBUCKET_WORKSPACE_SLUG: 'acme',
      KILO_BITBUCKET_REPOSITORY_SLUG: 'canonical-repo',
      KILO_BITBUCKET_WORKSPACE_UUID: `{${WORKSPACE_UUID}}`,
      KILO_BITBUCKET_REPOSITORY_UUID: `{${REPOSITORY_UUID}}`,
    });
    expect(broker.issueBitbucketSessionCapability).toHaveBeenCalledWith({
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      expectedIntegrationId: INTEGRATION_ID,
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
      repositoryUrl: 'https://bitbucket.org/acme/old-name.git',
      outboundContainerId: OUTBOUND_CONTAINER_ID,
    });
    expect(
      await resolve(env, grant, {
        credential: grant.scm?.alias,
        url: 'https://bitbucket.org/acme/canonical-repo.git/info/refs',
        method: 'GET',
      })
    ).toMatchObject({ credential: grant.scm?.capability?.credential });
    expect(broker.getBitbucketToken).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'gitlab', url: 'https://gitlab.example.com/acme/repo.git' },
    {
      type: 'bitbucket',
      url: 'https://bitbucket.org/acme/repo.git',
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
    },
  ] satisfies Array<SessionMetadata['repository']>)(
    'rejects unsupported Vercel SCM: $type',
    async repository => {
      const { broker } = createBroker();
      await expect(prepare(environment(broker), vercelMetadata({ repository }))).rejects.toThrow(
        'Invalid contained worktree credentials'
      );
      expect(broker.getGitLabToken).not.toHaveBeenCalled();
      expect(broker.getBitbucketToken).not.toHaveBeenCalled();
    }
  );

  it('allows local Cloudflare Kilo targets but requires HTTPS targets for Vercel', async () => {
    const { broker } = createBroker();
    const env = {
      ...environment(broker),
      KILOCODE_BACKEND_BASE_URL: 'http://localhost:3000',
      KILO_OPENROUTER_BASE: 'http://localhost:3000',
    };
    const { grant } = await prepare(env);
    expect(grant.kilo.targets.backendBaseUrl).toBe('http://host.docker.internal:3000');
    expect(
      await resolve(env, grant, { url: 'http://host.docker.internal:3000/api/user', method: 'GET' })
    ).not.toBeNull();
    await expect(prepare(env, vercelMetadata())).rejects.toThrow(
      'Invalid contained worktree credentials'
    );
  });
});

function directMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return metadata({
    ...overrides,
    workspace: {
      ...overrides.workspace,
      credentialContainment: { kilocode: false, github: false, gitlab: false, bitbucket: false },
    },
  });
}

function prepareDirect(
  env: CredentialEnv,
  data = directMetadata(),
  existing?: SessionCredentialGrant,
  now = NOW
) {
  return prepareSessionCredentials({
    env,
    metadata: data,
    sandboxId: data.workspace?.sandboxId ?? SANDBOX_ID,
    existing,
    now,
  });
}

function expectNoCapabilities(broker: ReturnType<typeof createBroker>['broker']): void {
  expect(broker.issueKiloSessionCapability).not.toHaveBeenCalled();
  expect(broker.issueGitHubSessionCapability).not.toHaveBeenCalled();
  expect(broker.issueGitLabSessionCapability).not.toHaveBeenCalled();
  expect(broker.issueBitbucketSessionCapability).not.toHaveBeenCalled();
}

describe('direct worktree credentials', () => {
  it.each(['cloudflare', 'vercel'] as const)(
    'prepares real credentials without aliases or capabilities on %s',
    async provider => {
      const { broker } = createBroker();
      const env = environment(broker);
      const data = directMetadata({
        workspace: {
          sandboxProvider: provider,
          sandboxId: provider === 'vercel' ? VERCEL_SANDBOX_ID : SANDBOX_ID,
        },
      });
      const { grant, payload } = await prepareDirect(env, data);
      expect(grant.containmentEnabled).toBe(false);
      expect(isContainedSessionCredentialGrant(grant)).toBe(false);
      expect(grant.kilo.alias).toBeUndefined();
      expect(grant.kilo.capabilities).toEqual({});
      expect(grant.scm?.alias).toBeUndefined();
      expect(grant.scm?.capability).toBeUndefined();
      expect(payload.kilo).toEqual({
        scopeId: grant.scopeId,
        token: KILO_TOKEN,
        containmentEnabled: false,
        targets: grant.kilo.targets,
        organizationId: INTEGRATION_ID,
      });
      expect(payload.git).toEqual({
        url: 'https://github.com/acme/repo.git',
        platform: 'github',
        token: GITHUB_TOKEN,
      });
      expect(payload.env).toMatchObject({
        KILOCODE_TOKEN: KILO_TOKEN,
        GH_TOKEN: GITHUB_TOKEN,
        KILOCODE_ORGANIZATION_ID: INTEGRATION_ID,
      });
      expect(broker.getCloudAgentAuthForRepo).toHaveBeenCalledWith({
        githubRepo: 'acme/repo',
        userId: 'user-a',
        orgId: INTEGRATION_ID,
        expectedIntegrationId: INTEGRATION_ID,
        allowUserAuthorization: true,
      });
      expectNoCapabilities(broker);
      expect(sessionCredentialGrantSchema.parse(JSON.parse(JSON.stringify(grant)))).toEqual(grant);
      expect(await resolve(env, grant)).toBeNull();
      expect(() => buildControlNetworkPolicy([grant])).toThrow(
        'Invalid contained worktree credentials'
      );
    }
  );

  it('prepares repository-free worktrees without a broker', async () => {
    const { grant, payload } = await prepareDirect(
      environment(),
      directMetadata({ repository: undefined })
    );
    expect(payload.kilo.token).toBe(KILO_TOKEN);
    expect(payload.git).toBeUndefined();
    expect(grant.scm).toBeUndefined();
  });

  it('preserves profile overrides while trusting metadata for Kilo identity and scope', async () => {
    const { broker } = createBroker();
    const token = `https://selected-provider.example.com/api/openrouter:${KILO_TOKEN}`;
    const data = directMetadata({
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: token },
      profile: {
        envVars: {
          GH_TOKEN: 'custom-gh',
          GITHUB_TOKEN: 'custom-github',
          KILOCODE_TOKEN: 'untrusted-kilo',
          KILOCODE_ORGANIZATION_ID: 'untrusted-org',
          PUBLIC_VALUE: 'kept',
        },
        setupCommands: ['run --token=custom-gh'],
      },
    });
    const { payload } = await prepareDirect(environment(broker), data);
    expect(payload.env).toMatchObject({
      GH_TOKEN: 'custom-gh',
      GITHUB_TOKEN: 'custom-github',
      KILOCODE_TOKEN: token,
      KILOCODE_ORGANIZATION_ID: INTEGRATION_ID,
      PUBLIC_VALUE: 'kept',
    });
    expect(payload.kilo.targets.providerBaseUrl).toBe(
      'https://selected-provider.example.com/api/openrouter'
    );
    expect(payload.kilo.organizationId).toBe(INTEGRATION_ID);
    expect(payload.setupCommands).toEqual(['run --token=custom-gh']);
    expect(payload.git?.token).toBe(GITHUB_TOKEN);
    const personal = await prepareDirect(
      environment(broker),
      directMetadata({
        identity: { ...data.identity, orgId: undefined },
        profile: {
          envVars: { GITHUB_TOKEN: 'custom-github', KILOCODE_ORGANIZATION_ID: 'untrusted-org' },
        },
      })
    );
    expect(personal.payload.env?.GH_TOKEN).toBe('custom-github');
    expect(personal.payload.kilo.organizationId).toBeUndefined();
    expect(personal.payload.env?.KILOCODE_ORGANIZATION_ID).toBeUndefined();
    expectNoCapabilities(broker);
  });

  it('keeps explicit GitHub authentication without calling a broker', async () => {
    const { broker } = createBroker();
    const { payload } = await prepareDirect(
      environment(broker),
      directMetadata({ repository: { type: 'github', repo: 'acme/repo', token: GITHUB_TOKEN } })
    );
    expect(payload.git?.token).toBe(GITHUB_TOKEN);
    expect(broker.getCloudAgentAuthForRepo).not.toHaveBeenCalled();
    expect(broker.getTokenForRepo).not.toHaveBeenCalled();
    expectNoCapabilities(broker);
  });

  it('resolves scoped managed GitLab tokens and rotates only managed profile carriers', async () => {
    const { broker } = createBroker();
    const data = directMetadata({
      repository: {
        type: 'gitlab',
        url: 'https://gitlab.example.com:8443/gitlab/acme/repo.git',
        token: 'old-managed-token',
        gitlabTokenManaged: true,
      },
      profile: {
        envVars: {
          GITLAB_TOKEN: 'old-managed-token',
          GITLAB_HOST: 'stale.example.com',
          GLAB_IS_OAUTH2: 'true',
        },
      },
    });
    const { payload } = await prepareDirect(environment(broker), data);
    expect(payload.git?.token).toBe('test-real-gitlab-token');
    expect(payload.env).toMatchObject({
      GITLAB_TOKEN: 'test-real-gitlab-token',
      GITLAB_HOST: 'gitlab.example.com:8443',
      GITLAB_SUBFOLDER: 'gitlab',
      GLAB_IS_OAUTH2: 'false',
    });
    expect(broker.getGitLabToken).toHaveBeenCalledWith({
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      repositoryUrl: 'https://gitlab.example.com:8443/gitlab/acme/repo.git',
      createdOnPlatform: 'cloud-agent-web',
    });
    const custom = await prepareDirect(environment(broker), {
      ...data,
      profile: { envVars: { GITLAB_TOKEN: 'custom-gitlab', GITLAB_HOST: 'custom.example.com' } },
    });
    expect(custom.payload.env).toMatchObject({
      GITLAB_TOKEN: 'custom-gitlab',
      GITLAB_HOST: 'custom.example.com',
    });
    expectNoCapabilities(broker);
  });

  it.each([
    'https://other.example.com/gitlab',
    'https://gitlab.example.com/gitlab',
    'https://gitlab.example.com:8443/gitlab-other',
  ])('rejects GitLab instance scope mismatch: %s', async instanceUrl => {
    const { broker } = createBroker();
    broker.getGitLabToken.mockResolvedValue({
      success: true,
      token: 'test-real-gitlab-token',
      instanceUrl,
      glabIsOAuth2: false,
    });
    await expect(
      prepareDirect(
        environment(broker),
        directMetadata({
          repository: {
            type: 'gitlab',
            url: 'https://gitlab.example.com:8443/gitlab/acme/repo.git',
          },
        })
      )
    ).rejects.toThrow('Invalid contained worktree credentials');
    expectNoCapabilities(broker);
  });

  it('resolves Bitbucket tokens with organization, UUID, URL and integration authorization', async () => {
    const { broker } = createBroker();
    const data = directMetadata({
      repository: {
        type: 'bitbucket',
        url: 'https://bitbucket.org/acme/repo.git',
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid: REPOSITORY_UUID,
        bitbucketIntegrationId: INTEGRATION_ID,
      },
    });
    const { payload } = await prepareDirect(environment(broker), data);
    expect(payload.git?.token).toBe('test-real-bitbucket-token');
    expect(payload.env).toMatchObject({
      BITBUCKET_TOKEN: 'test-real-bitbucket-token',
      KILO_BITBUCKET_WORKSPACE_SLUG: 'acme',
      KILO_BITBUCKET_REPOSITORY_SLUG: 'repo',
      KILO_BITBUCKET_WORKSPACE_UUID: `{${WORKSPACE_UUID}}`,
      KILO_BITBUCKET_REPOSITORY_UUID: `{${REPOSITORY_UUID}}`,
    });
    expect(broker.getBitbucketToken).toHaveBeenCalledWith({
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      expectedIntegrationId: INTEGRATION_ID,
      repositoryUrl: 'https://bitbucket.org/acme/repo.git',
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
    });
    await expect(
      prepareDirect(environment(broker), {
        ...data,
        identity: { ...data.identity, orgId: undefined },
      })
    ).rejects.toThrow('Invalid contained worktree credentials');
    expect(broker.getBitbucketToken).toHaveBeenCalledTimes(1);
    expectNoCapabilities(broker);
  });

  it('shares only authorized memberships and renews the bounded lease', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepareDirect(env);
    const second = await prepareDirect(
      env,
      directMetadata({ identity: secondRoot().identity, auth: secondRoot().auth }),
      first.grant,
      NOW + HOUR
    );
    expect(second.grant.members).toHaveLength(2);
    expect(second.grant.expiresAt).toBe(NOW + 5 * HOUR);
    expect(
      removeSessionCredentialMembership([second.grant], SECOND_SESSION_ID)[0]?.members
    ).toEqual(first.grant.members);
    for (const changed of [
      directMetadata({ identity: { ...metadata().identity, userId: 'other-user' } }),
      directMetadata({ identity: { ...metadata().identity, orgId: REPOSITORY_UUID } }),
      directMetadata({ workspace: { workspacePath: '/workspace/other' } }),
      directMetadata({
        workspace: { worktreeId: 'worktree_22222222-2222-4222-8222-222222222222' },
      }),
      directMetadata({ auth: { kiloSessionId: SECOND_ROOT_ID, kilocodeToken: KILO_TOKEN } }),
      directMetadata({ repository: { type: 'github', repo: 'acme/other' } }),
    ]) {
      await expect(prepareDirect(env, changed, first.grant)).rejects.toThrow(
        'Invalid contained worktree credentials'
      );
    }
    expect(broker.getCloudAgentAuthForRepo).toHaveBeenCalledTimes(2);
    expectNoCapabilities(broker);
  });

  it('rejects contained/direct grant reuse in both directions', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const direct = await prepareDirect(env);
    const contained = await prepare(env);
    await expect(prepareDirect(env, directMetadata(), contained.grant)).rejects.toThrow(
      'Invalid contained worktree credentials'
    );
    await expect(prepare(env, metadata(), direct.grant)).rejects.toThrow(
      'Invalid contained worktree credentials'
    );
    expect(broker.getCloudAgentAuthForRepo).toHaveBeenCalledTimes(1);
    expect(broker.issueKiloSessionCapability).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', 'invalid\nvalue', 'kcp1.alias', 'kka1.capability'])(
    'rejects invalid direct Kilo token %s',
    async kilocodeToken => {
      const { broker } = createBroker();
      await expect(
        prepareDirect(
          environment(broker),
          directMetadata({ auth: { kiloSessionId: ROOT_ID, kilocodeToken } })
        )
      ).rejects.toThrow('Invalid contained worktree credentials');
      expect(broker.getCloudAgentAuthForRepo).not.toHaveBeenCalled();
      expectNoCapabilities(broker);
    }
  );

  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'fails closed on %s token errors and invalid token results',
    async platform => {
      const { broker } = createBroker();
      const data = directMetadata({
        repository:
          platform === 'github'
            ? metadata().repository
            : platform === 'gitlab'
              ? { type: 'gitlab', url: 'https://gitlab.example.com:8443/gitlab/acme/repo.git' }
              : {
                  type: 'bitbucket',
                  url: 'https://bitbucket.org/acme/repo.git',
                  workspaceUuid: WORKSPACE_UUID,
                  repositoryUuid: REPOSITORY_UUID,
                },
      });
      await expect(prepareDirect(environment(), data)).rejects.toThrow('credential is unavailable');
      if (platform === 'github') {
        broker.getCloudAgentAuthForRepo.mockResolvedValue({
          success: false,
          reason: 'integration_mismatch',
        });
      }
      if (platform === 'gitlab') {
        broker.getGitLabToken.mockResolvedValue({
          success: false,
          reason: 'no_matching_integration',
        });
      }
      if (platform === 'bitbucket') {
        broker.getBitbucketToken.mockResolvedValue({
          success: false,
          reason: 'integration_mismatch',
        });
      }
      await expect(prepareDirect(environment(broker), data)).rejects.toThrow(
        'credential is unavailable'
      );
      expect(broker.getTokenForRepo).not.toHaveBeenCalled();
      if (platform === 'github') {
        broker.getCloudAgentAuthForRepo.mockResolvedValue({
          success: true,
          githubToken: 'kgh2.not-real',
          installationId: '42',
          accountLogin: 'acme',
          appType: 'standard',
          source: 'user',
          gitAuthor: { name: 'bot', email: 'bot@example.com' },
        });
      }
      if (platform === 'gitlab') {
        broker.getGitLabToken.mockResolvedValue({
          success: true,
          token: '',
          instanceUrl: 'https://gitlab.example.com:8443/gitlab',
          glabIsOAuth2: false,
        });
      }
      if (platform === 'bitbucket') {
        broker.getBitbucketToken.mockResolvedValue({ success: true, token: 'bad\ntoken' });
      }
      await expect(prepareDirect(environment(broker), data)).rejects.toThrow(
        'Invalid contained worktree credentials'
      );
      expectNoCapabilities(broker);
      expectSecretSafeLogs();
    }
  );

  it('rejects aliases and capabilities in persisted direct grants and missing aliases in contained grants', async () => {
    const { broker } = createBroker();
    const direct = await prepareDirect(environment(broker));
    const contained = await prepare(environment(broker));
    for (const invalid of [
      { ...direct.grant, kilo: { ...direct.grant.kilo, alias: contained.grant.kilo.alias } },
      {
        ...direct.grant,
        kilo: { ...direct.grant.kilo, capabilities: contained.grant.kilo.capabilities },
      },
      { ...direct.grant, scm: { ...direct.grant.scm, alias: contained.grant.scm?.alias } },
      {
        ...direct.grant,
        scm: { ...direct.grant.scm, capability: contained.grant.scm?.capability },
      },
      { ...direct.grant, containmentEnabled: undefined },
      { ...direct.grant, expiresAt: NOW + 5 * HOUR },
      { ...contained.grant, kilo: { ...contained.grant.kilo, alias: undefined } },
    ]) {
      expect(sessionCredentialGrantSchema.safeParse(invalid).success).toBe(false);
    }
    expect(isContainedSessionCredentialGrant(contained.grant)).toBe(true);
    const explicitlyContained = { ...contained.grant, containmentEnabled: true };
    expect(sessionCredentialGrantSchema.parse(explicitlyContained)).toEqual(explicitlyContained);
    expect(isContainedSessionCredentialGrant(explicitlyContained)).toBe(true);
    expect(
      sessionCredentialGrantSchema.safeParse({ ...direct.grant, containmentEnabled: true }).success
    ).toBe(false);
  });
});

describe('direct worktree Kilo token stability', () => {
  const secret = 'worktree-jwt-test-secret';
  const env = { ...environment(), NEXTAUTH_SECRET: secret };
  const token = (issuedAt = NOW, claims: Record<string, unknown> = {}, signingSecret = secret) => {
    const payload = {
      env: 'production',
      kiloUserId: 'user-a',
      apiTokenPepper: 'test-pepper',
      version: 3,
      tokenSource: 'cloud-agent',
      iat: issuedAt / 1000,
      exp: (issuedAt + 24 * HOUR) / 1000,
      ...claims,
    };
    return jwt.sign(
      Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
      signingSecret,
      { algorithm: 'HS256' }
    );
  };
  const data = (kilocodeToken: string, sessionId = SESSION_ID, kiloSessionId = ROOT_ID) =>
    directMetadata({
      repository: undefined,
      identity: { ...metadata().identity, sessionId },
      auth: { kilocodeToken, kiloSessionId },
      profile: {
        envVars: {
          KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: kilocodeToken } }),
        },
        setupCommands: [`authenticate --token=${kilocodeToken}`],
      },
    });

  it('keeps identical runtime credentials across three siblings and alternating reattaches', async () => {
    const siblings = [
      data(token()),
      data(token(NOW + 1000), SECOND_SESSION_ID, SECOND_ROOT_ID),
      data(token(NOW + 2000), THIRD_SESSION_ID, THIRD_ROOT_ID),
    ];
    expect(new Set(siblings.map(sibling => sibling.auth.kilocodeToken)).size).toBe(3);
    const first = await prepareDirect(env, siblings[0]);
    let current = first;
    for (const sibling of [...siblings, ...siblings.toReversed(), ...siblings]) {
      current = await prepareDirect(env, sibling, current.grant, NOW + 3000);
      expect(current.grant.kilo.token).toBe(first.grant.kilo.token);
      expect(current.payload.kilo).toEqual(first.payload.kilo);
      expect(current.payload.env).toEqual(first.payload.env);
      expect(current.payload.setupCommands).toEqual(first.payload.setupCommands);
    }
    expect(current.grant.members).toHaveLength(3);
    expect(first.grant.members).toHaveLength(1);
    expect(siblings[1].auth.kilocodeToken).not.toBe(first.grant.kilo.token);
  });

  it.each([60_000, 120_000])('refreshes when the retained JWT expires in %i ms', async lifetime => {
    const original = token(NOW, { exp: (NOW + lifetime) / 1000 });
    const fresh = token(NOW + 1000);
    const first = await prepareDirect(env, data(original));
    const refreshed = await prepareDirect(
      env,
      data(fresh, SECOND_SESSION_ID, SECOND_ROOT_ID),
      first.grant,
      NOW + 60_000
    );
    expect(refreshed.payload.kilo.token).toBe(fresh);
    expect(refreshed.payload.env?.KILOCODE_TOKEN).toBe(fresh);
  });

  it.each([false, true])(
    'does not slide the selection window when renewing a lease (legacy grant: %s)',
    async legacy => {
      const original = token();
      const fresh = token(NOW + 1000);
      const first = await prepareDirect(env, data(original));
      if (legacy) delete first.grant.kilo.tokenSelectedAt;
      const sibling = data(fresh, SECOND_SESSION_ID, SECOND_ROOT_ID);
      const renewed = await prepareDirect(env, sibling, first.grant, NOW + 3 * HOUR);
      expect(renewed.grant.kilo.token).toBe(original);
      expect(renewed.grant.kilo.tokenSelectedAt).toBe(NOW);
      expect(renewed.grant.expiresAt).toBe(NOW + 7 * HOUR);
      const persisted = sessionCredentialGrantSchema.parse(
        JSON.parse(JSON.stringify(renewed.grant))
      );
      const refreshed = await prepareDirect(env, sibling, persisted, NOW + 4 * HOUR);
      expect(refreshed.grant.kilo.token).toBe(fresh);
      expect(refreshed.grant.kilo.tokenSelectedAt).toBe(NOW + 4 * HOUR);
      const reattached = await prepareDirect(
        env,
        data(original),
        refreshed.grant,
        NOW + 4 * HOUR + 1
      );
      expect(reattached.grant.kilo.token).toBe(fresh);
    }
  );

  it('refreshes an expired grant even when its JWT remains valid', async () => {
    const first = await prepareDirect(env, data(token()));
    const fresh = token(NOW + 1000);
    const refreshed = await prepareDirect(env, data(fresh), first.grant, first.grant.expiresAt);
    expect(refreshed.payload.kilo.token).toBe(fresh);
  });

  it.each([
    ['pepper', { apiTokenPepper: 'rotated-pepper' }],
    ['nullable pepper', { apiTokenPepper: null }],
    ['user', { kiloUserId: 'other-user' }],
    ['environment', { env: 'development' }],
    ['version', { version: 4 }],
    ['source', { tokenSource: 'other-source' }],
    ['organization', { organizationId: INTEGRATION_ID }],
    ['role', { organizationRole: 'member' }],
    ['bot', { botId: 'bot-a' }],
    ['unknown authorization', { futurePermission: 'restricted' }],
  ])('does not substitute the retained token after a change to %s', async (_name, claims) => {
    const first = await prepareDirect(env, data(token()));
    const changed = token(NOW + 1000, claims);
    const refreshed = await prepareDirect(env, data(changed), first.grant, NOW + 2000);
    expect(refreshed.payload.kilo.token).toBe(changed);
    expect(refreshed.payload.env?.KILOCODE_TOKEN).toBe(changed);
  });

  it('fails closed for unsupported audience-bearing direct credentials at this checkpoint', async () => {
    const first = await prepareDirect(env, data(token()));
    const changed = token(NOW + 1000, { aud: 'internal-service' });
    await expect(prepareDirect(env, data(changed), first.grant, NOW + 2000)).rejects.toThrow(
      'Invalid contained worktree credentials'
    );
  });

  it.each([
    ['expired', () => token(NOW - HOUR, { exp: NOW / 1000 })],
    ['future-issued', () => token(NOW + HOUR)],
    ['not yet valid', () => token(NOW, { nbf: (NOW + HOUR) / 1000 })],
    ['missing expiry', () => token(NOW, { exp: undefined })],
    ['invalid signature', () => token(NOW, {}, 'different-test-secret')],
    ['opaque', () => 'opaque-replacement-token'],
  ])(
    'does not mask %s incoming credentials with a retained valid JWT',
    async (_name, changedToken) => {
      const first = await prepareDirect(env, data(token()));
      const changed = changedToken();
      const refreshed = await prepareDirect(env, data(changed), first.grant, NOW + 2000);
      expect(refreshed.payload.kilo.token).toBe(changed);
    }
  );

  it.each([
    ['invalid signature', () => token(NOW, {}, 'different-test-secret')],
    ['future-issued', () => token(NOW + HOUR)],
    ['unknown claims', () => token(NOW, { futurePermission: 'restricted' })],
    ['opaque', () => 'opaque-original-token'],
  ])('does not retain %s credentials', async (_name, originalToken) => {
    const first = await prepareDirect(env, data(originalToken()));
    const fresh = token(NOW + 1000);
    const refreshed = await prepareDirect(env, data(fresh), first.grant, NOW + 2000);
    expect(refreshed.payload.kilo.token).toBe(fresh);
  });

  it('does not coalesce equivalent claims for a different metadata owner', async () => {
    const first = await prepareDirect(env, data(token(NOW, { kiloUserId: 'other-user' })));
    const fresh = token(NOW + 1000, { kiloUserId: 'other-user' });
    const refreshed = await prepareDirect(env, data(fresh), first.grant, NOW + 2000);
    expect(refreshed.payload.kilo.token).toBe(fresh);
  });

  it('still checks managed SCM authorization when retaining an equivalent Kilo token', async () => {
    const { broker } = createBroker();
    const brokerEnv = { ...environment(broker), NEXTAUTH_SECRET: secret };
    const first = await prepareDirect(brokerEnv, {
      ...data(token()),
      repository: metadata().repository,
    });
    broker.getCloudAgentAuthForRepo.mockResolvedValue({
      success: false,
      reason: 'integration_mismatch',
    });
    await expect(
      prepareDirect(
        brokerEnv,
        { ...data(token(NOW + 1000)), repository: metadata().repository },
        first.grant,
        NOW + 2000
      )
    ).rejects.toThrow('GitHub credential is unavailable');
  });

  it('leaves contained backing-token rotation unchanged for equivalent JWTs', async () => {
    const { broker } = createBroker();
    const brokerEnv = { ...environment(broker), NEXTAUTH_SECRET: secret };
    const first = await prepare(brokerEnv, metadata({ auth: data(token()).auth }));
    const fresh = token(NOW + 1000);
    const refreshed = await prepare(
      brokerEnv,
      metadata({ auth: data(fresh).auth }),
      first.grant,
      NOW + 2000
    );
    expect(refreshed.grant.kilo.token).toBe(fresh);
    expect(refreshed.grant.kilo.tokenSelectedAt).toBeUndefined();
    expect(refreshed.grant.kilo.capabilities[SESSION_ID]).not.toEqual(
      first.grant.kilo.capabilities[SESSION_ID]
    );
    expect(refreshed.payload.kilo).toEqual(first.payload.kilo);
  });

  it('keeps the incoming token when the signing secret is unavailable', async () => {
    const first = await prepareDirect(env, data(token()));
    const fresh = token(NOW + 1000);
    for (const unavailable of [
      environment(),
      {
        ...environment(),
        NEXTAUTH_SECRET: {
          get: async () => {
            throw new Error('unavailable');
          },
        },
      },
    ]) {
      const refreshed = await prepareDirect(unavailable, data(fresh), first.grant, NOW + 2000);
      expect(refreshed.payload.kilo.token).toBe(fresh);
    }
  });
});

describe('credential failure safety', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      name: 'Kilo',
      rpc: 'issueKiloSessionCapability',
      data: metadata(),
      message: 'Kilo capability issuance is unavailable',
    },
    {
      name: 'GitHub',
      rpc: 'issueGitHubSessionCapability',
      data: metadata(),
      message: 'GitHub capability issuance is unavailable',
    },
    {
      name: 'GitLab',
      rpc: 'issueGitLabSessionCapability',
      data: metadata({
        repository: {
          type: 'gitlab',
          url: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
        },
      }),
      message: 'GitLab capability issuance is unavailable',
    },
    {
      name: 'Bitbucket',
      rpc: 'issueBitbucketSessionCapability',
      data: metadata({
        repository: {
          type: 'bitbucket',
          url: 'https://bitbucket.org/acme/repo.git',
          workspaceUuid: WORKSPACE_UUID,
          repositoryUuid: REPOSITORY_UUID,
        },
      }),
      message: 'Bitbucket capability issuance is unavailable',
    },
    {
      name: 'Vercel GitHub',
      rpc: 'getTokenForRepo',
      data: vercelMetadata(),
      message: 'GitHub credential is unavailable',
    },
  ] as const)(
    'keeps $name broker exceptions out of logs, preparation errors, and resolution output',
    async ({ name, rpc, data, message }) => {
      const { broker } = createBroker();
      const env = environment(broker);
      const { grant } = await prepare(env, data);
      broker[rpc].mockRejectedValue(
        new Error(`Broker rejected ${KILO_TOKEN}, ${GITHUB_TOKEN}, ${BROKER_ERROR_SECRET}`)
      );

      await expect(prepare(env, data, grant, NOW + 3 * HOUR)).rejects.toMatchObject({
        name: 'Error',
        message,
      });
      if (data.workspace?.sandboxProvider !== 'vercel') {
        const credential = name === 'Kilo' ? grant.kilo.alias : grant.scm?.alias;
        if (!credential) throw new Error('Expected credential alias');
        expect(
          await resolve(env, grant, {
            credential,
            ...(name === 'Kilo' ? {} : { url: `${grant.scm?.gitUrl}/info/refs`, method: 'GET' }),
            now: NOW + 3 * HOUR,
          })
        ).toBeNull();
        expect(broker.getTokenForRepo).not.toHaveBeenCalled();
      }
      expect(broker.getCloudAgentAuthForRepo).not.toHaveBeenCalled();
      expect(broker.getGitLabToken).not.toHaveBeenCalled();
      expect(broker.getBitbucketToken).not.toHaveBeenCalled();
      expectSecretSafeLogs();
    }
  );

  it('reports invalid metadata and persisted grant failures without Zod values', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const invalidTokenMetadata = metadata({
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: `${KILO_TOKEN}\n${BROKER_ERROR_SECRET}` },
    });
    await expect(prepare(env, invalidTokenMetadata)).rejects.toMatchObject({
      name: 'Error',
      message: 'Invalid contained worktree credentials',
    });
    const { grant } = await prepare(env);
    const invalidGrant = {
      ...grant,
      kilo: { ...grant.kilo, [BROKER_ERROR_SECRET]: KILO_TOKEN },
    };
    await expect(prepare(env, metadata(), invalidGrant)).rejects.toMatchObject({
      name: 'Error',
      message: 'Invalid contained worktree credentials',
    });
    expect(() => buildControlNetworkPolicy([invalidGrant])).toThrow(
      'Invalid contained worktree credentials'
    );
    expect(await resolve(env, invalidGrant)).toBeNull();
    expectSecretSafeLogs();
  });
});

describe('credential resolution boundaries', () => {
  it.each([
    ['/api/auth/native/exchange', 'POST'],
    ['/api/organizations/acme/user-tokens', 'GET'],
    ['/api/gastown/git-credentials', 'POST'],
    ['/api/wasteland/token', 'POST'],
    ['/api/mcp/connect-token', 'GET'],
    ['/api/profile/tokens', 'GET'],
    ['/api/user/token', 'GET'],
    ['/api/user', 'POST'],
    ['/api/session', 'POST'],
    [`/api/session/${ROOT_ID}/import`, 'POST'],
  ])('denies arbitrary or credential-returning Kilo route %s %s', async (path, method) => {
    const { broker } = createBroker();
    const env = {
      ...environment(broker),
      KILOCODE_BACKEND_BASE_URL: 'https://shared.example.com',
      KILO_OPENROUTER_BASE: 'https://shared.example.com',
      KILO_SESSION_INGEST_URL: 'https://shared.example.com',
    };
    const { grant } = await prepare(env);
    expect(
      await resolve(env, grant, { url: `https://shared.example.com${path}`, method })
    ).toBeNull();
  });

  it('respects same-host session shadows even beneath broad provider prefixes', async () => {
    const { broker } = createBroker();
    const env = {
      ...environment(broker),
      KILO_SESSION_INGEST_URL: 'https://provider.example.com/api/openrouter',
    };
    const first = await prepare(env);
    const { grant } = await prepare(env, secondRoot(), first.grant);
    const collection = 'https://provider.example.com/api/openrouter/api/session';
    expect(
      await resolve(env, grant, { url: `${collection}/${SECOND_ROOT_ID}/export`, method: 'GET' })
    ).not.toBeNull();
    expect(
      await resolve(env, grant, { url: `${collection}/${THIRD_ROOT_ID}/export`, method: 'GET' })
    ).toBeNull();
    expect(
      await resolve(env, grant, { url: `${collection}/${THIRD_ROOT_ID}/ingest`, method: 'POST' })
    ).toBeNull();
    expect(await resolve(env, grant, { url: collection })).toBeNull();
  });

  it('rejects sibling aliases, wrong containers, wrong purposes, ports, and origins', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    const sibling = await prepare(
      env,
      metadata(
        { workspace: { workspacePath: '/workspace/other' } },
        'worktree_22222222-2222-4222-8222-222222222222'
      )
    );
    expect(sibling.grant.kilo.alias).not.toBe(first.grant.kilo.alias);
    for (const overrides of [
      { credential: sibling.grant.kilo.alias },
      { credential: createControlPlaneCredential(SANDBOX_ID, 'gitlab') },
      { credential: createControlPlaneCredential('usr-deadbeef', 'kilo') },
      { credential: KILO_TOKEN },
      { credential: first.grant.kilo.capabilities[SESSION_ID]?.credential },
      { outboundContainerId: `standard:${SANDBOX_ID}` },
      { url: 'https://provider.example.com:8443/api/openrouter/chat/completions' },
      { url: 'http://provider.example.com/api/openrouter/chat/completions' },
      { url: 'https://other.example.com/api/openrouter/chat/completions' },
      { url: 'https://user@provider.example.com/api/openrouter/chat/completions' },
    ]) {
      expect(await resolve(env, first.grant, overrides)).toBeNull();
    }
  });

  it('does not fall back to expired or raw credentials if renewal fails', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const { grant } = await prepare(env);
    broker.issueKiloSessionCapability.mockRejectedValue(new Error('unavailable'));
    broker.issueGitHubSessionCapability.mockRejectedValue(new Error('unavailable'));
    expect(await resolve(env, grant, { now: NOW + 3 * HOUR })).toBeNull();
    expect(
      await resolve(env, grant, {
        now: NOW + 3 * HOUR,
        credential: grant.scm?.alias,
        url: 'https://api.github.com/repos/acme/repo',
        method: 'GET',
      })
    ).toBeNull();
    expect(broker.getTokenForRepo).not.toHaveBeenCalled();
    expect(broker.getCloudAgentAuthForRepo).not.toHaveBeenCalled();
  });

  it('removes only the requested membership, its capabilities, and finally empty grants', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepare(env);
    const second = await prepare(env, secondRoot(), first.grant);
    const sibling = await prepare(
      env,
      metadata(
        { workspace: { workspacePath: '/workspace/other' } },
        'worktree_22222222-2222-4222-8222-222222222222'
      )
    );
    const grants = removeSessionCredentialMembership(
      [second.grant, sibling.grant],
      SECOND_SESSION_ID
    );
    expect(grants).toHaveLength(2);
    expect(grants[0]?.members).toEqual(first.grant.members);
    expect(grants[0]?.kilo.alias).toBe(second.grant.kilo.alias);
    expect(grants[0]?.kilo.capabilities).not.toHaveProperty(SECOND_SESSION_ID);
    expect(grants[1]).toBe(sibling.grant);
    expect(second.grant.members).toHaveLength(2);
    const retained = grants[0];
    if (!retained) throw new Error('Expected retained worktree');
    expect(
      await resolve(env, retained, {
        url: `https://ingest.example.com/api/session/${SECOND_ROOT_ID}/export`,
        method: 'GET',
      })
    ).toBeNull();
    expect(removeSessionCredentialMembership(grants, SESSION_ID)).toEqual([]);
  });

  it('validates persisted alias purpose, memberships, and bounded lease/cache lifetimes', async () => {
    const { broker } = createBroker();
    const { grant } = await prepare(environment(broker));
    const capability = grant.kilo.capabilities[SESSION_ID];
    if (!capability) throw new Error('Expected Kilo capability');
    for (const invalid of [
      { ...grant, members: [] },
      { ...grant, members: [...grant.members, ...grant.members] },
      { ...grant, expiresAt: NOW + 5 * HOUR },
      { ...grant, kilo: { ...grant.kilo, alias: grant.scm?.alias } },
      {
        ...grant,
        kilo: {
          ...grant.kilo,
          capabilities: { [SESSION_ID]: { ...capability, expiresAt: NOW + 4 * HOUR } },
        },
      },
      { ...grant, kilo: { ...grant.kilo, capabilities: { [THIRD_SESSION_ID]: capability } } },
      { ...grant, scm: { ...grant.scm, nativeToken: GITHUB_TOKEN } },
    ]) {
      expect(sessionCredentialGrantSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('native Vercel worktree policies', () => {
  it('composes sibling worktree rules without losing registered roots or broadening aliases', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const first = await prepare(env, vercelMetadata());
    const second = await prepare(
      env,
      vercelMetadata({ identity: secondRoot().identity, auth: secondRoot().auth }),
      first.grant
    );
    const sibling = await prepare(
      env,
      vercelMetadata(
        {
          identity: { ...metadata().identity, sessionId: THIRD_SESSION_ID },
          auth: { kiloSessionId: THIRD_ROOT_ID, kilocodeToken: 'test-sibling-kilo-token' },
          workspace: { workspacePath: '/workspace/sibling' },
          repository: { type: 'github', repo: 'acme/another' },
        },
        'worktree_33333333-3333-4333-8333-333333333333'
      )
    );
    const policy = buildControlNetworkPolicy([second.grant, sibling.grant]);
    const authorizationFor = (rootId: string, alias: string) =>
      findMatchingCredentialInjectionRule(policy.injectionRules, {
        url: new URL(`https://ingest.example.com/api/session/${rootId}/export`),
        method: 'GET',
        headers: new Headers({ authorization: `Bearer ${alias}` }),
      })?.headers.authorization;

    expect(second.grant.kilo.alias).toBe(first.grant.kilo.alias);
    expect(authorizationFor(ROOT_ID, second.grant.kilo.alias)).toBe(`Bearer ${KILO_TOKEN}`);
    expect(authorizationFor(SECOND_ROOT_ID, second.grant.kilo.alias)).toBe(`Bearer ${KILO_TOKEN}`);
    expect(authorizationFor(THIRD_ROOT_ID, sibling.grant.kilo.alias)).toBe(
      'Bearer test-sibling-kilo-token'
    );
    expect(authorizationFor(THIRD_ROOT_ID, second.grant.kilo.alias)).toBeUndefined();
    expect(authorizationFor(ROOT_ID, sibling.grant.kilo.alias)).toBeUndefined();
    expect(policy.allowedDomains).toContain('*');
    expect(new Set(policy.allowedDomains).size).toBe(policy.allowedDomains.length);
    expect(broker.issueKiloSessionCapability).not.toHaveBeenCalled();
    expect(broker.issueGitHubSessionCapability).not.toHaveBeenCalled();
    expect(buildControlNetworkPolicy([])).toEqual({
      mode: 'custom',
      allowedDomains: ['*'],
      injectionRules: [],
    });
  });

  it('refreshes native GitHub injection on trusted prepare while preserving the integration pin and alias', async () => {
    const { broker } = createBroker();
    const env = environment(broker);
    const data = vercelMetadata({ profile: { envVars: { GH_TOKEN: GITHUB_TOKEN } } });
    const first = await prepare(env, data);
    broker.getTokenForRepo.mockResolvedValue({
      success: true,
      token: 'test-renewed-github-token',
      installationId: '42',
      accountLogin: 'acme',
      appType: 'standard',
    });
    const second = await prepare(env, data, first.grant, NOW + HOUR);
    expect(second.grant.scm?.alias).toBe(first.grant.scm?.alias);
    expect(second.payload.env?.GH_TOKEN).toBe(first.grant.scm?.alias);
    expect(second.grant.scm?.nativeToken).toBe('test-renewed-github-token');
    expect(broker.getTokenForRepo).toHaveBeenLastCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user-a',
      orgId: INTEGRATION_ID,
      expectedIntegrationId: INTEGRATION_ID,
    });
    const policy = buildControlNetworkPolicy([second.grant]);
    expect(
      findMatchingCredentialInjectionRule(policy.injectionRules, {
        url: new URL('https://api.github.com/repos/acme/repo'),
        method: 'GET',
        headers: new Headers({ authorization: `Bearer ${second.grant.scm?.alias}` }),
      })?.headers.authorization
    ).toBe('Bearer test-renewed-github-token');
    expect(JSON.stringify(second.payload)).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(second.payload)).not.toContain('test-renewed-github-token');
  });

  it.each([false, true])(
    'contains native GitHub tokens without replacing explicit authentication: explicit=%s',
    async explicit => {
      const { broker } = createBroker();
      const { grant, payload } = await prepare(
        environment(broker),
        vercelMetadata({
          repository: {
            type: 'github',
            repo: 'acme/repo',
            ...(explicit ? { token: GITHUB_TOKEN } : {}),
          },
          profile: {
            envVars: { GITHUB_TOKEN, KILO_CONFIG_CONTENT: JSON.stringify({ token: KILO_TOKEN }) },
          },
        })
      );
      expect(grant.scm?.nativeToken).toBe(GITHUB_TOKEN);
      expect(grant.repository).toMatchObject({ authentication: explicit ? 'explicit' : 'managed' });
      expect(payload.env?.GH_TOKEN).toBe(grant.scm?.alias);
      expect(payload.env?.GITHUB_TOKEN).toBe(grant.scm?.alias);
      expect(payload.git?.token).toBe(grant.scm?.alias);
      expect(JSON.stringify(payload)).not.toContain(GITHUB_TOKEN);
      expect(JSON.stringify(payload)).not.toContain(KILO_TOKEN);
      expect(broker.getTokenForRepo).toHaveBeenCalledTimes(explicit ? 0 : 1);
    }
  );
});
