import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env, GitTokenService } from '../types.js';
import { createControlPlaneCredential, parseControlPlaneCredential } from './managed-credential.js';
import {
  buildControlNetworkPolicy,
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
    getCloudAgentAuthForRepo: vi.fn<NonNullable<GitTokenService['getCloudAgentAuthForRepo']>>(),
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
    getGitLabToken: vi.fn<GitTokenService['getGitLabToken']>(),
    getBitbucketToken: vi.fn<NonNullable<GitTokenService['getBitbucketToken']>>(),
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
  scopeId: string | null = 'worktree-a'
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

function prepare(
  env: CredentialEnv,
  data = metadata(),
  existing?: SessionCredentialGrant,
  now = NOW
) {
  return prepareSessionCredentials({
    env,
    metadata: data,
    sandboxId: data.workspace?.sandboxId ?? SANDBOX_ID,
    ...(data.workspace?.sandboxProvider === 'vercel'
      ? {}
      : { outboundContainerId: OUTBOUND_CONTAINER_ID }),
    existing,
    now,
  });
}

function resolve(
  env: CredentialEnv,
  grant: SessionCredentialGrant,
  overrides: Partial<Parameters<typeof resolveSessionCredential>[0]> = {}
) {
  return resolveSessionCredential({
    env,
    grant,
    credential: grant.kilo.alias,
    url: 'https://provider.example.com/api/openrouter/chat/completions',
    method: 'POST',
    outboundContainerId: OUTBOUND_CONTAINER_ID,
    now: NOW,
    ...overrides,
  });
}

function vercelMetadata(overrides: Partial<SessionMetadata> = {}, scopeId = 'worktree-a') {
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
      scopeId: 'worktree-a',
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
          'other-worktree'
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
      metadata({ workspace: { workspacePath: '/workspace/other' } }, 'worktree-other')
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
      metadata({ workspace: { workspacePath: '/workspace/other' } }, 'worktree-other')
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
        'worktree-sibling'
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
