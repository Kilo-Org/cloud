import { createExecutionContext, env, reset, runInDurableObject } from 'cloudflare:test';
import {
  renewRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ControlPlaneSessionPeer,
  SandboxControlV2,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  runtimeCredentialProxyFacadeBaseUrl,
  runtimeProxyHandleGrantId,
} from '../../src/runtime-credential-proxy.js';
import { RUNTIME_PROXY_GRANT_KEY } from '../../src/runtime-credential-proxy.js';
import {
  RUNTIME_AUTHORIZATION_KEY,
  renewStoredRuntimeAuthorization,
} from '../../src/session/runtime-authorization-persistence.js';
import worker from '../../src/server.js';
import type { AgentSandboxProvider, Env } from '../../src/types.js';
import type { ProviderAdapter, StopResult } from '../../src/sandbox-control/provider.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  fakeOutboundContainerId,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_123';
const ORG_ID = 'org_123';
const WORKER_URL = 'https://control.test';
const SECRET = env.NEXTAUTH_SECRET as string;
const FACADE_BASE = runtimeCredentialProxyFacadeBaseUrl(WORKER_URL);

type FakeProvider = {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
};

let sequence = 0;

function newSessionId(): string {
  sequence += 1;
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  // `containedKiloSessionIdSchema` requires exactly 26 alphanumerics.
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function messageId(): string {
  // `MessageIdSchema`: `msg_` + 12 lowercase hex + 14 base62.
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

function b64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** A Kilo token that decodes to `runtimeAuthorization` (modern authorization). */
function runtimeAuthorizedKiloToken(): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ runtimeAuthorization: { id: 'ra_1' } }));
  return `${header}.${payload}.sig`;
}

function promptPayload(messageIdValue: string): ControlPlanePromptPayload {
  return {
    messageId: messageIdValue,
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

function metadata(input: {
  sessionId: string;
  kiloSessionIdValue: string;
  sandboxId: string;
  kiloToken: string;
  provider?: AgentSandboxProvider;
  worktreeId?: string;
}) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: input.kiloSessionIdValue, kilocodeToken: input.kiloToken },
    agent: { mode: 'code', model: 'test/model' },
    repository: {
      type: 'git',
      url: 'https://github.com/acme/widgets.git',
      platform: 'github',
    },
    workspace: {
      ...(input.worktreeId === undefined
        ? {}
        : { worktreeId: input.worktreeId, workspacePath: `/workspace/${input.worktreeId}` }),
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: input.provider ?? 'vercel',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

/**
 * A runtime authorization whose seal and metadata token agree on one active id,
 * so `getRuntimeToken` returns the token without a renewal call.
 */
async function sealedRuntimeAuthorization(
  sessionId: string
): Promise<{ seal: string; token: string; authorizationId: string; delegationExpiresAt: string }> {
  const now = Date.now();
  const delegationExpiresAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const authorizationId = crypto.randomUUID();
  const seal = await sealRuntimeAuthorization(
    {
      version: 1,
      id: authorizationId,
      resourceKind: 'cloud-agent-next',
      resourceId: sessionId,
      userId: USER_ID,
      authorizationUserId: USER_ID,
      organizationId: ORG_ID,
      issuedAt: new Date(now).toISOString(),
      delegationExpiresAt,
      state: 'active',
      bindings: {
        userPepperDigest: 'null',
        authorizationPepperDigest: 'null',
        userMembershipId: 'membership_1',
        authorizationUserMembershipId: 'membership_1',
      },
      source: { admissionSource: 'user' },
    },
    SECRET
  );
  const token = jwt.sign(
    {
      runtimeAuthorization: { id: authorizationId },
      exp: Math.floor((now + 60 * 60_000) / 1000),
    },
    SECRET
  );
  return { seal, token, authorizationId, delegationExpiresAt };
}

function createProvider(): FakeProvider {
  const provider: FakeProvider = { adapter: null as unknown as ProviderAdapter, launchEnvs: [] };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop() {
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

async function installSandbox(
  sandboxId: string,
  provider: FakeProvider,
  broker = createFakeCredentialBroker()
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, broker, {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      WORKER_URL,
      KILOCODE_BACKEND_BASE_URL: WORKER_URL,
      KILO_OPENROUTER_BASE: WORKER_URL,
      KILO_SESSION_INGEST_URL: WORKER_URL,
    });
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
    });
  });
  return sandboxStub;
}

async function createVercelSession(input: {
  sessionId: string;
  kiloId: string;
  sandboxId: string;
  kiloToken: string;
  seal?: string;
  provider?: AgentSandboxProvider;
  contained?: boolean;
  worktreeId?: string;
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  const sessionStub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  await runInDurableObject(sessionStub, instance => {
    instance.env.WORKER_URL = WORKER_URL;
  });
  await sessionStub.createSessionWithInitialAdmission({
    metadata: metadata({
      sessionId: input.sessionId,
      kiloSessionIdValue: input.kiloId,
      sandboxId: input.sandboxId,
      kiloToken: input.kiloToken,
      provider: input.provider,
      worktreeId: input.worktreeId,
    }),
    message: promptPayload(messageId()),
    sandboxSelection: {
      provider: input.provider ?? 'vercel',
      ...(input.contained === undefined
        ? {}
        : {
            containment: {
              kilocode: input.contained,
              github: input.contained,
              worktreeScoped: true,
            },
          }),
    },
    ...(input.seal ? { runtimeAuthorizationSeal: input.seal } : {}),
  });
  return sessionStub;
}

function launchIdentity(provider: FakeProvider): { credential: string; allocationId: string } {
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv) throw new Error('provider.launch was not called');
  const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  return { credential, allocationId };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('SandboxControlV2 runtime credential proxy (R1)', () => {
  it('keeps a shared modern sibling authorized after releasing the creator and denies its deleted handle', async () => {
    const creatorId = newSessionId();
    const siblingId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, creatorId);
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const provider = createProvider();
    const sandbox = await installSandbox(sandboxId, provider);
    const create = async (sessionId: string) => {
      const { seal, token } = await sealedRuntimeAuthorization(sessionId);
      return createVercelSession({
        sessionId,
        kiloId: kiloSessionId(),
        sandboxId,
        kiloToken: token,
        seal,
        worktreeId,
      });
    };
    const creator = await create(creatorId);
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const identity = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential: identity.credential });
    await wrapper.hello({ wrapperId: 'wr_shared', allocationId: identity.allocationId });
    const first = await wrapper.next();
    if (first?.type !== 'session.prepare' || !first.credentials.proxy)
      throw new Error('missing creator proxy');
    wrapper.send({ type: 'session.ready', sessionId: creatorId });
    await waitFor(async () =>
      expect((await sandbox.status({ sessionId: creatorId })).view.state).toBe('ready')
    );
    expect((await wrapper.next())?.type).toBe('session.prompt');
    const sibling = await create(siblingId);
    let second = await wrapper.next();
    if (second?.type === 'worktree.snapshot') {
      wrapper.send({
        type: 'worktree.result',
        requestId: second.requestId,
        ok: false,
        error: {
          code: 'snapshot_unavailable',
          message: 'Fixture has no workspace snapshot',
          retryable: false,
        },
      });
      second = await wrapper.next();
    }
    if (second?.type !== 'session.prepare' || !second.credentials.proxy)
      throw new Error(`missing sibling proxy: frame=${second?.type}`);
    expect(first.spec.directory).toBe(second.spec.directory);
    expect(first.credentials.proxy.handle === second.credentials.proxy.handle).toBe(false);
    expect(
      await creator.resolveRuntimeCredentialProxyGrant(first.credentials.proxy.handle)
    ).not.toBeNull();
    expect(
      await sibling.resolveRuntimeCredentialProxyGrant(second.credentials.proxy.handle)
    ).not.toBeNull();
    await sandbox.release({ sessionId: creatorId });
    expect(
      await creator.resolveRuntimeCredentialProxyGrant(first.credentials.proxy.handle)
    ).toBeNull();
    expect(
      await sibling.resolveRuntimeCredentialProxyGrant(second.credentials.proxy.handle)
    ).not.toBeNull();
    expect((await sandbox.getAllocationState()).kind).toBe('connected');
    expect(provider.launchEnvs).toHaveLength(1);
    wrapper.send({ type: 'session.failed', sessionId: siblingId, reason: 'agent_unavailable' });
    await waitFor(async () =>
      expect((await sandbox.status({ sessionId: siblingId })).view.state).toBe('failed')
    );
    expect(
      await sibling.resolveRuntimeCredentialProxyGrant(second.credentials.proxy.handle)
    ).toBeNull();
  });

  it.each([
    ['cloudflare', true],
    ['cloudflare-containers', true],
    ['vercel', true],
    ['cloudflare', false],
    ['cloudflare-containers', false],
  ] as const)(
    '%s contained=%s forwards renewed authorization after JWT expiry and allocation replacement',
    async (providerName, contained) => {
      const startedAt = Date.now();
      const sessionId = newSessionId();
      const kiloId = kiloSessionId();
      const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
      const provider = createProvider();
      const broker = createFakeCredentialBroker();
      const sandboxStub = await installSandbox(sandboxId, provider, broker);
      const { seal, token, delegationExpiresAt } = await sealedRuntimeAuthorization(sessionId);
      const sessionStub = await createVercelSession({
        sessionId,
        kiloId,
        sandboxId,
        kiloToken: token,
        seal,
        provider: providerName,
        contained,
      });
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const identity = launchIdentity(provider);
      const wrapper = await FakeWrapper.connect({ sandboxId, credential: identity.credential });
      await wrapper.hello({ wrapperId: 'wr_1', allocationId: identity.allocationId });
      const frame = await wrapper.next();
      if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
      const handle = frame.credentials?.proxy?.handle;
      expect(handle).toEqual(expect.any(String));
      if (!handle) throw new Error('missing runtime proxy handle');
      expect(JSON.stringify(frame).includes(token)).toBe(false);
      expect(broker.kiloIssued()).toBe(0);
      expect(frame.spec.runtimeIsolation).toBe('per-session');
      expect(
        await sandboxStub.resolveCredential({
          credential: frame.spec.kilo?.token ?? '',
          outboundContainerId: fakeOutboundContainerId(sandboxId),
          url: `${WORKER_URL}/api/profile`,
          method: 'GET',
        })
      ).toBeNull();
      await runInDurableObject(sessionStub, async instance => {
        expect(await instance.ctx.storage.get(RUNTIME_PROXY_GRANT_KEY)).toMatchObject({
          mode: contained ? 'contained' : 'direct',
        });
      });
      wrapper.send({ type: 'session.ready', sessionId });
      await waitFor(async () =>
        expect((await sandboxStub.status({ sessionId })).view.state).toBe('ready')
      );
      await waitFor(async () =>
        expect(await sessionStub.getSession()).toMatchObject({ messages: [{ state: 'accepted' }] })
      );

      let membershipPresent = true;
      await runInDurableObject(sessionStub, instance => {
        // Keep the real persisted renewal and binding policy; only the database reads are fake.
        instance.getRuntimeToken = async () =>
          renewStoredRuntimeAuthorization({
            metadata: await instance.getMetadata(),
            getAuthorization: () => instance.ctx.storage.get(RUNTIME_AUTHORIZATION_KEY),
            putAuthorization: authorization =>
              instance.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, authorization),
            getMetadata: () => instance.getMetadata(),
            putMetadata: async updated => {
              await instance.ctx.storage.put('session_metadata', updated);
              Object.assign(instance, { metadata: updated });
            },
            renew: authorization =>
              renewRuntimeAuthorization({
                authorization,
                secret: SECRET,
                connectionString: 'fake',
                now: new Date(Date.now()),
                adapters: {
                  getPrincipal: async ({ userId }) => ({
                    id: userId,
                    apiTokenPepper: null,
                    blockedAt: null,
                    blockedReason: null,
                    isBot: false,
                  }),
                  getMembership: async () =>
                    membershipPresent
                      ? { id: 'membership_1', role: 'member', organizationDeletedAt: null }
                      : null,
                },
              }),
          });
      });
      vi.spyOn(Date, 'now').mockReturnValue(startedAt + 61 * 60_000);
      expect(() => jwt.verify(token, SECRET)).toThrow(/expired/);
      const destinations: string[] = [];
      const upstream = 'https://upstream.test';
      const paths = [
        '/api/openrouter/chat/completions',
        '/api/profile',
        `/api/session/${kiloId}/ingest`,
      ];
      const methods = ['POST', 'GET', 'POST'];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        expect(url.origin).toBe(upstream);
        expect(['/chat/completions', ...paths.slice(1)]).toContain(url.pathname);
        const bearer = request.headers.get('authorization')?.slice('Bearer '.length) ?? '';
        const claims = jwt.verify(bearer, SECRET) as jwt.JwtPayload;
        expect(bearer === token).toBe(false);
        expect(claims.runtimeAuthorization.resourceId).toBe(sessionId);
        expect(claims.organizationId).toBe(ORG_ID);
        expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(request.headers.get('x-kilocode-organizationid')).toBe(ORG_ID);
        destinations.push(url.pathname);
        return new Response('authorized');
      });
      const requestEnv = {
        ...env,
        WORKER_URL,
        KILOCODE_BACKEND_BASE_URL: upstream,
        KILO_OPENROUTER_BASE: upstream,
        KILO_SESSION_INGEST_URL: upstream,
      } as Env;
      const forward = async (currentHandle: string) => {
        for (const [index, path] of paths.entries()) {
          const response = await worker.fetch(
            new Request(`${WORKER_URL}${path}`, {
              method: methods[index],
              headers: { authorization: `Bearer ${currentHandle}` },
            }),
            requestEnv,
            createExecutionContext()
          );
          expect(response.status).toBe(200);
          expect(await response.text()).toBe('authorized');
        }
      };
      await forward(handle);

      await sessionStub.stop();
      wrapper.heartbeat(false);
      await waitFor(async () =>
        expect((await sandboxStub.getAllocationState()).lastFrameAt).toBe(Date.now())
      );
      await runInDurableObject(sandboxStub, instance => instance.alarm());
      await waitFor(async () =>
        expect((await sandboxStub.getAllocationState()).kind).toBe('stopped')
      );
      expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).toBeNull();
      await sessionStub.send(promptPayload(messageId()));
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
      const nextEnv = provider.launchEnvs[1];
      const replacement = await FakeWrapper.connect({
        sandboxId,
        credential: nextEnv.SANDBOX_CONTROL_CREDENTIAL,
      });
      await replacement.hello({
        wrapperId: 'wr_2',
        allocationId: nextEnv.CONTROL_PLANE_ALLOCATION_ID,
      });
      const nextFrame = await replacement.next();
      if (nextFrame?.type !== 'session.prepare') throw new Error('expected replacement prepare');
      const nextHandle = nextFrame.credentials?.proxy?.handle ?? '';
      expect(nextHandle === handle).toBe(false);
      expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).toBeNull();
      await forward(nextHandle);
      expect(destinations).toHaveLength(6);
      expect(broker.kiloIssued()).toBe(0);
      const siblingDenied = await worker.fetch(
        new Request(`${WORKER_URL}/api/session/${kiloSessionId()}/ingest`, {
          method: 'POST',
          headers: { authorization: `Bearer ${nextHandle}` },
        }),
        requestEnv,
        createExecutionContext()
      );
      expect(siblingDenied.status).toBe(404);
      expect(destinations).toHaveLength(6);
      await runInDurableObject(sessionStub, async instance => {
        const authorization = await instance.ctx.storage.get<{ delegationExpiresAt: string }>(
          RUNTIME_AUTHORIZATION_KEY
        );
        expect(authorization?.delegationExpiresAt).toBe(delegationExpiresAt);
      });
      vi.mocked(Date.now).mockReturnValue(startedAt + 25 * 60 * 60_000);
      const expired = await worker.fetch(
        new Request(`${WORKER_URL}/api/profile`, {
          headers: { authorization: `Bearer ${nextHandle}` },
        }),
        requestEnv,
        createExecutionContext()
      );
      expect(expired.status).toBe(404);
      expect(destinations).toHaveLength(6);

      membershipPresent = false;
      vi.mocked(Date.now).mockReturnValue(startedAt + 122 * 60_000);
      const denied = await worker.fetch(
        new Request(`${WORKER_URL}/api/profile`, {
          headers: { authorization: `Bearer ${nextHandle}` },
        }),
        requestEnv,
        createExecutionContext()
      );
      expect(denied.status).toBe(503);
      expect(destinations).toHaveLength(6);
      await runInDurableObject(sessionStub, async instance => {
        expect(await instance.ctx.storage.get(RUNTIME_AUTHORIZATION_KEY)).toMatchObject({
          state: 'revoked',
        });
      });
      const revoked = await worker.fetch(
        new Request(`${WORKER_URL}/api/profile`, {
          headers: { authorization: `Bearer ${nextHandle}` },
        }),
        requestEnv,
        createExecutionContext()
      );
      expect(revoked.status).toBe(503);
      expect(destinations).toHaveLength(6);
    }
  );

  it('rejects unsupported direct Vercel admission before storing or queuing the session', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionDoName(USER_ID, sessionId));
    const result = await stub.createSessionWithInitialAdmission({
      metadata: metadata({
        sessionId,
        kiloSessionIdValue: kiloSessionId(),
        sandboxId,
        kiloToken: 'legacy-token',
      }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'vercel', containment: { kilocode: false, github: false } },
    });
    expect(result).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(await stub.getSession()).toEqual({ type: 'session-not-found' });
  });

  it('mints a handle on the connected prepare, projects it into the credentials, and resolves it', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createProvider();
    await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    const sessionStub = await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    expect(await wrapper.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });

    const frame = await wrapper.next();
    expect(frame?.type).toBe('session.prepare');
    if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const handle = frame.credentials?.proxy?.handle;
    expect(typeof handle).toBe('string');
    expect((handle ?? '').length).toBeGreaterThan(0);
    expect(frame.credentials?.proxy?.targets.backendBaseUrl).toBe(FACADE_BASE);
    // The handle is a real grant bound to this route: the proxy resolves it.
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle ?? '')).not.toBeNull();
  });

  it.each(['before request', 'during token resolution'] as const)(
    'authorizes the model facade while disconnected %s and completes after same-wrapper reconnect',
    async disconnectAt => {
      const sessionId = newSessionId();
      const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
      const provider = createProvider();
      const sandboxStub = await installSandbox(sandboxId, provider);
      const { seal, token } = await sealedRuntimeAuthorization(sessionId);
      const sessionStub = await createVercelSession({
        sessionId,
        kiloId: kiloSessionId(),
        sandboxId,
        kiloToken: token,
        seal,
      });

      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const { credential, allocationId } = launchIdentity(provider);
      const wrapper = await FakeWrapper.connect({ sandboxId, credential });
      await wrapper.hello({ wrapperId: 'wr_1', allocationId });
      const frame = await wrapper.next();
      if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
      const handle = frame.credentials?.proxy?.handle ?? '';
      wrapper.send({ type: 'session.ready', sessionId });
      await waitFor(async () => {
        expect((await sandboxStub.status({ sessionId })).view.state).toBe('ready');
      });
      const prompt = await wrapper.next();
      if (prompt?.type !== 'session.prompt') throw new Error('expected session.prompt');
      const initialMessageId = prompt.payload.messageId;
      await waitFor(async () =>
        expect(await sessionStub.getSession()).toMatchObject({
          messages: [{ messageId: initialMessageId, state: 'accepted' }],
        })
      );

      const upstream = 'https://upstream.test';
      const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        const request = input instanceof Request ? input : new Request(input);
        expect(request.url).toBe(`${upstream}/chat/completions`);
        expect(request.method).toBe('POST');
        expect(request.headers.get('authorization') === `Bearer ${token}`).toBe(true);
        expect(request.headers.get('x-kilocode-organizationid')).toBe(ORG_ID);
        expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
        return new Response('authorized');
      });
      const forward = () =>
        worker.fetch(
          new Request(`${WORKER_URL}/api/openrouter/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${handle}` },
          }),
          { ...env, WORKER_URL, KILO_OPENROUTER_BASE: upstream } as Env,
          createExecutionContext()
        );
      const tokenGate = Promise.withResolvers<void>();
      let resolvingToken = false;
      if (disconnectAt === 'during token resolution') {
        await runInDurableObject(sessionStub, instance => {
          const original = instance.getRuntimeToken.bind(instance);
          instance.getRuntimeToken = async () => {
            resolvingToken = true;
            await tokenGate.promise;
            return original();
          };
        });
      }
      const pendingResponse = disconnectAt === 'during token resolution' ? forward() : null;
      if (pendingResponse) await waitFor(() => expect(resolvingToken).toBe(true));

      wrapper.close();
      await waitFor(async () => {
        expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
      });
      tokenGate.resolve();
      const response = await (pendingResponse ?? forward());
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('authorized');
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
      const reconnected = await FakeWrapper.connect({ sandboxId, credential });
      expect(await reconnected.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
        type: 'welcome',
        protocolVersion: 2,
      });

      expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).not.toBeNull();
      await runInDurableObject(sessionStub, async instance => {
        const grant = await instance.ctx.storage.get<{ grantId: string }>(RUNTIME_PROXY_GRANT_KEY);
        expect(grant?.grantId).toBe(runtimeProxyHandleGrantId(handle));
      });
      expect(await sessionStub.getSession()).toMatchObject({
        messages: [{ messageId: initialMessageId, state: 'accepted' }],
      });
      expect(await reconnected.next(100)).toBeNull();
      expect(reconnected.receivedFrames()).toBe(1);
      expect(provider.launchEnvs).toHaveLength(1);
      reconnected.send({
        type: 'session.outcome',
        sessionId,
        status: 'completed',
        lastMessageId: initialMessageId,
      });
      await waitFor(async () =>
        expect(await sessionStub.getSession()).toMatchObject({
          messages: [{ messageId: initialMessageId, state: 'completed' }],
        })
      );
    }
  );

  it('re-prepares and mints a new handle after a wrapper restart, invalidating the old one', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    const sessionStub = await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    const first = await wrapper.next();
    if (first?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const firstHandle = first.credentials?.proxy?.handle ?? '';
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => {
      expect((await sandboxStub.status({ sessionId })).view.state).toBe('ready');
    });
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(firstHandle)).not.toBeNull();

    // A new wrapperId is a different wrapper instance: the ready route is lost
    // and re-prepared, and the Session DO replaces the persisted proxy grant.
    wrapper.close();
    await waitFor(async () => {
      expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
    });
    const restarted = await FakeWrapper.connect({ sandboxId, credential });
    expect(await restarted.hello({ wrapperId: 'wr_2', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    const second = await restarted.next();
    if (second?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const secondHandle = second.credentials?.proxy?.handle ?? '';
    expect(secondHandle).not.toBe(firstHandle);
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(secondHandle)).not.toBeNull();
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(firstHandle)).toBeNull();
  });

  it('re-mints on a still-preparing route when a wrapper restart supersedes the handle', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    const sessionStub = await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    const first = await wrapper.next();
    if (first?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const firstHandle = first.credentials?.proxy?.handle ?? '';
    // The route stays preparing (no `session.ready`), so the restart re-sends
    // `session.prepare` for the SAME attempt and grant.
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(firstHandle)).not.toBeNull();

    wrapper.close();
    await waitFor(async () => {
      expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
    });
    const restarted = await FakeWrapper.connect({ sandboxId, credential });
    expect(await restarted.hello({ wrapperId: 'wr_2', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    const second = await restarted.next();
    if (second?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const secondHandle = second.credentials?.proxy?.handle ?? '';
    // The wrapper instance changed, so the old handle belongs to a superseded
    // fence and must be replaced by a fresh, resolvable one.
    expect(secondHandle).not.toBe(firstHandle);
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(secondHandle)).not.toBeNull();
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(firstHandle)).toBeNull();
  });

  it('resends the identical handle on a plain reconnect without re-binding', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    const first = await wrapper.next();
    if (first?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const firstHandle = first.credentials?.proxy?.handle ?? '';

    // Count binds from here: a reconnect with the same wrapperId keeps the same
    // allocation fence, so the handle must be reused without re-binding.
    let bindCalls = 0;
    await runInDurableObject(sandboxStub, instance => {
      const original = instance.bindRuntimeCredentialProxyHandle.bind(instance);
      instance.bindRuntimeCredentialProxyHandle = async input => {
        bindCalls += 1;
        return original(input);
      };
    });

    wrapper.close();
    await waitFor(async () => {
      expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
    });
    const reconnected = await FakeWrapper.connect({ sandboxId, credential });
    expect(await reconnected.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    const second = await reconnected.next();
    if (second?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const secondHandle = second.credentials?.proxy?.handle ?? '';

    expect(secondHandle).toBe(firstHandle);
    expect(bindCalls).toBe(0);
  });

  it('does not send a stale handle when the fence changes between bind and send', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    const sessionStub = await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);

    // Hold both tasks inside `bind` so a wrapper restart can change the fence
    // after the first task minted and bound for the old fence, before it sends.
    let releaseBind!: () => void;
    const bindGate = new Promise<void>(resolve => {
      releaseBind = resolve;
    });
    let bindCalls = 0;
    await runInDurableObject(sandboxStub, instance => {
      const original = instance.bindRuntimeCredentialProxyHandle.bind(instance);
      instance.bindRuntimeCredentialProxyHandle = async input => {
        bindCalls += 1;
        await bindGate;
        return original(input);
      };
    });

    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    await waitFor(() => expect(bindCalls).toBe(1));

    // The restart changes the fence while the first task is blocked; the
    // reconnect's own task mints for the new fence.
    wrapper.close();
    await waitFor(async () => {
      expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
    });
    const restarted = await FakeWrapper.connect({ sandboxId, credential });
    expect(await restarted.hello({ wrapperId: 'wr_2', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    await waitFor(() => expect(bindCalls).toBe(2));

    releaseBind();

    const frame = await restarted.next();
    if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const handle = frame.credentials?.proxy?.handle ?? '';
    // Only the restarted task's frame reached the wrapper: welcome + prepare.
    expect(restarted.receivedFrames()).toBe(2);
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).not.toBeNull();
  });

  it('fails the route as workspace_setup_failed when the handle cannot be minted', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(sandboxId, provider);
    // A session peer that cannot mint stands in for a mint failure (no active
    // runtime authorization, Session DO unavailable).
    await runInDurableObject(sandboxStub, instance => {
      instance.sessionPeerFor = (): ControlPlaneSessionPeer | null => null;
    });
    await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      // A modern token enables the runtime proxy grant even without a seal.
      kiloToken: runtimeAuthorizedKiloToken(),
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    expect(await wrapper.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });

    await waitFor(async () => {
      expect(await sandboxStub.status({ sessionId })).toEqual({
        sessionId,
        view: { state: 'failed', attemptId: expect.any(String), reason: 'workspace_setup_failed' },
      });
    });
    // No prepare reaches the wrapper: the attempt failed before the frame.
    expect(await wrapper.next(100)).toBeNull();
  });
});
