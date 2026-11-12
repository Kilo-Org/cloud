import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { authMiddleware } from '../../src/middleware/auth.js';
import {
  env,
  reset,
  runInDurableObject,
  evictAllDurableObjects,
  createExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { eq } from 'drizzle-orm';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import type {
  WorkspaceGitHubRepositoryAccess,
  WorkspaceRepositoryPolicyLookup,
  WorkspaceRepositoryScope,
} from '@kilocode/worker-utils/workspace-repository-access';
import type {
  SandboxControlV2,
  StoredProviderPin,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation,
  routes as routesTable,
  workspaceRepositoryAccess,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import {
  readRepositoryAccess,
  writeRepositoryAccess,
} from '../../src/control-plane/sandbox/repository-access.js';
import {
  writeScopeGrant,
  listScopeGrants,
  retireScopeGrants,
} from '../../src/control-plane/sandbox/scope-grants.js';
import { writeRoute } from '../../src/control-plane/sandbox/routes.js';
import {
  prepareCredentialGrant,
  resolveSessionCredential,
  persistedSessionCredentialGrantSchema,
} from '../../src/sandbox-control/session-credentials.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import {
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINERS_NAMESPACE,
  fakeOutboundContainerId,
} from './helpers/fake-credentials.js';
import { repositoryAccessFromTrustedGrant } from '../../src/control-plane/sandbox/repository-access-initialization.js';
import { GitHubSessionCapabilityCodec } from '../../../git-token-service/src/github-session-capability.js';
import { GitTokenRPCEntrypoint } from '../../../git-token-service/src/index.js';
import { admitVercelScmForward } from '../../src/scm-broker/vercel-admission.js';
import { handleVercelScmForward } from '../../src/scm-broker/vercel-route.js';
import { createVercelJwksCache } from '../../src/scm-broker/vercel-jwks.js';
import {
  contract,
  token,
  credential,
  expected,
  physicalName,
  keysFetch,
} from '../../src/scm-broker/test-fixtures.js';
import { RepositoryPolicyReader } from '../../src/scm-broker/repository-policy-reader.js';
import { forwardResolvedScmCapability } from '../../src/scm-broker/managed-forwarding.js';
import { Buffer } from 'node:buffer';
import { router } from '../../src/router/auth.js';
import { createRepositoryAccessHandlers } from '../../src/router/handlers/repository-access.js';
import type { TRPCContext, GitTokenService, Env } from '../../src/types.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';

vi.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  verifyKiloBearerAgainstCurrentPepper: async (input: {
    token: string;
    nextAuthSecret: string;
  }) => {
    try {
      const { verifyKiloTokenForPolicy } = await import('@kilocode/worker-utils/kilo-token-policy');
      const verified = await verifyKiloTokenForPolicy(input.token, input.nextAuthSecret, {
        audience: 'cloud-agent-next',
        mode: 'required',
      });
      return { userId: verified.userId };
    } catch {
      return null;
    }
  },
}));
const membership = vi.hoisted(() => ({ current: true }));
vi.mock('../../src/session-access.js', () => ({
  requireCurrentSessionAccess: async ({ kiloUserId }: { kiloUserId: string }) => {
    if (kiloUserId !== 'oauth/owner' || !membership.current)
      throw new Error('Session access denied');
    return { organizationId: null, kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' };
  },
}));

const OWNER = 'oauth/owner';
const SESSION = 'workspace_11111111-1111-4111-8111-111111111111';
const SIBLING = 'workspace_22222222-2222-4222-8222-222222222222';
const SCOPE = 'worktree_11111111-1111-4111-8111-111111111111';
const SECRET = 'synthetic-repository-control-secret';
const repositories = (
  id: number,
  mode: 'read' | 'contribute' = 'contribute'
): WorkspaceGitHubRepositoryAccess => ({
  repositoryId: id,
  nodeId: `R_${id}`,
  owner: id === 303 ? 'second-owner' : 'acme',
  name: id === 101 ? 'a' : id === 202 ? 'b' : 'c',
  mode,
  source: 'environment',
  approvedBy: OWNER,
  approvedAt: 1,
  integrationId:
    id === 303 ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
  identity: {
    source: 'installation',
    providerSubjectId: id === 303 ? '456' : '123',
    appType: 'standard',
  },
});
const author = { name: 'Kilo[bot]', email: 'bot@example.test' };
const sandboxNamespace = (
  env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> }
).SANDBOX_CONTROL;

async function fixture(
  scopeId = SCOPE,
  provider: 'cloudflare-containers' | 'vercel' = 'cloudflare-containers'
) {
  membership.current = true;
  const sandboxId = `sbx-${crypto.randomUUID().replaceAll('-', '')}${'a'.repeat(16)}`;
  const sandbox = sandboxNamespace.getByName(sandboxId);
  const outboundContainerId =
    provider === 'vercel' ? sandboxId : fakeOutboundContainerId(sandboxId);
  const tokens = {
    repositoryAccessProtocolVersion: async () => 2,
    prepareWorkspaceRepositoryAccess: vi.fn(
      async (input: {
        repositoryId?: number;
        githubRepo?: string;
        mode: 'read' | 'contribute';
        source: 'environment' | 'user';
      }) => ({
        success: true as const,
        repository: {
          ...repositories(
            input.repositoryId ?? (input.githubRepo === 'acme/b' ? 202 : 101),
            input.mode
          ),
          source: input.source,
        },
      })
    ),
  } as unknown as GitTokenService;
  const base = await prepareCredentialGrant({
    env: {
      WORKER_URL: 'https://worker.example',
      KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
      KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
      KILO_SESSION_INGEST_URL: 'https://ingest.kilo.ai',
    } as Parameters<typeof prepareCredentialGrant>[0]['env'],
    source: {
      userId: OWNER,
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      repository: { type: 'git', url: 'https://github.com/acme/a.git' },
      scopeId,
    },
    sessionId: SESSION,
    sandboxId,
    provider,
    containmentEnabled: true,
    directory: '/workspace/test',
    scopeId,
    outboundContainerId,
    payload: {},
  });
  const alias = createControlPlaneCredential(sandboxId, 'github');
  const grant = persistedSessionCredentialGrantSchema.parse({
    ...base.grant,
    members: [
      { sessionId: SESSION, kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { sessionId: SIBLING, kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ],
    repository: {
      type: 'github',
      repo: 'acme/a',
      authentication: 'managed',
      allowUserAuthorization: false,
    },
    scm: {
      purpose: 'github',
      alias,
      gitUrl: 'https://github.com/acme/a.git',
      githubAuthSource: 'installation',
      githubAppType: 'standard',
      author,
      capability: {
        credential: 'kgh2.synthetic-persisted',
        outboundContainerId,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
      },
    },
    additionalRepositories: [
      {
        repository: {
          type: 'github',
          repo: 'acme/b',
          authentication: 'managed',
          allowUserAuthorization: false,
        },
        scm: {
          purpose: 'github',
          alias,
          gitUrl: 'https://github.com/acme/b.git',
          githubAuthSource: 'installation',
          githubAppType: 'standard',
          author,
          capability: {
            credential: 'kgh2.synthetic-persisted-b',
            outboundContainerId,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 30 * 60_000,
          },
        },
      },
    ],
  });
  const pin: StoredProviderPin = {
    provider,
    allocationName: sandboxId,
    configuration: null,
    locator: null,
    billing: null,
    containment: { kilocode: true, github: true },
  };
  await runInDurableObject(sandbox, async (instance, state) => {
    await instance.getAllocationState();
    Object.assign(Reflect.get(instance, 'env') as Env, {
      GIT_TOKEN_SERVICE: tokens,
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
      WORKER_URL: 'https://worker.example',
      KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
      KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
      KILO_SESSION_INGEST_URL: 'https://ingest.kilo.ai',
    });
    instance.organizationMembershipFor = async () => membership.current;
    Object.assign(instance, { providerPin: pin });
    await state.storage.put('control_plane_owner', OWNER);
    const db = drizzle(state.storage);
    db.insert(allocation)
      .values({
        id: 'current',
        state: 'connected',
        allocation_id: 'allocation-existing',
        connection_id: 'connection-existing',
        provider_ref: 'provider-existing',
        wrapper_id: 'wrapper-existing',
        stop_attempt: 0,
        stop_pending: false,
        provider_pin: JSON.stringify(pin),
      })
      .onConflictDoUpdate({
        target: allocation.id,
        set: {
          state: 'connected',
          allocation_id: 'allocation-existing',
          connection_id: 'connection-existing',
          provider_ref: 'provider-existing',
          wrapper_id: 'wrapper-existing',
          provider_pin: JSON.stringify(pin),
        },
      })
      .run();
    writeScopeGrant(db, grant);
    for (const member of grant.members)
      writeRoute(db, {
        sessionId: member.sessionId,
        spec: {
          sessionId: member.sessionId,
          kiloSessionId: member.kiloSessionId,
          directory: grant.directory,
          attemptId: 'attempt-existing',
        },
        grant,
        credentialSource: null,
        environment: null,
        state: 'ready',
        attemptId: 'attempt-existing',
        attemptDeadlineAt: Date.now() + 60_000,
        reason: null,
      });
  });
  const identity = () =>
    runInDurableObject(sandbox, (_instance, state) => {
      const db = drizzle(state.storage);
      return { allocation: db.select().from(allocation).all(), grants: listScopeGrants(db) };
    });
  const policy = () =>
    runInDurableObject(sandbox, (_instance, state) =>
      readRepositoryAccess(drizzle(state.storage), scopeId)
    );
  const lookup: WorkspaceRepositoryPolicyLookup = {
    sandboxId,
    userId: OWNER,
    scopeId,
    outboundContainerId,
    owner: 'acme',
    name: 'a',
    source: 'installation',
    installationId: '123',
    appType: 'standard',
    gitAuthor: author,
  };
  const key = Buffer.alloc(32, 7).toString('base64');
  const signedCapability = new GitHubSessionCapabilityCodec(key).issue({
    userId: OWNER,
    outboundContainerId,
    owner: 'acme',
    repo: 'a',
    source: 'installation',
    identity: {
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      gitAuthor: author,
    },
  });
  const reader = new RepositoryPolicyReader(createExecutionContext(), {
    SANDBOX_CONTROL: sandboxNamespace,
  } as ConstructorParameters<typeof RepositoryPolicyReader>[1]);
  const broker = new GitTokenRPCEntrypoint(createExecutionContext(), {
    SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: key,
    REPOSITORY_POLICY: reader,
  } as unknown as ConstructorParameters<typeof GitTokenRPCEntrypoint>[1]);
  // Identity selection is the external PostgreSQL boundary in this Workers fixture.
  // Real signature validation, binding, forwarding, durable policy reads and provider
  // metadata checks all execute below.
  Object.assign(broker, {
    resolveCloudAgentAuthForRepo: async (input: {
      githubRepo: string;
      expectedIntegrationId: string;
    }) => {
      const selected = [repositories(101), repositories(202), repositories(303)].find(
        repo => `${repo.owner}/${repo.name}` === input.githubRepo
      );
      if (!selected || input.expectedIntegrationId !== selected.integrationId)
        return { success: false, reason: 'integration_mismatch' };
      return {
        success: true,
        source: 'installation',
        githubToken: 'synthetic-parent',
        installationId: selected.identity.providerSubjectId,
        accountLogin: selected.owner,
        appType: 'standard',
        gitAuthor: author,
      };
    },
    githubService: {
      getTokenForRepositoryIds: async (
        _installationId: string,
        ids: number[],
        _appType: string,
        mode: string
      ) => `synthetic-scoped-${mode}-${ids.join('-')}`,
    },
  });
  tokens.issueWorkspaceGitHubSessionCapability = input =>
    broker.issueWorkspaceGitHubSessionCapability(input);
  async function brokerResult(id: number, write = false) {
    const selected = repositories(id);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (input instanceof Request) return new Response('forwarded');
        const url = new URL(String(input));
        const repository = [repositories(101), repositories(202), repositories(303)].find(
          repo => url.pathname === `/repos/${repo.owner}/${repo.name}`
        );
        return repository
          ? Response.json({
              id: repository.repositoryId,
              node_id: repository.nodeId,
              owner: { login: repository.owner },
              name: repository.name,
              private: true,
            })
          : new Response(null, { status: 404 });
      })
    );
    const request = new Request(
      `https://github.com/${selected.owner}/${selected.name}.git/${write ? 'git-receive-pack' : 'info/refs?service=git-upload-pack'}`,
      {
        method: write ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${alias}`,
          ...(write ? { 'Content-Type': 'application/x-git-receive-pack-request' } : {}),
        },
        ...(write ? { body: 'synthetic-git-pack' } : {}),
      }
    );
    const current = (await identity()).grants[0]?.scm?.capability?.credential;
    const backing = current?.startsWith('kgh4.') ? current : signedCapability;
    const response = await forwardResolvedScmCapability(
      request,
      broker,
      { provider: 'github', capability: backing },
      outboundContainerId,
      sandboxId
    );
    return response.status === 200 ? 'allowed' : (await response.text()).split(':', 1)[0];
  }

  return {
    sandboxId,
    sandbox,
    tokens,
    alias,
    grant,
    identity,
    policy,
    lookup,
    brokerResult,
    broker,
    signedCapability,
    outboundContainerId,
  };
}

async function controlToken(userId = OWNER, extra: Record<string, unknown> = {}) {
  return (
    await signModernKiloToken({
      userId,
      pepper: null,
      secret: SECRET,
      expiresInSeconds: 60,
      audience: 'cloud-agent-next',
      tokenPurpose: 'human-api',
      credentialExchange: false,
      extra: {
        cloudAgentControlScope: 'repository-access',
        runtimeAdmission: {
          source: 'user',
          authorizationUserId: userId,
          authorizationPepper: null,
        },
        ...extra,
      },
    })
  ).token;
}
async function caller(f: Awaited<ReturnType<typeof fixture>>, token?: string, userId = OWNER) {
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION, userId: OWNER },
    auth: { kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    workspace: {
      sandboxId: f.sandboxId,
      sandboxKind: 'isolated',
      sandboxProvider: 'cloudflare-containers',
    },
    lifecycle: { timestamp: 1, version: 1 },
  });
  const context = {
    userId,
    authToken: token ?? (await controlToken()),
    request: new Request('https://worker.test/trpc'),
    env: {
      NEXTAUTH_SECRET: SECRET,
      SANDBOX_SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ getMetadata: async () => metadata }),
      },
      SANDBOX_CONTROL: sandboxNamespace,
    },
  } as unknown as TRPCContext;
  return router(createRepositoryAccessHandlers()).createCaller(context);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});
describe('durable workspace repository authority', () => {
  it('initializes legacy repositories without changing runtime identity or guest aliases', async () => {
    const f = await fixture();
    const before = await f.identity();
    expect(f.grant).not.toHaveProperty('githubTaskRef');
    expect(
      await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION })
    ).toMatchObject({ revision: 0, repositories: [{ repositoryId: 101 }, { repositoryId: 202 }] });
    expect(await f.identity()).toEqual(before);
    expect((await f.policy())?.repositories.map(repo => repo.repositoryId)).toEqual([101, 202]);
  });
  it('uses real trusted route/token validation and changes the next canonical broker decision', async () => {
    const f = await fixture();
    const api = await caller(f);
    const before = await f.identity();
    expect(await api.getRepositoryAccess({ sessionId: SESSION })).toMatchObject({ revision: 0 });
    expect(await f.brokerResult(303)).toBe('repository_access_required');
    expect(
      await api.changeRepositoryAccess({
        sessionId: SESSION,
        expectedRevision: 0,
        repositoryId: 303,
        mode: 'read',
      })
    ).toMatchObject({ changed: true, current: { revision: 1 } });
    expect(await f.brokerResult(303)).toBe('allowed');
    expect(await f.brokerResult(303, true)).toBe('repository_read_only');
    await api.changeRepositoryAccess({
      sessionId: SESSION,
      expectedRevision: 1,
      repositoryId: 303,
      mode: 'contribute',
    });
    expect(await f.brokerResult(303, true)).toBe('allowed');
    await api.changeRepositoryAccess({
      sessionId: SESSION,
      expectedRevision: 2,
      repositoryId: 303,
      mode: 'read',
    });
    expect(await f.brokerResult(303, true)).toBe('repository_read_only');
    await api.changeRepositoryAccess({
      sessionId: SESSION,
      expectedRevision: 3,
      repositoryId: 303,
      mode: 'remove',
    });
    expect(await f.brokerResult(303)).toBe('repository_access_required');
    expect(await f.identity()).toEqual(before);
    expect(
      (await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SIBLING })).revision
    ).toBe(4);
  });
  it('validates actual HTTP bearer extraction, scoped route authority and the next broker result', async () => {
    const f = await fixture();
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId: SESSION, userId: OWNER },
      auth: { kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
      workspace: {
        sandboxId: f.sandboxId,
        sandboxKind: 'isolated',
        sandboxProvider: 'cloudflare-containers',
      },
      lifecycle: { timestamp: 1, version: 1 },
    });
    const app = new Hono();
    app.use('/trpc/*', authMiddleware);
    app.use(
      '/trpc/*',
      trpcServer({
        router: router(createRepositoryAccessHandlers()),
        createContext: (_opts, c) => ({
          env: c.env,
          userId: c.get('userId'),
          authToken: c.get('authToken'),
          request: c.req.raw,
        }),
      })
    );
    const bindings = {
      NEXTAUTH_SECRET: SECRET,
      HYPERDRIVE: { connectionString: 'fixture' },
      SANDBOX_SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ getMetadata: async () => metadata }),
      },
      SANDBOX_CONTROL: sandboxNamespace,
    };
    const token = await controlToken();
    const list = await app.request(
      `/trpc/getRepositoryAccess?input=${encodeURIComponent(JSON.stringify({ sessionId: SESSION }))}`,
      { headers: { Authorization: `Bearer ${token}` } },
      bindings
    );
    expect(list.status).toBe(200);
    const safe = await list.text();
    expect(safe).not.toContain('integrationId');
    expect(safe).not.toContain('providerSubjectId');
    const changed = await app.request(
      '/trpc/changeRepositoryAccess',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION,
          expectedRevision: 0,
          repositoryId: 303,
          mode: 'read',
        }),
      },
      bindings
    );
    expect(changed.status).toBe(200);
    expect(await f.brokerResult(303)).toBe('allowed');
    expect(await f.brokerResult(303, true)).toBe('repository_read_only');
    for (const credential of [
      f.alias,
      'wrapper-ticket',
      'kgh2.synthetic',
      await controlToken(OWNER, { cloudAgentControlScope: undefined }),
    ]) {
      const denied = await app.request(
        '/trpc/changeRepositoryAccess',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: SESSION,
            expectedRevision: 1,
            repositoryId: 303,
            mode: 'contribute',
          }),
        },
        bindings
      );
      expect(denied.status).toBeGreaterThanOrEqual(400);
    }
    expect(await f.brokerResult(303, true)).toBe('repository_read_only');
  });

  it('rejects wrong owners, aliases, wrappers, runtime credentials and child authority at the actual route', async () => {
    const f = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const child = (
      await signModernKiloToken({
        userId: OWNER,
        pepper: null,
        secret: SECRET,
        expiresInSeconds: 60,
        now: new Date(now * 1000),
        audience: 'cloud-agent-next',
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        extra: {
          cloudAgentAuthority: {
            version: 1,
            ownerId: OWNER,
            parentSessionId: SESSION,
            organizationId: null,
            authorizationId: '00000000-0000-4000-8000-000000000001',
            expiresAt: now + 60,
          },
        },
      })
    ).token;
    const runtime = (
      await signModernKiloToken({
        userId: OWNER,
        pepper: null,
        secret: SECRET,
        expiresInSeconds: 60,
        audience: 'cloud-agent-next',
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        extra: {
          runtimeAuthorization: {
            id: '00000000-0000-4000-8000-000000000001',
            resourceKind: 'cloud-agent-next',
            resourceId: SESSION,
          },
        },
      })
    ).token;
    const invalid = [
      child,
      runtime,
      f.alias,
      'wrapper-ticket',
      'kgh2.synthetic',
      await controlToken(OWNER, { cloudAgentControlScope: undefined }),
      await controlToken('another-user'),
    ];
    for (const token of invalid)
      await expect(
        (await caller(f, token)).getRepositoryAccess({ sessionId: SESSION })
      ).rejects.toThrow();
    await expect(
      (await caller(f, await controlToken('another-user'), 'another-user')).getRepositoryAccess({
        sessionId: SESSION,
      })
    ).rejects.toThrow();
    membership.current = false;
    await expect(
      (await caller(f)).changeRepositoryAccess({
        sessionId: SESSION,
        expectedRevision: 0,
        repositoryId: 303,
        mode: 'read',
      })
    ).rejects.toThrow();
    expect(await f.policy()).toBeNull();
  });
  it('preserves restrictions across stale initialization, credential retirement and eviction', async () => {
    const f = await fixture();
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    const stale = await repositoryAccessFromTrustedGrant(f.grant, f.tokens);
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 0,
      repositoryId: 202,
      mode: 'remove',
    });
    expect((await f.policy())?.repositories.map(repo => repo.repositoryId)).toEqual([101]);
    // Renewal derives execution material; it has no permission write path.
    await runInDurableObject(f.sandbox, (_instance, state) =>
      writeScopeGrant(drizzle(state.storage), {
        ...f.grant,
        preparedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
    );
    expect((await f.policy())?.revision).toBe(1);
    expect(stale.repositories).toHaveLength(2);
    await evictAllDurableObjects();
    expect((await f.policy())?.repositories.map(repo => repo.repositoryId)).toEqual([101]);
  });
  it('remints v4 after credential retirement and eviction without restoring removed launch authority', async () => {
    const f = await fixture();
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 0,
      repositoryId: 101,
      mode: 'remove',
    });
    await runInDurableObject(f.sandbox, (_instance, state) => {
      const db = drizzle(state.storage);
      retireScopeGrants(db, state.storage.kv);
      db.update(routesTable)
        .set({ state: 'failed', reason: 'sandbox_lost', grant: null })
        .where(eq(routesTable.attempt_id, 'attempt-existing'))
        .run();
    });
    await evictAllDurableObjects();
    await runInDurableObject(f.sandbox, async instance => {
      await instance.getAllocationState();
      Object.assign(Reflect.get(instance, 'env') as Env, {
        GIT_TOKEN_SERVICE: f.tokens,
        SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
        WORKER_URL: 'https://worker.example',
        KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
        KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
        KILO_SESSION_INGEST_URL: 'https://ingest.kilo.ai',
      });
      instance.organizationMembershipFor = async () => true;
    });
    const result = await f.sandbox.prepare({
      spec: {
        sessionId: SESSION,
        kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        directory: '/workspace/test',
        attemptId: 'restored-attempt',
      },
      credentials: {
        userId: OWNER,
        kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
        scopeId: SCOPE,
        repository: { type: 'github', repo: 'acme/a', allowUserAuthorization: false },
      },
    });
    expect(result.state).toBe('preparing');
    expect((await f.identity()).grants[0]?.scm?.capability?.credential).toMatch(/^kgh4\./);
    expect((await f.policy())?.repositories.map(repo => repo.repositoryId)).toEqual([202]);
    expect(await f.brokerResult(202)).toBe('allowed');
    expect(await f.brokerResult(101)).toBe('repository_access_required');
  });

  it.each(['complete', 'fail'] as const)(
    'limits real pending-preparation issuance and clears the marker after %s',
    async outcome => {
      const f = await fixture();
      await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
      const retire = () =>
        runInDurableObject(f.sandbox, (_instance, state) => {
          const db = drizzle(state.storage);
          retireScopeGrants(db, state.storage.kv);
          db.update(routesTable)
            .set({ state: 'failed', reason: 'sandbox_lost', grant: null })
            .where(eq(routesTable.session_id, SESSION))
            .run();
        });
      await retire();
      await evictAllDurableObjects();
      await runInDurableObject(f.sandbox, async instance => {
        await instance.getAllocationState();
        Object.assign(Reflect.get(instance, 'env') as Env, {
          GIT_TOKEN_SERVICE: f.tokens,
          SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
          WORKER_URL: 'https://worker.example',
          KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
          KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
          KILO_SESSION_INGEST_URL: 'https://ingest.kilo.ai',
        });
        instance.organizationMembershipFor = async () => true;
      });

      let admitted: WorkspaceRepositoryScope | undefined;
      const probes: unknown[] = [];
      let grantCountAtIssuance = -1;
      f.tokens.issueWorkspaceGitHubSessionCapability = async input => {
        admitted = { ...input };

        for (const change of [
          { userId: 'oauth/wrong-owner' },
          { orgId: '00000000-0000-4000-8000-000000000003' },
          { scopeId: 'worktree_33333333-3333-4333-8333-333333333333' },
          { outboundContainerId: 'obsolete-allocation' },
          { sandboxId: `sbx-${'b'.repeat(48)}` },
        ])
          probes.push(
            await f.broker.issueWorkspaceGitHubSessionCapability({ ...input, ...change })
          );
        const valid = await f.broker.issueWorkspaceGitHubSessionCapability(input);
        probes.push(valid);
        return outcome === 'complete'
          ? valid
          : { success: false, reason: 'authorization_unavailable' };
      };
      await runInDurableObject(f.sandbox, (instance, state) => {
        (Reflect.get(instance, 'env') as Env).GIT_TOKEN_SERVICE = {
          ...f.tokens,
          issueWorkspaceGitHubSessionCapability: async input => {
            grantCountAtIssuance = listScopeGrants(drizzle(state.storage)).length;
            return f.tokens.issueWorkspaceGitHubSessionCapability!(input);
          },
        };
      });
      const preparation = f.sandbox
        .prepare({
          spec: {
            sessionId: SESSION,
            kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
            directory: '/workspace/test',
            attemptId: `held-${outcome}`,
          },
          credentials: {
            userId: OWNER,
            kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
            kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
            scopeId: SCOPE,
            repository: { type: 'github', repo: 'acme/a', allowUserAuthorization: false },
          },
        })
        .then(result => result);
      expect((await preparation).state).toBe(outcome === 'complete' ? 'preparing' : 'failed');
      expect(grantCountAtIssuance).toBe(0);
      expect(probes).toHaveLength(6);
      expect(probes.slice(0, 5)).toEqual(
        Array(5).fill({ success: false, reason: 'authorization_unavailable' })
      );
      expect(probes[5]).toMatchObject({
        success: true,
        capability: expect.stringMatching(/^kgh4\./),
      });
      if (!admitted) throw new Error('Preparation did not reach issuance');
      expect(
        await runInDurableObject(f.sandbox, instance =>
          Reflect.get(instance, 'repositoryPreparation')
        )
      ).toBeNull();
      await retire();
      expect(await f.broker.issueWorkspaceGitHubSessionCapability(admitted)).toMatchObject({
        success: false,
      });
      expect(await f.policy()).not.toBeNull();
    }
  );

  it('rejects captured v4 redemption and issuance after actual session deletion', async () => {
    const f = await fixture(SESSION);
    await runInDurableObject(f.sandbox, (_instance, state) => {
      const db = drizzle(state.storage);
      writeScopeGrant(db, { ...f.grant, members: [f.grant.members[0]!] });
      db.delete(routesTable).where(eq(routesTable.session_id, SIBLING)).run();
    });
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    const scope = {
      userId: OWNER,
      sandboxId: f.sandboxId,
      scopeId: SESSION,
      outboundContainerId: f.outboundContainerId,
    };
    const issued = await f.broker.issueWorkspaceGitHubSessionCapability(scope);
    expect(issued.success).toBe(true);
    if (!issued.success) throw new Error('Expected admitted workspace capability');
    const sessions = (
      env as unknown as {
        SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2>;
      }
    ).SANDBOX_SESSION;
    const session = sessions.getByName(sessionDoName(OWNER, SESSION));
    const registered = await session.registerSessionFromMetadata({
      metadata: parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: SESSION, userId: OWNER, createdOnPlatform: 'cloud-agent-web' },
        auth: {
          kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          kilocodeToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
        },
        agent: { mode: 'code', model: 'test/model' },
        workspace: {
          sandboxId: f.sandboxId,
          sandboxProvider: 'cloudflare-containers',
          sandboxKind: 'isolated',
        },
        lifecycle: { version: 1, timestamp: 1 },
      }),
      sandboxSelection: { provider: 'cloudflare-containers', sandboxKind: 'isolated' },
    });
    expect(registered).toEqual({ success: true });
    await session.deleteSession();
    expect(await f.policy()).toBeNull();
    expect((await f.identity()).grants).toHaveLength(0);
    expect(await f.broker.issueWorkspaceGitHubSessionCapability(scope)).toMatchObject({
      success: false,
    });
    expect(
      await f.broker.redeemGitHubSessionCapability({
        capability: issued.capability,
        workspaceSandboxId: f.sandboxId,
        outboundContainerId: f.outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/b.git/info/refs?service=git-upload-pack',
      })
    ).toMatchObject({ success: false });
  });

  it('renews the unchanged Vercel alias through signed OIDC admission and v4 forwarding', async () => {
    const f = await fixture(SCOPE, 'vercel');
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 0,
      repositoryId: 101,
      mode: 'remove',
    });
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 1,
      repositoryId: 202,
      mode: 'read',
    });
    const issued = await f.broker.issueWorkspaceGitHubSessionCapability({
      userId: OWNER,
      sandboxId: f.sandboxId,
      scopeId: SCOPE,
      outboundContainerId: f.outboundContainerId,
    });
    expect(issued.success).toBe(true);
    if (!issued.success) throw new Error('Expected Vercel workspace capability');
    await runInDurableObject(f.sandbox, (_instance, state) => {
      const grant = structuredClone(f.grant);
      for (const scm of [
        grant.scm,
        ...(grant.additionalRepositories ?? []).map(repo => repo.scm),
      ]) {
        if (scm)
          scm.capability = {
            credential: issued.capability,
            outboundContainerId: f.outboundContainerId,
            issuedAt: Date.now() - 60_000,
            expiresAt: Date.now() - 1,
          };
      }
      writeScopeGrant(drizzle(state.storage), grant);
    });
    // Simulate GitHub metadata/HTTP only; provider admission verifies a signed
    // synthetic OIDC token through the production JWKS verifier.
    await f.brokerResult(202);
    const vercelCredential = { ...credential(), userId: OWNER, organizationId: undefined };
    const keys = createVercelJwksCache({ fetch: keysFetch() });
    const forwardEnv = {
      WORKER_URL: 'https://worker.test',
      GIT_TOKEN_SERVICE: f.broker,
    } as unknown as TRPCContext['env'];
    const admit: Parameters<typeof handleVercelScmForward>[3] = async (_env, locator, input) => {
      expect(locator).toBe(f.sandboxId);
      return runInDurableObject(f.sandbox, (_instance, state) => {
        const db = drizzle(state.storage);
        return admitVercelScmForward(input, {
          env: forwardEnv,
          contract,
          keys,
          fetchCredential: async () => vercelCredential,
          serial: operation => operation(),
          readContext: async () => ({
            sandboxId: f.sandboxId,
            ownerId: OWNER,
            provider: 'vercel',
            containmentEnabled: true,
            allocation: {
              kind: 'connected',
              allocationId: 'allocation-existing',
              providerRef: JSON.stringify({
                sandboxName: physicalName,
                sessionId: expected.sandboxId,
              }),
            },
            physicalName,
            outboundContainerId: f.outboundContainerId,
            byoc: { userId: OWNER, credentialId: 'credential-test' },
            locator: {
              teamId: expected.teamId,
              projectId: expected.projectId,
              snapshotId: 'snapshot-test',
              runtimeBuildId: 'runtime-test',
              runtime: 'node24',
            },
            grants: listScopeGrants(db),
            liveSessionIds: [SESSION, SIBLING],
          }),
          resolve: input =>
            resolveSessionCredential({
              ...input,
              env: { GIT_TOKEN_SERVICE: f.tokens } as Parameters<
                typeof resolveSessionCredential
              >[0]['env'],
            }),
          persist: grant => writeScopeGrant(db, grant),
        });
      });
    };
    const request = (write = false) =>
      new Request(`https://worker.test/scm/vercel/${f.sandboxId}`, {
        method: write ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${f.alias}`,
          'vercel-forwarded-host': 'github.com',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': `/acme/b.git/${write ? 'git-receive-pack' : 'info/refs?service=git-upload-pack'}`,
          'vercel-sandbox-oidc-token': token({
            aud: `https://worker.test/scm/vercel/${f.sandboxId}`,
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
          ...(write ? { 'content-type': 'application/x-git-receive-pack-request' } : {}),
        },
        ...(write ? { body: 'synthetic-pack' } : {}),
      });
    expect((await handleVercelScmForward(request(), forwardEnv, f.sandboxId, admit)).status).toBe(
      200
    );
    const renewed = (await f.identity()).grants[0]?.additionalRepositories?.[0]?.scm;
    expect(renewed?.alias).toBe(f.alias);
    expect(renewed?.capability?.credential).toMatch(/^kgh4\./);
    expect(renewed?.capability?.expiresAt).toBeGreaterThan(Date.now());
    const write = await handleVercelScmForward(request(true), forwardEnv, f.sandboxId, admit);
    expect(write.status).toBe(403);
    expect(await write.text()).toContain('repository_read_only');
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 2,
      repositoryId: 202,
      mode: 'remove',
    });
    const removed = await handleVercelScmForward(request(), forwardEnv, f.sandboxId, admit);
    expect(removed.status).toBe(403);
    expect(await removed.text()).toContain('repository_access_required');
  });

  it('rejects a different workspace locator and an obsolete outbound allocation binding', async () => {
    const first = await fixture(),
      second = await fixture();
    await first.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    await second.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    const input = {
      capability: first.signedCapability,
      workspaceSandboxId: second.sandboxId,
      outboundContainerId: first.outboundContainerId,
      requestMethod: 'GET',
      requestUrl: 'https://api.github.com/repos/acme/a/contents/file',
    };
    expect(await first.broker.redeemGitHubSessionCapability(input)).toEqual({
      success: false,
      reason: 'authorization_unavailable',
    });
    expect(
      await first.broker.redeemGitHubSessionCapability({
        ...input,
        workspaceSandboxId: first.sandboxId,
        outboundContainerId: 'retired-allocation',
      })
    ).toEqual({ success: false, reason: 'container_mismatch' });
  });

  it('retains standalone policy through the release phase of runtime authorization renewal', async () => {
    const f = await fixture(SESSION);
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 0,
      repositoryId: 202,
      mode: 'remove',
    });
    await f.sandbox.release({ sessionId: SESSION });
    expect((await f.policy())?.repositories.map(repo => repo.repositoryId)).toEqual([101]);
    expect((await f.policy())?.revision).toBe(1);
    await f.sandbox.deleteSessionRepositoryAccess({ sessionId: SESSION });
    expect(await f.policy()).toBeNull();
  });
  it('preserves large configured policies while blocking only new additions over the limit', async () => {
    const f = await fixture();
    const configured = Array.from({ length: 70 }, (_, index) => ({
      ...repositories(101),
      repositoryId: index + 1,
      nodeId: `R_${index + 1}`,
      name: `repo-${index + 1}`,
    }));
    await runInDurableObject(f.sandbox, (_instance, state) =>
      writeRepositoryAccess(drizzle(state.storage), {
        version: 1,
        scopeId: SCOPE,
        revision: 0,
        repositories: configured,
      })
    );
    expect(
      (await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION })).repositories
    ).toHaveLength(70);
    const denial = await runInDurableObject(f.sandbox, async instance => {
      try {
        await instance.changeRepositoryAccess({
          ownerId: OWNER,
          sessionId: SESSION,
          expectedRevision: 0,
          repositoryId: 303,
          mode: 'read',
        });
        return 'allowed';
      } catch (error) {
        return error instanceof Error ? error.message : 'unknown';
      }
    });
    expect(denial).toContain('repository_limit_reached');
    expect(
      await f.sandbox.changeRepositoryAccess({
        ownerId: OWNER,
        sessionId: SESSION,
        expectedRevision: 0,
        repositoryId: 70,
        mode: 'read',
      })
    ).toMatchObject({ changed: true, current: { revision: 1 } });
    expect(
      await f.sandbox.changeRepositoryAccess({
        ownerId: OWNER,
        sessionId: SESSION,
        expectedRevision: 1,
        repositoryId: 70,
        mode: 'remove',
      })
    ).toMatchObject({ changed: true, current: { revision: 2 } });
    expect((await f.policy())?.repositories).toHaveLength(69);
  });

  it('returns current revision on a stale concurrent edit', async () => {
    const f = await fixture();
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    await f.sandbox.changeRepositoryAccess({
      ownerId: OWNER,
      sessionId: SESSION,
      expectedRevision: 0,
      repositoryId: 202,
      mode: 'remove',
    });
    expect(
      await f.sandbox.changeRepositoryAccess({
        ownerId: OWNER,
        sessionId: SIBLING,
        expectedRevision: 0,
        repositoryId: 303,
        mode: 'read',
      })
    ).toMatchObject({
      changed: false,
      current: { revision: 1, repositories: [{ repositoryId: 101 }] },
    });
    expect(await f.brokerResult(303)).toBe('repository_access_required');
  });
  it('fails closed on corrupt durable policy and never reseeds it', async () => {
    const f = await fixture();
    await f.sandbox.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
    await runInDurableObject(f.sandbox, (_instance, state) => {
      const db = drizzle(state.storage);
      db.update(workspaceRepositoryAccess)
        .set({ data: { invalid: true } as never })
        .where(eq(workspaceRepositoryAccess.scope_id, SCOPE))
        .run();
    });
    const failure = await runInDurableObject(f.sandbox, async instance => {
      try {
        await instance.getRepositoryAccess({ ownerId: OWNER, sessionId: SESSION });
        return 'allowed';
      } catch {
        return 'authorization_unavailable';
      }
    });
    expect(failure).toBe('authorization_unavailable');
  });
});
