import { describe, expect, it, vi } from 'vitest';
import {
  buildControlNetworkPolicy,
  prepareCredentialGrant,
  sessionCredentialsPayloadFromGrant,
  persistedSessionCredentialGrantSchema,
  sessionCredentialGrantSchema,
  resolveSessionCredential,
  type CredentialGrantPreparation,
} from './session-credentials.js';
import { createControlPlaneCredential } from './managed-credential.js';
import { createGrantDiagnostic } from './grant-diagnostic.js';

const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const facade = 'https://worker.example.com';

function localPreparation(): CredentialGrantPreparation {
  return {
    env: {
      WORKER_URL: facade,
      KILOCODE_BACKEND_BASE_URL: 'http://localhost:4300',
      KILO_OPENROUTER_BASE: 'http://localhost:4300/api/openrouter',
      KILO_SESSION_INGEST_URL: 'http://localhost:10100',
    } as CredentialGrantPreparation['env'],
    source: {
      userId: 'user-1',
      kiloSessionId,
      kiloToken: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln',
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
      scopeId: sessionId,
    },
    sessionId,
    sandboxId: 'ses-abcdef',
    provider: 'vercel',
    outboundContainerId: 'allocation-binding',
    containmentEnabled: true,
    directory: '/workspace/test',
    scopeId: sessionId,
    payload: {},
    now: 1_000,
  };
}

describe('contained runtime organization projection', () => {
  it.each(['cloudflare', 'cloudflare-containers', 'vercel'] as const)(
    'projects the session org only through kilo for %s grants',
    async provider => {
      const input = localPreparation();
      input.provider = provider;
      input.source.orgId = 'org-session';

      const { grant, payload } = await prepareCredentialGrant(input);

      expect(grant.orgId).toBe('org-session');
      expect(payload.kilo.organizationId).toBe(grant.orgId);
      // The wrapper derives the runtime env from kilo.organizationId.
      expect(payload.env).not.toHaveProperty('KILOCODE_ORGANIZATION_ID');
    }
  );

  it('does not add an organization to a personal grant', async () => {
    const { grant, payload } = await prepareCredentialGrant(localPreparation());

    expect(grant).not.toHaveProperty('orgId');
    expect(payload.kilo).not.toHaveProperty('organizationId');
    expect(payload.env).not.toHaveProperty('KILOCODE_ORGANIZATION_ID');
  });
});

describe('Vercel credentials with private control-plane upstreams', () => {
  it('keeps loopback upstreams behind the HTTPS runtime facade', async () => {
    const input = localPreparation();
    const { grant } = await prepareCredentialGrant(input);
    const proxy = grant.kilo.runtimeProxy;
    if (!proxy) throw new Error('Missing runtime proxy');
    proxy.members.push({ sessionId, kiloSessionId, handle: 'test-session-handle' });

    const payload = sessionCredentialsPayloadFromGrant(grant, sessionId);
    expect(payload.proxy?.targets).toEqual({
      backendBaseUrl: facade,
      providerBaseUrl: facade,
      sessionIngestBaseUrl: facade,
    });
    expect(JSON.stringify(payload)).not.toContain('localhost');
    expect(JSON.stringify(payload)).not.toContain(input.source.kiloToken);
    const policy = buildControlNetworkPolicy([grant]);
    expect(policy.allow['worker.example.com'].length).toBeGreaterThan(0);
    expect(Object.keys(policy.allow)).toEqual([
      'session-sync.kiloapps.io',
      'worker.example.com',
      '*',
    ]);
    expect(JSON.stringify(policy)).not.toContain('localhost');
  });

  it('rejects a public HTTP upstream', async () => {
    const input = localPreparation();
    input.env.KILOCODE_BACKEND_BASE_URL = 'http://backend.example.com';
    await expect(prepareCredentialGrant(input)).rejects.toThrow();
  });

  it('rejects an HTTP sandbox-facing facade', async () => {
    const input = localPreparation();
    input.env.WORKER_URL = 'http://worker.example.com';
    await expect(prepareCredentialGrant(input)).rejects.toThrow();
  });
});

async function boundVercelGrant() {
  const { grant } = await prepareCredentialGrant(localPreparation());
  grant.repository = {
    type: 'github',
    repo: 'acme/widgets',
    authentication: 'managed',
    allowUserAuthorization: true,
  };
  grant.outboundContainerId = 'allocation-binding';
  grant.scm = {
    purpose: 'github',
    alias: createControlPlaneCredential(grant.sandboxId, 'github'),
    gitUrl: 'https://github.com/acme/widgets.git',
    githubAppType: 'standard',
    capability: {
      credential: 'kgh2.synthetic',
      outboundContainerId: 'allocation-binding',
      issuedAt: 1000,
      expiresAt: 2000,
    },
  };
  return grant;
}

describe('prepared Vercel capability grants', () => {
  it('accepts bound capabilities and rejects native-token rows', async () => {
    const grant = await boundVercelGrant();
    expect(sessionCredentialGrantSchema.safeParse(grant).success).toBe(true);
    const native = structuredClone(grant);
    delete native.scm!.capability;
    native.scm!.nativeToken = 'synthetic-native-token';
    expect(persistedSessionCredentialGrantSchema.safeParse(native).success).toBe(false);
  });

  it.each([
    'mixed',
    'wrong-prefix',
    'absent-binding',
    'wrong-binding',
    'invalid-alias',
    'explicit-capability',
  ])('rejects invalid persisted grants: %s', async kind => {
    const grant = await boundVercelGrant();
    if (kind === 'mixed') grant.scm!.nativeToken = 'synthetic-native-token';
    if (kind === 'wrong-prefix') grant.scm!.capability!.credential = 'kgl2.synthetic';
    if (kind === 'absent-binding') delete grant.outboundContainerId;
    if (kind === 'wrong-binding') grant.scm!.capability!.outboundContainerId = 'foreign';
    if (kind === 'invalid-alias')
      grant.scm!.alias = createControlPlaneCredential('sbx-foreign', 'github');
    if (kind === 'explicit-capability' && grant.repository?.type === 'github')
      grant.repository.authentication = 'explicit';
    expect(persistedSessionCredentialGrantSchema.safeParse(grant).success).toBe(false);
  });

  it('keeps cleanup-only rows readable but rejects their live use', async () => {
    const grant = await boundVercelGrant();
    delete grant.kilo.runtimeProxy;
    expect(persistedSessionCredentialGrantSchema.safeParse(grant).success).toBe(true);
    expect(sessionCredentialGrantSchema.safeParse(grant).success).toBe(false);
  });

  it.each(['cloudflare', 'cloudflare-containers', 'vercel'] as const)(
    'uses configured GitHub fallback for %s issuance and renewal',
    async provider => {
      for (const allowUserAuthorization of [true, false]) {
        const input = localPreparation();
        input.provider = provider;
        input.source.createdOnPlatform = allowUserAuthorization ? 'cloud-agent-web' : 'automation';
        input.source.repository = {
          type: 'github',
          repo: 'acme/widgets',
        };
        const issue = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
          success: true,
          capability: 'kgh2.refreshed',
          source: allowUserAuthorization ? 'user' : 'installation',
          installationId: '123',
          appType: 'standard',
          gitAuthor: { name: 'Kilo', email: 'bot@example.com' },
        }));
        Object.assign(input.env, { GIT_TOKEN_SERVICE: { issueGitHubSessionCapability: issue } });
        const { grant } = await prepareCredentialGrant(input);
        expect(issue).toHaveBeenLastCalledWith({
          userId: 'user-1',
          outboundContainerId: 'allocation-binding',
          githubRepo: 'acme/widgets',
          accessPurpose: 'workflow',
          allowUserAuthorization,
        });
        const resolved = await resolveSessionCredential({
          env: input.env,
          grant,
          credential: grant.scm!.alias!,
          url: 'https://api.github.com/graphql',
          method: 'POST',
          outboundContainerId: 'allocation-binding',
          now: grant.scm!.capability!.expiresAt + 1,
        });
        expect(resolved?.credential).toBe('kgh2.refreshed');
        expect(issue).toHaveBeenCalledTimes(2);
        expect(issue.mock.calls[0]).toEqual(issue.mock.calls[1]);
        expect(resolved?.grant.repository).toEqual(grant.repository);
        expect(resolved?.grant.scm?.alias).toBe(grant.scm?.alias);
        issue.mockResolvedValueOnce({ success: false, reason: 'user_authorization_denied' });
        expect(
          await resolveSessionCredential({
            env: input.env,
            grant,
            credential: grant.scm!.alias!,
            url: 'https://github.com/acme/widgets.git',
            method: 'GET',
            outboundContainerId: 'allocation-binding',
            now: grant.scm!.capability!.expiresAt + 1,
          })
        ).toBeNull();
      }
    }
  );

  it('composes SCM forwarding without exposing the bound capability', async () => {
    const grant = await boundVercelGrant();
    grant.preparedAt = Date.now();
    grant.expiresAt = grant.preparedAt + 60_000;
    const policy = buildControlNetworkPolicy([grant], undefined, localPreparation().env);
    expect(policy.allow['github.com']).toEqual([
      { forwardURL: `${facade}/scm/vercel/${grant.sandboxId}` },
    ]);
    expect(JSON.stringify(policy)).not.toContain(grant.scm!.capability!.credential);
    expect(JSON.stringify(policy)).not.toContain(grant.scm!.alias!);
  });
});

describe('mandatory credential containment', () => {
  it('rejects direct credential preparation', async () => {
    const input = localPreparation();
    input.containmentEnabled = false;
    await expect(prepareCredentialGrant(input)).rejects.toThrow();
  });

  it('keeps legacy direct grants readable but rejects execution and renewal', async () => {
    const input = localPreparation();
    const { grant } = await prepareCredentialGrant(input);
    grant.containmentEnabled = false;
    expect(persistedSessionCredentialGrantSchema.safeParse(grant).success).toBe(true);
    expect(sessionCredentialGrantSchema.safeParse(grant).success).toBe(false);
    expect(() => sessionCredentialsPayloadFromGrant(grant, sessionId)).toThrow();
    await expect(prepareCredentialGrant({ ...input, existing: grant })).rejects.toThrow();
  });
});

describe('hosted multi-repository grants', () => {
  const integrationId = '123e4567-e89b-42d3-a456-426614174022';
  const primary = { id: 101, fullName: 'acme/widgets' };
  const additional = { id: 102, fullName: 'acme/docs' };
  const primaryScope = {
    userId: 'user-1',
    organizationId: 'org-session',
    integrationId,
    primaryRepo: primary.fullName,
    additionalRepositoryIds: [additional.id],
  };

  function hostedPreparation() {
    const input = localPreparation();
    input.directory = '/workspace';
    input.source.orgId = primaryScope.organizationId;
    input.source.repository = {
      type: 'github',
      repo: primary.fullName,
      hostedRepositoryId: primary.id,
      githubIntegrationId: integrationId,
      githubAccessPurpose: 'workflow',
      allowUserAuthorization: false,
    };
    input.source.additionalHostedGitHubRepositories = [additional];
    const resolve = vi.fn().mockResolvedValue({ success: true, primary, additional: [additional] });
    const issue = vi.fn(async ({ githubRepo }: { githubRepo: string }) => ({
      success: true,
      capability: `kgh2.${githubRepo}`,
      source: 'installation',
      installationId: '123',
      appType: 'standard',
      gitAuthor: { name: 'Kilo', email: 'bot@example.com' },
    }));
    Object.assign(input.env, {
      GIT_TOKEN_SERVICE: {
        resolveHostedWorkspaceGitHubRepositories: resolve,
        issueGitHubSessionCapability: issue,
      },
    });
    return { input, resolve, issue };
  }

  it('checks the whole stable set on preparation and does not pass identity into runtime credentials', async () => {
    const { input, resolve, issue } = hostedPreparation();
    const { grant } = await prepareCredentialGrant(input);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(primaryScope);
    expect(issue.mock.calls.map(([request]) => request)).toEqual(
      [primary, additional].map(repository => ({
        userId: primaryScope.userId,
        orgId: primaryScope.organizationId,
        outboundContainerId: 'allocation-binding',
        githubRepo: repository.fullName,
        accessPurpose: 'workflow',
        allowUserAuthorization: false,
        expectedIntegrationId: integrationId,
      }))
    );
    const persisted = persistedSessionCredentialGrantSchema.parse(
      JSON.parse(JSON.stringify(grant))
    );
    expect(persisted.repository).toMatchObject({ hostedRepositoryId: primary.id });
    expect(persisted.additionalRepositories?.[0]?.repository).toMatchObject({
      hostedRepositoryId: additional.id,
    });
    const payload = sessionCredentialsPayloadFromGrant(grant, sessionId);
    expect(payload.git?.token).toBe(persisted.additionalRepositories?.[0]?.scm.alias);
    expect(JSON.stringify(payload)).not.toContain(integrationId);
    expect(JSON.stringify(payload)).not.toContain('hostedRepositoryId');
    expect(JSON.stringify(payload)).not.toContain('hostedRepositoryVerifiedAt');
    expect(JSON.stringify(payload)).not.toContain('kgh2.');
  });

  it('denies renamed members on recovery even when the warm authorization cache is fresh', async () => {
    const { input, resolve, issue } = hostedPreparation();
    const { grant } = await prepareCredentialGrant(input);
    issue.mockClear();
    resolve.mockResolvedValueOnce({
      success: true,
      primary,
      additional: [{ ...additional, fullName: 'acme/renamed' }],
    });
    await expect(prepareCredentialGrant({ ...input, existing: grant })).rejects.toMatchObject({
      repoFullName: additional.fullName,
      cause: new Error('repository_unavailable'),
    });
    expect(resolve).toHaveBeenLastCalledWith(primaryScope);
    expect(issue).not.toHaveBeenCalled();
  });

  it('reuses a recent positive check only for the selected repository and rejects a replacement ID after expiry', async () => {
    const { input, resolve, issue } = hostedPreparation();
    const { grant } = await prepareCredentialGrant(input);
    const persisted = persistedSessionCredentialGrantSchema.parse(
      JSON.parse(JSON.stringify(grant))
    );
    issue.mockClear();
    resolve.mockClear();
    const request = {
      env: input.env,
      grant: persisted,
      credential: grant.scm?.alias ?? '',
      url: `https://github.com/${additional.fullName}.git/info/refs?service=git-upload-pack`,
      method: 'GET',
      outboundContainerId: 'allocation-binding',
    };
    const warm = await resolveSessionCredential({ ...request, now: 30_999 });
    expect(warm).toMatchObject({
      credential: `kgh2.${additional.fullName}`,
    });
    if (!warm) throw new Error('Missing warm grant');
    expect(resolve).not.toHaveBeenCalled();

    resolve.mockResolvedValueOnce({ success: true, primary: additional, additional: [] });
    const renewed = await resolveSessionCredential({ ...request, grant: warm.grant, now: 31_000 });
    expect(renewed).toMatchObject({ credential: `kgh2.${additional.fullName}` });
    if (!renewed) throw new Error('Missing renewed grant');
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      ...primaryScope,
      primaryRepo: additional.fullName,
      additionalRepositoryIds: [],
    });
    await expect(
      resolveSessionCredential({ ...request, grant: renewed.grant, now: 31_001 })
    ).resolves.toMatchObject({ credential: `kgh2.${additional.fullName}` });
    expect(resolve).toHaveBeenCalledTimes(1);

    resolve.mockResolvedValueOnce({ success: false, reason: 'access_denied' });
    await expect(
      resolveSessionCredential({
        ...request,
        grant: renewed.grant,
        url: `https://github.com/${primary.fullName}.git/info/refs?service=git-upload-pack`,
        now: 31_001,
      })
    ).resolves.toBeNull();
    expect(resolve).toHaveBeenLastCalledWith({ ...primaryScope, additionalRepositoryIds: [] });

    resolve.mockResolvedValueOnce({
      success: true,
      primary: { ...additional, id: additional.id + 100 },
      additional: [],
    });
    await expect(
      resolveSessionCredential({ ...request, grant: renewed.grant, now: 61_000 })
    ).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(issue).not.toHaveBeenCalled();
  });

  it('fails closed when the hosted authorization RPC is missing', async () => {
    const { input, issue } = hostedPreparation();
    Object.assign(input.env, { GIT_TOKEN_SERVICE: { issueGitHubSessionCapability: issue } });
    await expect(prepareCredentialGrant(input)).rejects.toMatchObject({
      cause: new Error('temporarily_unavailable'),
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it('reauthorizes before issuing a capability for a different container even inside the cache window', async () => {
    const { input, resolve, issue } = hostedPreparation();
    const { grant } = await prepareCredentialGrant(input);
    const outboundContainerId = 'new-allocation-binding';
    resolve.mockClear();
    issue.mockClear();
    resolve.mockResolvedValueOnce({ success: false, reason: 'access_denied' });
    await expect(
      resolveSessionCredential({
        env: input.env,
        grant: { ...grant, outboundContainerId },
        credential: grant.scm?.alias ?? '',
        url: `https://github.com/${additional.fullName}.git/info/refs?service=git-upload-pack`,
        method: 'GET',
        outboundContainerId,
        now: 1_001,
      })
    ).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      ...primaryScope,
      primaryRepo: additional.fullName,
      additionalRepositoryIds: [],
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it('retries a temporary authorization error but fails fast on a definitive denial', async () => {
    const { input, resolve, issue } = hostedPreparation();
    resolve.mockResolvedValueOnce({ success: false, reason: 'temporarily_unavailable' });
    await expect(prepareCredentialGrant(input)).resolves.toMatchObject({
      grant: { additionalRepositories: [expect.anything()] },
    });
    expect(resolve.mock.calls).toEqual([[primaryScope], [primaryScope]]);
    resolve.mockClear();
    issue.mockClear();
    resolve.mockResolvedValueOnce({ success: false, reason: 'access_denied' });
    await expect(prepareCredentialGrant(input)).rejects.toMatchObject({
      cause: new Error('access_denied'),
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(primaryScope);
    expect(issue).not.toHaveBeenCalled();
  });

  it('does not start a duplicate broker call when authorization reaches its deadline', async () => {
    vi.useFakeTimers();
    try {
      const { input, resolve, issue } = hostedPreparation();
      resolve.mockImplementation(() => new Promise(() => {}));
      const result = expect(prepareCredentialGrant(input)).rejects.toMatchObject({
        cause: new Error('temporarily_unavailable'),
      });
      await vi.advanceTimersByTimeAsync(23_000);
      await result;
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(issue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['access_denied', 'repository_unavailable'] as const)(
    'preserves the hosted authorization failure reason %s in diagnostics',
    async reason => {
      const { input, resolve } = hostedPreparation();
      const diagnostic = createGrantDiagnostic();
      resolve.mockResolvedValueOnce({ success: false, reason });
      await expect(prepareCredentialGrant(input, diagnostic)).rejects.toThrow();
      expect(diagnostic.snapshot()).toMatchObject({
        grantPhase: 'broker_authorization',
        grantFailureReason: reason,
      });
    }
  );

  it('rejects a non-installation capability even after confirming access', async () => {
    const { input, issue } = hostedPreparation();
    issue.mockImplementationOnce(async () => ({
      success: true,
      capability: 'kgh2.user',
      source: 'user',
      installationId: '123',
      appType: 'standard',
      gitAuthor: { name: 'Kilo', email: 'bot@example.com' },
    }));
    await expect(prepareCredentialGrant(input)).rejects.toThrow(
      'SCM capability issuance is unavailable'
    );
    expect(issue).toHaveBeenCalledTimes(1);
  });
});

describe.each(['aws', 'aws-ecs'] as const)('%s managed SCM certificate scope', provider => {
  it('rejects a custom additional repository before issuing any capability', async () => {
    const input = localPreparation();
    input.provider = provider;
    input.source.repository = { type: 'github', repo: 'acme/widgets' };
    input.environment = {
      repositories: [
        {
          identity: { platform: 'github', repoFullName: 'acme/widgets' },
          repoFullName: 'acme/widgets',
          leaf: 'widgets',
        },
        {
          identity: {
            platform: 'gitlab',
            cloneUrl: 'https://custom.gitlab.example/group/repo.git',
          },
          repoFullName: 'group/repo',
          leaf: 'repo',
        },
      ],
    };
    const issue = vi.fn();
    input.env.GIT_TOKEN_SERVICE = {
      issueGitHubSessionCapability: issue,
    } as unknown as typeof input.env.GIT_TOKEN_SERVICE;
    await expect(prepareCredentialGrant(input)).rejects.toMatchObject({
      reason: 'byoc_aws_scm_host_unsupported',
    });
    expect(issue).not.toHaveBeenCalled();
  });
  it('rejects a custom managed GitLab host before credential issuance', async () => {
    const input = localPreparation();
    input.provider = provider;
    input.source.repository = {
      type: 'gitlab',
      url: 'https://custom.gitlab.example/acme/repo.git',
    };
    const issue = vi.fn();
    input.env.GIT_TOKEN_SERVICE = {
      issueGitLabSessionCapability: issue,
    } as unknown as typeof input.env.GIT_TOKEN_SERVICE;
    await expect(prepareCredentialGrant(input)).rejects.toMatchObject({
      reason: 'byoc_aws_scm_host_unsupported',
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
