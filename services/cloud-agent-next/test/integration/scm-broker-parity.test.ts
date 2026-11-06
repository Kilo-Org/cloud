import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import { GitTokenRPCEntrypoint } from '../../../git-token-service/src/index.js';
import { GitLabSessionCapabilityCodec } from '../../../git-token-service/src/gitlab-session-capability.js';
import type * as BitbucketResolver from '../../../git-token-service/src/bitbucket-runtime-token-resolver.js';
import { ContainersOutbound } from '../../src/sandbox-containers/containers-outbound.js';
import type { ByocVercelCredential } from '../../src/byoc/vercel-credential-resolver.js';
import { registerVercelScmBrokerRoute } from '../../src/scm-broker/vercel-route.js';
import type { HonoContext } from '../../src/hono-context.js';
import { admitVercelScmForward } from '../../src/scm-broker/vercel-admission.js';
import { createVercelJwksCache } from '../../src/scm-broker/vercel-jwks.js';
import type * as VercelIdentity from '../../src/scm-broker/vercel-identity.js';
import {
  prepareCredentialGrant,
  resolveSessionCredential,
} from '../../src/sandbox-control/session-credentials.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import type { Env, GitTokenService } from '../../src/types.js';
import type { ControlPlaneScmForwardAdmission } from '../../src/shared/control-plane-protocol.js';
import { FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN } from './helpers/fake-credentials.js';

const doubles = vi.hoisted(() => ({ bitbucketSubject: vi.fn() }));
vi.mock(
  '../../../git-token-service/src/bitbucket-runtime-token-resolver.js',
  async importOriginal => ({
    ...(await importOriginal<typeof BitbucketResolver>()),
    resolveBitbucketCapabilitySubject: doubles.bitbucketSubject,
  })
);
vi.mock('../../src/scm-broker/vercel-identity.js', async importOriginal => ({
  ...(await importOriginal<typeof VercelIdentity>()),
  verifiedVercelSandboxIdentityContract: {
    issuerForTeam: () => 'https://oidc.vercel.com/synthetic',
    sandboxIdForRef: (ref: { sessionId: string }) => ref.sessionId,
  },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const REPOSITORY = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL = '55555555-5555-4555-8555-555555555555';
const SANDBOX = 'sbx__scm_parity';
const SESSION = 'workspace_11111111-1111-4111-8111-111111111111';
const WORKER = 'https://worker.example';
const KEY = Buffer.alloc(32, 7).toString('base64');
const UPSTREAM_TOKEN = 'synthetic-upstream-secret';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function harness(
  purpose: 'gitlab' | 'bitbucket',
  provider: 'vercel' | 'cloudflare-containers',
  egressAllowlist?: string[],
  gitlabOrigin = 'https://gitlab.example'
) {
  const binding = `synthetic-${provider}-allocation`;
  const service = new GitTokenRPCEntrypoint(createExecutionContext(), {
    SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: KEY,
  } as ConstructorParameters<typeof GitTokenRPCEntrypoint>[1]);
  const identity = { accountId: 'synthetic-account', accountLogin: 'synthetic-login' };
  const current = { identity, credentialId: CREDENTIAL, version: 1, connected: true };
  Object.assign(service, {
    gitlabLookupService: {
      findGitLabIntegration: async () =>
        current.connected
          ? {
              success: true,
              integrationId: INTEGRATION,
              accountId: current.identity.accountId,
              accountLogin: current.identity.accountLogin,
              metadata: { auth_type: 'oauth', gitlab_instance_url: gitlabOrigin },
            }
          : { success: false, reason: 'not_connected' },
    },
    gitlabCredentialResolver: {
      resolveCredential: async () => ({
        status: 'available',
        token: UPSTREAM_TOKEN,
        source: { type: 'integration' },
        credentialId: current.credentialId,
        credentialVersion: current.version,
      }),
    },
  });
  const bitbucketSubject = {
    integrationId: INTEGRATION,
    workspaceUuid: WORKSPACE,
    workspaceSlug: 'acme',
    repositoryUuid: REPOSITORY,
    repositoryFullName: 'acme/widgets',
    token: UPSTREAM_TOKEN,
    oauthCredentialId: CREDENTIAL,
  };
  doubles.bitbucketSubject.mockImplementation(async () =>
    current.connected
      ? { success: true, subject: { ...bitbucketSubject, oauthCredentialId: current.credentialId } }
      : { success: false, reason: 'not_connected' }
  );
  const gitlabCodec = new GitLabSessionCapabilityCodec(KEY);
  const issueGitLab = vi.fn(async (params: { outboundContainerId: string }) => ({
    success: true,
    capability: gitlabCodec.issue({
      userId: 'synthetic-user',
      orgId: ORG,
      integrationId: INTEGRATION,
      outboundContainerId: params.outboundContainerId,
      instanceOrigin: gitlabOrigin,
      projectPath: 'acme/widgets',
      authType: 'oauth',
      identity,
      source: { type: 'integration', credentialId: CREDENTIAL, credentialVersion: 1 },
    }),
    instanceOrigin: gitlabOrigin,
    instanceHost: new URL(gitlabOrigin).host,
    projectPath: 'acme/widgets',
    integrationId: INTEGRATION,
    authType: 'oauth',
    identity,
    glabIsOAuth2: true,
  }));
  const broker = {
    issueGitLabSessionCapability: issueGitLab,
    issueBitbucketSessionCapability: service.issueBitbucketSessionCapability.bind(service),
    redeemGitLabSessionCapability: service.redeemGitLabSessionCapability.bind(service),
    redeemBitbucketSessionCapability: service.redeemBitbucketSessionCapability.bind(service),
  };
  const env = {
    GIT_TOKEN_SERVICE: broker as unknown as GitTokenService,
    WORKER_URL: WORKER,
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
    KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
    KILO_SESSION_INGEST_URL: 'https://ingest.kilosessions.ai',
  } as Env;
  const prepared = await prepareCredentialGrant({
    env,
    provider,
    sandboxId: SANDBOX,
    outboundContainerId: binding,
    containmentEnabled: true,
    sessionId: SESSION,
    scopeId: SESSION,
    directory: '/workspace/parity',
    payload: {},
    source: {
      userId: 'synthetic-user',
      orgId: ORG,
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      repository:
        purpose === 'gitlab'
          ? { type: 'gitlab', url: `${gitlabOrigin}/acme/widgets.git` }
          : {
              type: 'bitbucket',
              url: 'https://bitbucket.org/acme/widgets.git',
              workspaceUuid: WORKSPACE,
              repositoryUuid: REPOSITORY,
              bitbucketIntegrationId: INTEGRATION,
            },
    },
  });
  let { grant } = prepared;
  if (!grant.scm?.alias || !grant.scm.capability) throw new Error('missing bound SCM fixture');
  const alias = grant.scm.alias;
  expect(JSON.stringify(prepared.payload)).toContain(alias);
  expect(JSON.stringify(prepared.payload)).not.toContain(grant.scm.capability.credential);
  expect(JSON.stringify(prepared)).not.toContain(UPSTREAM_TOKEN);
  const keys = createVercelJwksCache({
    fetch: async () =>
      Response.json({
        keys: [
          {
            ...signing.publicKey.export({ format: 'jwk' }),
            kid: 'synthetic',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      }),
  });
  const resolve = async (input: {
    credential: string;
    outboundContainerId: string;
    url: string;
    method: string;
  }) => {
    const result = await resolveSessionCredential({ env, grant, ...input });
    if (result) grant = result.grant;
    return result;
  };
  Object.assign(env, {
    SANDBOX_CONTROL: {
      getByName: () => ({
        resolveCredential: async (input: Parameters<typeof resolve>[0]) => {
          const result = await resolve(input);
          return result ? { credential: result.credential } : null;
        },
      }),
    },
  });
  const native = new ContainersOutbound(
    Object.assign(createExecutionContext(), {
      props: { containerId: binding, ...(egressAllowlist ? { egressAllowlist } : {}) },
    }),
    env
  );
  const upstreamRequests: Array<{ url: string; method: string; size: number }> = [];
  const upstream = vi.fn(async (request: Request) => {
    expect(request.redirect).toBe('manual');
    const authorization = request.headers.get('authorization');
    expect(
      authorization === `Bearer ${UPSTREAM_TOKEN}` ||
        authorization ===
          `Basic ${Buffer.from(`${purpose === 'gitlab' ? 'oauth2' : 'x-token-auth'}:${UPSTREAM_TOKEN}`).toString('base64')}`
    ).toBe(true);
    expect(request.headers.get('vercel-sandbox-oidc-token')).toBeNull();
    const bytes = await request.arrayBuffer();
    upstreamRequests.push({ url: request.url, method: request.method, size: bytes.byteLength });
    return new Response(null, {
      status: 307,
      headers: { Location: 'https://off-list.example/redirect' },
    });
  });
  vi.stubGlobal('fetch', upstream);
  const app = new Hono<HonoContext>();
  registerVercelScmBrokerRoute(app);
  async function send(url: string, method = 'GET', body?: Uint8Array, credential = alias) {
    const authorization = `Bearer ${credential}`;
    const init = { method, ...(body ? { body } : {}), headers: { Authorization: authorization } };
    if (provider === 'cloudflare-containers') return native.fetch(new Request(url, init));
    const target = new URL(url);
    const request = new Request(`${WORKER}/scm/vercel/${SANDBOX}`, {
      ...init,
      headers: {
        Authorization: authorization,
        'vercel-forwarded-host': target.hostname,
        'vercel-forwarded-scheme': target.protocol.slice(0, -1),
        'vercel-forwarded-port': target.port || '443',
        'vercel-forwarded-path': target.pathname + target.search,
        'vercel-sandbox-oidc-token': jwt.sign(
          {
            iss: 'https://oidc.vercel.com/synthetic',
            aud: `${WORKER}/scm/vercel/${SANDBOX}`,
            team_id: 'team-synthetic',
            project_id: 'project-synthetic',
            sandbox_id: 'provider-synthetic',
            exp: Math.floor(Date.now() / 1000) + 600,
          },
          signing.privateKey,
          { algorithm: 'RS256', keyid: 'synthetic' }
        ),
      },
    });
    const admitScmForward = (input: ControlPlaneScmForwardAdmission) =>
      admitVercelScmForward(input, {
        env,
        contract: {
          issuerForTeam: () => 'https://oidc.vercel.com/synthetic',
          sandboxIdForRef: ref => ref.sessionId,
        },
        serial: async operation => operation(),
        readContext: async () => ({
          sandboxId: SANDBOX,
          ownerId: 'synthetic-user',
          provider: 'vercel',
          containmentEnabled: true,
          allocation: {
            kind: 'connected',
            allocationId: 'allocation-synthetic',
            providerRef: JSON.stringify({
              sandboxName: 'physical-synthetic',
              sessionId: 'provider-synthetic',
            }),
          },
          physicalName: 'physical-synthetic',
          outboundContainerId: binding,
          byoc: { organizationId: ORG, credentialId: CREDENTIAL },
          locator: {
            teamId: 'team-synthetic',
            projectId: 'project-synthetic',
            snapshotId: 'snapshot-synthetic',
            runtimeBuildId: 'runtime-synthetic',
            runtime: 'node24',
          },
          grants: [grant],
          liveSessionIds: [SESSION],
        }),
        fetchCredential: async () =>
          ({
            organizationId: ORG,
            credentialId: CREDENTIAL,
            setupStatus: 'ready',
            teamId: 'team-synthetic',
            projectId: 'project-synthetic',
            teamSlug: 'synthetic',
          }) as ByocVercelCredential,
        keys,
        resolve: input => resolve(input),
        persist: value => {
          grant = value;
        },
      });
    return app.fetch(request, {
      ...env,
      SANDBOX_CONTROL: {
        getByName: (name: string) => {
          expect(name).toBe(SANDBOX);
          return { admitScmForward };
        },
      },
    } as unknown as Env);
  }
  return { send, upstreamRequests, current };
}

describe.each([
  { name: 'Vercel', provider: 'vercel' as const, egressAllowlist: undefined },
  {
    name: 'native unrestricted',
    provider: 'cloudflare-containers' as const,
    egressAllowlist: undefined,
  },
  {
    name: 'native restricted',
    provider: 'cloudflare-containers' as const,
    egressAllowlist: ['gitlab.example', 'bitbucket.org', 'api.bitbucket.org'],
  },
])(
  '$name shared broker with real redemption and synthetic credential stores',
  ({ provider, egressAllowlist }) => {
    it.each([
      'https://gitlab.example',
      ...(egressAllowlist ? [] : ['https://gitlab.example:8443']),
    ])('keeps GitLab project REST, Git and LFS policy through the adapter on %s', async origin => {
      const f = await harness('gitlab', provider, egressAllowlist, origin);
      for (const [method, path] of [
        ['GET', '/api/v4/projects/acme%2Fwidgets/repository/archive.tar.gz'],
        ['POST', '/api/v4/projects/acme%2Fwidgets/merge_requests'],
        ['PATCH', '/api/v4/projects/acme%2Fwidgets/issues/1'],
        ['GET', '/acme/widgets.git/info/refs?service=git-upload-pack'],
        ['POST', '/acme/widgets.git/git-upload-pack'],
        ['POST', '/acme/widgets.git/git-receive-pack'],
        ['POST', '/acme/widgets.git/info/lfs/objects/batch'],
        ['POST', '/acme/widgets.git/info/lfs/locks'],
        ['POST', '/acme/widgets.git/info/lfs/locks/verify'],
        ['POST', '/acme/widgets.git/info/lfs/locks/1/unlock'],
      ]) {
        const before = f.upstreamRequests.length;
        expect((await f.send(`${origin}${path}`, method)).status).toBe(307);
        expect(f.upstreamRequests.length).toBe(before + 1);
      }
      for (const path of [
        '/api/v4/user',
        '/api/graphql',
        '/api/v4/projects/other%2Frepo/issues',
        '/api/v4/projects/42/issues',
        '/api/v4/projects/%ZZ/issues',
        '/api/v4/projects/acme%252Fwidgets/issues',
        '/acme/other.git/git-receive-pack',
        '/acme/widgets.git/archive/main.tar.gz',
        '/acme/widgets.git/%252e%252e%252fother.git/git-upload-pack',
      ]) {
        const before = f.upstreamRequests.length;
        expect((await f.send(`${origin}${path}`)).status).toBe(502);
        expect(f.upstreamRequests.length).toBe(before);
      }
      const body = new Uint8Array(2 * 1024 * 1024 + 17).fill(97);
      expect(
        (await f.send(`${origin}/acme/widgets.git/git-receive-pack`, 'POST', body)).status
      ).toBe(307);
      expect(f.upstreamRequests.at(-1)?.size).toBe(body.byteLength);
      for (const wrongOrigin of [
        origin.endsWith(':8443') ? 'https://gitlab.example' : 'https://gitlab.example:8443',
        'https://gitlab.example:9443',
      ]) {
        const before = f.upstreamRequests.length;
        expect((await f.send(`${wrongOrigin}/acme/widgets.git/info/refs`)).status).toBe(
          provider === 'vercel' || egressAllowlist ? 403 : 502
        );
        expect(f.upstreamRequests.length).toBe(before);
      }
      f.current.identity = { accountId: 'replaced-account', accountLogin: 'synthetic-login' };
      expect((await f.send(`${origin}/api/v4/projects/acme%2Fwidgets/issues`)).status).toBe(502);
      f.current.identity = { accountId: 'synthetic-account', accountLogin: 'synthetic-login' };
      f.current.version = 2;
      expect((await f.send(`${origin}/api/v4/projects/acme%2Fwidgets/issues`)).status).toBe(502);
    });

    if (egressAllowlist) {
      it('keeps the native restricted-egress denial of non-default GitLab ports', async () => {
        const f = await harness('gitlab', provider, egressAllowlist, 'https://gitlab.example:8443');
        expect(
          (await f.send('https://gitlab.example:8443/acme/widgets.git/info/refs')).status
        ).toBe(403);
        expect(f.upstreamRequests).toEqual([]);
      });
    }

    it('keeps both Bitbucket hosts, traversal checks, and credential identity fences', async () => {
      const f = await harness('bitbucket', provider, egressAllowlist);
      for (const url of [
        'https://bitbucket.org/acme/widgets.git/info/refs?service=git-upload-pack',
        'https://bitbucket.org/acme/widgets.git/git-receive-pack',
        'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests',
        'https://api.bitbucket.org/2.0/repositories/acme/widgets/refs/branches/task',
      ]) {
        const before = f.upstreamRequests.length;
        expect((await f.send(url, 'POST')).status).toBe(307);
        expect(f.upstreamRequests.length).toBe(before + 1);
      }
      for (const url of [
        'https://api.bitbucket.org/2.0/user',
        'https://api.bitbucket.org/2.0/repositories/acme/other/pullrequests',
        'https://bitbucket.org/acme/other.git/git-upload-pack',
        'https://bitbucket.org/acme/widgets.git/%252e%252e%252fother.git/git-upload-pack',
        'https://api.bitbucket.org/2.0/repositories/acme%2Fwidgets/pullrequests',
      ]) {
        const before = f.upstreamRequests.length;
        expect((await f.send(url)).status).toBe(502);
        expect(f.upstreamRequests.length).toBe(before);
      }
      const before = f.upstreamRequests.length;
      f.current.credentialId = '66666666-6666-4666-8666-666666666666';
      expect(
        (await f.send('https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests'))
          .status
      ).toBe(502);
      expect(f.upstreamRequests.length).toBe(before);
      f.current.credentialId = CREDENTIAL;
      f.current.connected = false;
      expect((await f.send('https://bitbucket.org/acme/widgets.git/git-upload-pack')).status).toBe(
        502
      );
      expect(f.upstreamRequests.length).toBe(before);
      f.current.connected = true;
      expect(
        (
          await f.send(
            'https://bitbucket.org/acme/widgets.git/git-upload-pack',
            'GET',
            undefined,
            createControlPlaneCredential('sbx_foreign', 'bitbucket')
          )
        ).status
      ).toBe(provider === 'vercel' ? 403 : 502);
      expect(f.upstreamRequests.length).toBe(before);
    });
  }
);
