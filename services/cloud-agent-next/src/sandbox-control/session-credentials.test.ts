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
    expect(Object.keys(policy.allow)).toEqual(['worker.example.com', '*']);
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
