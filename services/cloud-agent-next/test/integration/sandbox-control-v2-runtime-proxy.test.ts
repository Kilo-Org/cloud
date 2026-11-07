import {
  createExecutionContext,
  env,
  evictDurableObject,
  reset,
  runInDurableObject,
} from 'cloudflare:test';
import { generateKeyPairSync } from 'node:crypto';
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
  RUNTIME_PROXY_GRANT_KEY,
} from '../../src/runtime-credential-proxy.js';
import { markHistoryHydrated } from '../../src/control-plane/session/history-hydration.js';
import {
  RUNTIME_AUTHORIZATION_KEY,
  renewStoredRuntimeAuthorization,
} from '../../src/session/runtime-authorization-persistence.js';
import worker from '../../src/server.js';
import { logger } from '../../src/logger.js';
import type { AgentSandboxProvider, Env } from '../../src/types.js';
import type { ProviderAdapter, StopResult } from '../../src/sandbox-control/provider.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlanePromptPayload,
  type ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  fakeOutboundContainerId,
  FAKE_SANDBOX_CONTAINERS_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';
import { encryptWithPublicKey } from '../../src/utils/encryption.js';
import { routes as routesTable } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { ContainersOutbound } from '../../src/sandbox-containers/containers-outbound.js';
import type { ContainersOutboundProps } from '../../src/sandbox-containers/containers-outbound.js';
import type * as VercelIdentityModule from '../../src/scm-broker/vercel-identity.js';
import type * as byocCredentials from '../../src/byoc/vercel-credential-resolver.js';
import type * as VercelJwksModule from '../../src/scm-broker/vercel-jwks.js';

const syntheticIdentity = vi.hoisted(() => ({
  contract: null as VercelIdentityModule.VercelSandboxIdentityContract | null,
  key: vi.fn(),
  credential: null as byocCredentials.ByocVercelCredential | null,
}));
vi.mock('../../src/scm-broker/vercel-identity.js', async importOriginal => ({
  ...(await importOriginal<typeof VercelIdentityModule>()),
  get verifiedVercelSandboxIdentityContract() {
    return syntheticIdentity.contract;
  },
}));
vi.mock('../../src/scm-broker/vercel-jwks.js', async importOriginal => ({
  ...(await importOriginal<typeof VercelJwksModule>()),
  vercelJwksCache: { key: (...args: unknown[]) => syntheticIdentity.key(...args) },
}));
vi.mock('../../src/byoc/vercel-credential-resolver.js', async importOriginal => {
  const actual = await importOriginal<typeof byocCredentials>();
  return {
    ...actual,
    fetchByocVercelCredential: (...args: Parameters<typeof actual.fetchByocVercelCredential>) =>
      syntheticIdentity.credential ?? actual.fetchByocVercelCredential(...args),
  };
});

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_123';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_URL = 'https://control.test';
const SECRET = env.NEXTAUTH_SECRET as string;
const FACADE_BASE = runtimeCredentialProxyFacadeBaseUrl(WORKER_URL);

type FakeProvider = {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
  rebindCalls: string[];
  policyCalls: unknown[];
  stopCalls: string[];
  rebindHook: ((ref: string) => Promise<void>) | null;
  policyHook: (() => Promise<void>) | null;
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
  encryptedSecrets?: Record<string, unknown>;
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
    ...(input.encryptedSecrets === undefined
      ? {}
      : { profile: { encryptedSecrets: input.encryptedSecrets } }),
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
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    launchEnvs: [],
    rebindCalls: [],
    policyCalls: [],
    stopCalls: [],
    rebindHook: null,
    policyHook: null,
  };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, { env: launchEnv }) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopCalls.push(ref);
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async applyContainedCredentials(_ref, grants) {
      provider.policyCalls.push(grants);
      if (provider.policyHook !== null) await provider.policyHook();
    },
    async rebindOutboundInterception(ref) {
      provider.rebindCalls.push(ref);
      if (provider.rebindHook !== null) await provider.rebindHook(ref);
    },
    async logs() {
      return '';
    },
  };
  return provider;
}

async function installSandbox(
  sandboxId: string,
  provider: FakeProvider,
  broker = createFakeCredentialBroker(),
  privateKey?: string
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, broker, {
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
      WORKER_URL,
      KILOCODE_BACKEND_BASE_URL: WORKER_URL,
      KILO_OPENROUTER_BASE: WORKER_URL,
      KILO_SESSION_INGEST_URL: WORKER_URL,
      AGENT_ENV_VARS_PRIVATE_KEY: privateKey,
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
  encryptedSecrets?: Record<string, unknown>;
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
      encryptedSecrets: input.encryptedSecrets,
    }),
    message: promptPayload(messageId()),
    sandboxSelection: {
      provider: input.provider ?? 'vercel',
      ...((input.provider ?? 'vercel') === 'vercel'
        ? {
            byoc: {
              organizationId: ORG_ID,
              credentialId: '22222222-2222-4222-8222-222222222222',
            },
          }
        : {}),
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

const SYNTHETIC_VERCEL = {
  teamId: 'team-synthetic',
  projectId: 'project-synthetic',
  locator: {
    teamId: 'team-synthetic',
    projectId: 'project-synthetic',
    snapshotId: 'snapshot-synthetic',
    runtimeBuildId: 'runtime-synthetic',
    runtime: 'node24' as const,
  },
};

function setupSyntheticVercelIdentity(): ReturnType<typeof generateKeyPairSync> {
  syntheticIdentity.contract = {
    issuerForTeam: () => 'https://oidc.vercel.com/synthetic',
    sandboxIdForRef: ref => ref.sessionId,
  };
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  syntheticIdentity.key.mockResolvedValue(signing.publicKey);
  syntheticIdentity.credential = {
    userId: USER_ID,
    credentialId: '22222222-2222-4222-8222-222222222222',
    setupStatus: 'ready',
    teamId: SYNTHETIC_VERCEL.teamId,
    projectId: SYNTHETIC_VERCEL.projectId,
    teamSlug: 'synthetic',
  } as byocCredentials.ByocVercelCredential;
  return signing;
}

/** The trusted native entrypoint the Cloudflare Containers outbound Worker uses. */
function nativeOutboundFetch(
  sandboxId: string,
  allocationId: string,
  request: Request,
  requestEnv: Env
): Promise<Response> {
  return new ContainersOutbound(
    {
      props: {
        containerId: fakeOutboundContainerId(sandboxId),
        allocationRef: `mem_${allocationId}`,
      },
    } as ExecutionContext<ContainersOutboundProps>,
    requestEnv as unknown as Cloudflare.Env
  ).fetch(request);
}

function mintVercelOidc(
  sandboxId: string,
  allocationId: string,
  signing: ReturnType<typeof generateKeyPairSync>
): string {
  return jwt.sign(
    {
      iss: 'https://oidc.vercel.com/synthetic',
      aud: `${WORKER_URL}/runtime-credential-proxy/vercel/${sandboxId}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      team_id: SYNTHETIC_VERCEL.teamId,
      project_id: SYNTHETIC_VERCEL.projectId,
      sandbox_id: allocationId,
    },
    signing.privateKey,
    { algorithm: 'RS256', keyid: 'synthetic' }
  );
}

/** The real Vercel runtime HTTP route, carrying its OIDC forward proof. */
function vercelRuntimeFetch(input: {
  sandboxId: string;
  allocationId: string;
  handle: string;
  path: string;
  method: string;
  signing: ReturnType<typeof generateKeyPairSync>;
  requestEnv: Env;
}): Promise<Response> {
  const { sandboxId, allocationId, handle, path, method, signing, requestEnv } = input;
  const audience = `${WORKER_URL}/runtime-credential-proxy/vercel/${sandboxId}`;
  const oidc = mintVercelOidc(sandboxId, allocationId, signing);
  return worker.fetch(
    new Request(audience, {
      method,
      headers: {
        authorization: `Bearer ${handle}`,
        'vercel-sandbox-oidc-token': oidc,
        'vercel-forwarded-host': new URL(WORKER_URL).hostname,
        'vercel-forwarded-scheme': 'https',
        'vercel-forwarded-port': '443',
        'vercel-forwarded-path': path,
      },
    }),
    requestEnv,
    createExecutionContext()
  );
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  const value = Promise.withResolvers<void>();
  return { promise: value.promise, resolve: value.resolve, reject: value.reject };
}

function readAlarm(stub: DurableObjectStub<SandboxControlV2>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function sessionRegistration(stub: DurableObjectStub<SandboxSessionV2>): Promise<{
  spec: unknown;
  credentials: unknown;
  sandboxSelection?: unknown;
  environment?: unknown;
}> {
  return runInDurableObject(stub, instance => {
    const registration = (instance as unknown as { registration: unknown }).registration;
    if (registration === null || registration === undefined) {
      throw new Error('session registration is not available');
    }
    return registration as {
      spec: unknown;
      credentials: unknown;
      sandboxSelection?: unknown;
      environment?: unknown;
    };
  });
}

/**
 * Simulates a Worker code deploy: the running allocation survives, but the DO
 * generation (and every in-memory routing cache) is gone. The test harness must
 * reinstall its provider adapter after eviction.
 */
async function deployNewGeneration(
  sandboxId: string,
  stub: DurableObjectStub<SandboxControlV2>,
  provider: FakeProvider,
  wrapper: FakeWrapper,
  broker = createFakeCredentialBroker()
): Promise<void> {
  wrapper.close();
  await waitFor(async () => {
    expect((await stub.getAllocationState()).kind).not.toBe('connected');
  });
  await evictDurableObject(stub);
  await installSandbox(sandboxId, provider, broker);
}

type WarmRoute = {
  sessionId: string;
  kiloId: string;
  sandboxId: string;
  provider: FakeProvider;
  broker: ReturnType<typeof createFakeCredentialBroker>;
  sandboxStub: DurableObjectStub<SandboxControlV2>;
  sessionStub: DurableObjectStub<SandboxSessionV2>;
  wrapper: FakeWrapper;
  identity: { credential: string; allocationId: string };
  prepareFrame: Extract<Awaited<ReturnType<FakeWrapper['next']>>, { type: 'session.prepare' }>;
};

async function warmRoute(providerName: AgentSandboxProvider, ready: boolean): Promise<WarmRoute> {
  const sessionId = newSessionId();
  const kin = kiloSessionId();
  const sandboxId = await generateSandboxId(sessionId);
  const provider = createProvider();
  const broker = createFakeCredentialBroker();
  const sandboxStub = await installSandbox(sandboxId, provider, broker);
  const { seal, token } = await sealedRuntimeAuthorization(sessionId);
  const sessionStub = await createVercelSession({
    sessionId,
    kiloId: kin,
    sandboxId,
    kiloToken: token,
    seal,
    provider: providerName,
  });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const identity = launchIdentity(provider);
  const wrapper = await FakeWrapper.connect({ sandboxId, credential: identity.credential });
  expect(await wrapper.hello({ wrapperId: 'wr_1', allocationId: identity.allocationId })).toEqual({
    type: 'welcome',
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
  });
  const prepareFrame = await wrapper.next();
  if (prepareFrame?.type !== 'session.prepare') throw new Error('expected session.prepare');
  if (ready) {
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () =>
      expect((await sandboxStub.status({ sessionId })).view.state).toBe('ready')
    );
    const prompt = await wrapper.next();
    if (prompt?.type !== 'session.prompt') throw new Error('expected session.prompt');
  }
  return {
    sessionId,
    kiloId: kin,
    sandboxId,
    provider,
    broker,
    sandboxStub,
    sessionStub,
    wrapper,
    identity,
    prepareFrame,
  };
}

afterEach(async () => {
  syntheticIdentity.key.mockReset();
  syntheticIdentity.contract = null;
  syntheticIdentity.credential = null;
  vi.restoreAllMocks();
  await reset();
});

describe('SandboxControlV2 runtime credential proxy (R1)', () => {
  it('keeps a shared modern sibling authorized after releasing the creator and denies its deleted handle', async () => {
    const creatorId = newSessionId();
    const siblingId = newSessionId();
    const sandboxId = await generateSandboxId(creatorId);
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
    const sharedHandle = first.credentials.proxy.handle;
    // Two sibling modern sessions in one worktree share one adopted handle.
    expect(second.credentials.proxy.handle).toBe(sharedHandle);
    expect(await creator.resolveRuntimeCredentialProxyGrant(sharedHandle)).not.toBeNull();
    expect(await sibling.resolveRuntimeCredentialProxyGrant(sharedHandle)).not.toBeNull();
    await creator.deleteSession();
    // The adopted handle survives the creator's deletion: the survivor serves it.
    const afterRelease = await creator.resolveRuntimeCredentialProxyGrant(sharedHandle);
    expect(afterRelease).not.toBeNull();
    expect(afterRelease?.runtimeAuthorization.resourceId).toBe(siblingId);
    expect(await sibling.resolveRuntimeCredentialProxyGrant(sharedHandle)).not.toBeNull();
    expect((await sandbox.getAllocationState()).kind).toBe('connected');
    expect(provider.launchEnvs).toHaveLength(1);
    wrapper.send({ type: 'session.failed', sessionId: siblingId, reason: 'agent_unavailable' });
    await waitFor(async () =>
      expect((await sandbox.status({ sessionId: siblingId })).view.state).toBe('failed')
    );
    expect(await sibling.resolveRuntimeCredentialProxyGrant(sharedHandle)).toBeNull();
    await waitFor(async () =>
      expect(await sibling.getSession()).toMatchObject({ messages: [{ state: 'failed' }] })
    );
    wrapper.close();
    await waitFor(async () =>
      expect((await sandbox.getAllocationState()).kind).toBe('disconnected')
    );
  });

  it.each([
    ['cloudflare-containers', true],
    ['vercel', true],
    ['cloudflare-containers', false],
  ] as const)(
    '%s contained=%s forwards renewed authorization after JWT expiry and allocation replacement',
    async (providerName, contained) => {
      const startedAt = Date.now();
      const sessionId = newSessionId();
      const kiloId = kiloSessionId();
      const sandboxId = await generateSandboxId(sessionId);
      const provider = createProvider();
      const broker = createFakeCredentialBroker();
      const sandboxStub = await installSandbox(sandboxId, provider, broker);
      let signing: ReturnType<typeof generateKeyPairSync> | undefined;
      if (providerName === 'vercel') {
        signing = setupSyntheticVercelIdentity();
        provider.adapter.create = async intent => ({
          providerRef: JSON.stringify({
            sandboxName: intent.allocationName ?? sandboxId,
            sessionId: intent.intentId,
          }),
        });
        await sandboxStub.ensureAllocation({
          provider: 'vercel',
          byoc: {
            userId: USER_ID,
            credentialId: '22222222-2222-4222-8222-222222222222',
          },
          allocationName: sandboxId,
          locator: SYNTHETIC_VERCEL.locator,
          containment: { kilocode: true, github: true, worktreeScoped: true },
        });
      }
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
      expect(frame.spec.runtimeIsolation).toBeUndefined();
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
          mode: 'contained',
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
      const sessionIngestFetch = vi.fn(
        async (_request: Request) => new Response('Not found', { status: 404 })
      );
      const requestEnv = {
        ...env,
        WORKER_URL,
        KILOCODE_BACKEND_BASE_URL: upstream,
        KILO_OPENROUTER_BASE: upstream,
        KILO_SESSION_INGEST_URL: upstream,
        INTERNAL_API_SECRET_PROD: { get: async () => 'integration-test-secret' },
        SESSION_INGEST: { fetch: sessionIngestFetch },
      } as Env;
      const forwardOne = async (
        currentHandle: string,
        path: string,
        method: string,
        allocationId: string
      ): Promise<Response> => {
        if (providerName === 'vercel') {
          if (signing === undefined) throw new Error('missing synthetic Vercel identity');
          return vercelRuntimeFetch({
            sandboxId,
            allocationId,
            handle: currentHandle,
            path,
            method,
            signing,
            requestEnv,
          });
        }
        return nativeOutboundFetch(
          sandboxId,
          allocationId,
          new Request(`${WORKER_URL}${path}`, {
            method,
            headers: { authorization: `Bearer ${currentHandle}` },
          }),
          requestEnv
        );
      };
      const forward = async (currentHandle: string, allocationId = identity.allocationId) => {
        for (const [index, path] of paths.entries()) {
          const response = await forwardOne(
            currentHandle,
            path,
            methods[index] ?? 'GET',
            allocationId
          );
          expect(response.status).toBe(200);
          expect(await response.text()).toBe('authorized');
        }
      };
      // A public replay of a valid handle is never an origin proof.
      const publicReplay = await worker.fetch(
        new Request(`${WORKER_URL}/api/profile`, {
          headers: { authorization: `Bearer ${handle}` },
        }),
        requestEnv,
        createExecutionContext()
      );
      expect(publicReplay.status).toBe(403);
      expect(await publicReplay.text()).toBe('runtime_proxy_origin_required');
      if (providerName === 'vercel') {
        const publicVercel = await worker.fetch(
          new Request(`${WORKER_URL}/runtime-credential-proxy/vercel/${sandboxId}`, {
            headers: { authorization: `Bearer ${handle}` },
          }),
          requestEnv,
          createExecutionContext()
        );
        expect(publicVercel.status).toBe(403);
        expect(await publicVercel.text()).toBe('runtime_proxy_origin_required');
      }
      expect(destinations).toHaveLength(0);
      await forward(handle);

      await sessionStub.stop();
      wrapper.heartbeat(false);
      await waitFor(async () =>
        expect((await sandboxStub.getAllocationState()).kind).toBe('stopped')
      );
      expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).toBeNull();
      if (providerName === 'vercel') {
        await sandboxStub.ensureAllocation({
          provider: 'vercel',
          byoc: {
            userId: USER_ID,
            credentialId: '22222222-2222-4222-8222-222222222222',
          },
          allocationName: sandboxId,
          locator: SYNTHETIC_VERCEL.locator,
          containment: { kilocode: true, github: true, worktreeScoped: true },
        });
      }
      await sessionStub.send(promptPayload(messageId()));
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
      const nextEnv = provider.launchEnvs[1];
      if (!nextEnv) throw new Error('missing replacement launch environment');
      const nextAllocationId = nextEnv.CONTROL_PLANE_ALLOCATION_ID;
      if (!nextAllocationId) throw new Error('missing replacement allocation id');
      const replacement = await FakeWrapper.connect({
        sandboxId,
        credential: nextEnv.SANDBOX_CONTROL_CREDENTIAL,
      });
      await replacement.hello({
        wrapperId: 'wr_2',
        allocationId: nextAllocationId,
      });
      const nextFrame = await replacement.next();
      if (nextFrame?.type !== 'session.prepare') throw new Error('expected replacement prepare');
      const nextHandle = nextFrame.credentials?.proxy?.handle ?? '';
      expect(nextHandle === handle).toBe(false);
      expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).toBeNull();
      await forward(nextHandle, nextAllocationId);
      expect(destinations).toHaveLength(6);
      const siblingKiloSessionId = kiloSessionId();
      const siblingDenied = await forwardOne(
        nextHandle,
        `/api/session/${siblingKiloSessionId}/ingest`,
        'POST',
        nextAllocationId
      );
      expect(siblingDenied.status).toBe(404);
      expect(sessionIngestFetch).toHaveBeenCalledOnce();
      const scopedRequest = sessionIngestFetch.mock.calls[0]?.[0];
      expect(scopedRequest && new URL(scopedRequest.url).pathname).toBe(
        `/internal/cloud-agent/v1/session/${siblingKiloSessionId}/ingest`
      );
      expect(scopedRequest?.headers.get('X-Kilo-Root-Session')).toBe(kiloId);
      expect(destinations).toHaveLength(6);
      await runInDurableObject(sessionStub, async instance => {
        const authorization = await instance.ctx.storage.get<{ delegationExpiresAt: string }>(
          RUNTIME_AUTHORIZATION_KEY
        );
        expect(authorization?.delegationExpiresAt).toBe(delegationExpiresAt);
      });
      vi.mocked(Date.now).mockReturnValue(startedAt + 25 * 60 * 60_000);
      const expired = await forwardOne(nextHandle, '/api/profile', 'GET', nextAllocationId);
      expect(expired.status).toBe(401);
      expect(destinations).toHaveLength(6);

      membershipPresent = false;
      vi.mocked(Date.now).mockReturnValue(startedAt + 122 * 60_000);
      const denied = await forwardOne(nextHandle, '/api/profile', 'GET', nextAllocationId);
      expect(denied.status).toBe(503);
      expect(destinations).toHaveLength(6);
      await runInDurableObject(sessionStub, async instance => {
        expect(await instance.ctx.storage.get(RUNTIME_AUTHORIZATION_KEY)).toMatchObject({
          state: 'revoked',
        });
      });
      const revoked = await forwardOne(nextHandle, '/api/profile', 'GET', nextAllocationId);
      expect(revoked.status).toBe(503);
      expect(destinations).toHaveLength(6);
    }
  );

  it('rejects unsupported direct Vercel admission before storing or queuing the session', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId(sessionId);
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
    const sandboxId = await generateSandboxId(sessionId);
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
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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

  it('delivers a private scoped MCP grant separately from model aliases and never in launch env or persisted route specs', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId(sessionId);
    const provider = createProvider();
    const sandbox = await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    const mcpGrant = {
      url: 'https://mcp.kiloapps.io/mcp',
      token: 'private-scoped-mcp-fixture',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const sessionStub = sessions.getByName(sessionDoName(USER_ID, sessionId));
    await runInDurableObject(sandbox, instance => {
      const peerFor = instance.sessionPeerFor.bind(instance);
      instance.sessionPeerFor = (ownerId, id) => {
        const peer = peerFor(ownerId, id);
        if (!peer) return null;
        return {
          onRoute: update => peer.onRoute(update),
          onEvents: notification => peer.onEvents(notification),
          onOutcome: outcome => peer.onOutcome(outcome),
          issueRuntimeCredentialProxyGrant: fence => peer.issueRuntimeCredentialProxyGrant(fence),
          issueCloudAgentMcpGrant: async () => mcpGrant,
        };
      };
    });
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
    await wrapper.hello({ wrapperId: 'wr_scoped', allocationId });
    const frame = await wrapper.next();
    if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(frame.credentials.cloudAgentMcp).toEqual(mcpGrant);
    expect(frame.credentials.proxy?.handle).toEqual(expect.any(String));
    expect(frame.credentials.kilo.token).not.toBe(mcpGrant.token);
    expect(JSON.stringify(frame.spec)).not.toContain(mcpGrant.token);
    expect(JSON.stringify(provider.launchEnvs)).not.toContain(mcpGrant.token);
    await runInDurableObject(sandbox, instance => {
      const db = drizzle(instance.ctx.storage);
      expect(JSON.stringify(db.select().from(routesTable).all())).not.toContain(mcpGrant.token);
    });
    expect(JSON.stringify(await sessionStub.getMetadata())).not.toContain(mcpGrant.token);
    wrapper.close();
    await waitFor(async () =>
      expect((await sandbox.getAllocationState()).kind).toBe('disconnected')
    );
    mcpGrant.token = 'recovered-scoped-mcp-fixture';
    mcpGrant.expiresAt += 24 * 3600;
    const reconnected = await FakeWrapper.connect({ sandboxId, credential });
    await reconnected.hello({ wrapperId: 'wr_scoped', allocationId });
    const recovered = await reconnected.next();
    if (recovered?.type !== 'session.prepare')
      throw new Error('expected reconnected session.prepare');
    expect(recovered.credentials.cloudAgentMcp).toEqual(mcpGrant);
    expect(JSON.stringify(recovered.spec)).not.toContain(mcpGrant.token);
  });

  it.each(['rejection', 'timeout'] as const)(
    'prepares without optional MCP credentials after issuance %s and retries on reconnect',
    async failure => {
      const sessionId = newSessionId();
      const sandboxId = await generateSandboxId(sessionId);
      const provider = createProvider();
      const sandbox = await installSandbox(sandboxId, provider);
      const { seal, token } = await sealedRuntimeAuthorization(sessionId);
      const mcpGrant = {
        url: 'https://mcp.kiloapps.io/mcp',
        token: 'recovered-optional-prepare-mcp-grant',
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
      };
      let failIssuance = true;
      const issueMcpGrant = vi.fn(async () => {
        if (!failIssuance) return mcpGrant;
        if (failure === 'rejection') throw new Error(`MCP failure containing ${mcpGrant.token}`);
        return new Promise<typeof mcpGrant>(() => {});
      });
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      await runInDurableObject(sandbox, instance => {
        const peerFor = instance.sessionPeerFor.bind(instance);
        instance.sessionPeerFor = (ownerId, id) => {
          const peer = peerFor(ownerId, id);
          if (!peer) return null;
          return {
            onRoute: update => peer.onRoute(update),
            onEvents: notification => peer.onEvents(notification),
            onOutcome: outcome => peer.onOutcome(outcome),
            issueRuntimeCredentialProxyGrant: fence => peer.issueRuntimeCredentialProxyGrant(fence),
            issueCloudAgentMcpGrant: issueMcpGrant,
          };
        };
        Object.assign(instance, { grantIssueTimeoutMs: () => 100 });
      });
      const session = await createVercelSession({
        sessionId,
        kiloId: kiloSessionId(),
        sandboxId,
        kiloToken: token,
        seal,
      });
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const { credential, allocationId } = launchIdentity(provider);
      const wrapper = await FakeWrapper.connect({ sandboxId, credential });
      await wrapper.hello({ wrapperId: 'wr_optional_mcp', allocationId });
      const frame = await wrapper.next();
      if (frame?.type !== 'session.prepare' || frame.credentials === undefined)
        throw new Error('expected session.prepare credentials');
      expect(frame.credentials.cloudAgentMcp).toBeUndefined();
      expect(frame.credentials.kilo.token).toEqual(expect.any(String));
      expect(
        await session.resolveRuntimeCredentialProxyGrant(frame.credentials.proxy?.handle ?? '')
      ).not.toBeNull();
      expect(await sandbox.status({ sessionId })).toMatchObject({ view: { state: 'preparing' } });
      expect(issueMcpGrant).toHaveBeenCalledTimes(1);
      expect(fields).toHaveBeenCalledWith({ sandboxId, sessionId, anchorSessionId: sessionId });
      expect(warn).toHaveBeenCalledWith(
        'Optional Cloud Agent MCP grant unavailable; continuing without it'
      );
      expect(JSON.stringify([fields.mock.calls, warn.mock.calls])).not.toContain(mcpGrant.token);

      wrapper.close();
      await waitFor(async () =>
        expect((await sandbox.getAllocationState()).kind).toBe('disconnected')
      );
      failIssuance = false;
      const reconnected = await FakeWrapper.connect({ sandboxId, credential });
      await reconnected.hello({ wrapperId: 'wr_optional_mcp', allocationId });
      const recovered = await reconnected.next();
      if (recovered?.type !== 'session.prepare' || recovered.credentials === undefined)
        throw new Error('expected recovered session.prepare credentials');
      expect(recovered.credentials.cloudAgentMcp).toEqual(mcpGrant);
      expect(issueMcpGrant).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['before request', 'during token resolution'] as const)(
    'authorizes the model facade while disconnected %s and completes after same-wrapper reconnect',
    async disconnectAt => {
      const sessionId = newSessionId();
      const sandboxId = await generateSandboxId(sessionId);
      const provider = createProvider();
      const sandboxStub = await installSandbox(sandboxId, provider);
      const { seal, token } = await sealedRuntimeAuthorization(sessionId);
      const sessionStub = await createVercelSession({
        sessionId,
        kiloId: kiloSessionId(),
        sandboxId,
        kiloToken: token,
        seal,
        provider: 'cloudflare-containers',
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
        nativeOutboundFetch(
          sandboxId,
          allocationId,
          new Request(`${WORKER_URL}/api/openrouter/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${handle}` },
          }),
          { ...env, WORKER_URL, KILO_OPENROUTER_BASE: upstream } as Env
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
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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
    const sandboxId = await generateSandboxId(sessionId);
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
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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
    const sandboxId = await generateSandboxId(sessionId);
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
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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
    const sandboxId = await generateSandboxId(sessionId);
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
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    });
    const second = await reconnected.next();
    if (second?.type !== 'session.prepare') throw new Error('expected session.prepare');
    const secondHandle = second.credentials?.proxy?.handle ?? '';

    expect(secondHandle).toBe(firstHandle);
    expect(bindCalls).toBe(0);
  });

  it('does not send a stale handle when the fence changes between bind and send', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId(sessionId);
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
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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
    const sandboxId = await generateSandboxId(sessionId);
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
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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

describe('SandboxControlV2 runtime proxy prepare frame secrets', () => {
  const SECRET_VALUE = 'proxy-secret-value';

  function generateSecretsKeyPair() {
    return generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }

  function readRouteRow(sandboxStub: DurableObjectStub<SandboxControlV2>, sessionId: string) {
    return runInDurableObject(sandboxStub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
      return rows[0] ?? null;
    });
  }

  async function captureRouteFailures<T>(
    action: () => Promise<T>
  ): Promise<{ result: T; failures: Record<string, unknown>[] }> {
    const failures: Record<string, unknown>[] = [];
    const withFields = vi.spyOn(logger, 'withFields').mockImplementation(fields => {
      const bounded = fields as unknown as Record<string, unknown>;
      if (bounded.diagnosticEvent === 'route_failed') failures.push(bounded);
      return logger;
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = await action();
      return { result, failures };
    } finally {
      withFields.mockRestore();
      info.mockRestore();
      warn.mockRestore();
    }
  }

  it('decrypts secrets into the proxy prepare frame and never persists plaintext', async () => {
    const { publicKey, privateKey } = generateSecretsKeyPair();
    const envelope = encryptWithPublicKey(SECRET_VALUE, publicKey);
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId(sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(
      sandboxId,
      provider,
      createFakeCredentialBroker(),
      privateKey
    );
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
      encryptedSecrets: { DATABASE_URL: envelope },
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const identity = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential: identity.credential });
    expect(
      await wrapper.hello({
        wrapperId: 'wr_1',
        allocationId: identity.allocationId,
        redactsNamedSecrets: true,
      })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });

    const frame = await wrapper.next();
    if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(frame.spec.env?.DATABASE_URL).toBe(SECRET_VALUE);
    expect(frame.spec.secretEnvKeys).toEqual(['DATABASE_URL']);

    const row = await readRouteRow(sandboxStub, sessionId);
    expect(row?.spec ?? '').not.toContain(SECRET_VALUE);
    expect(row?.spec ?? '').not.toContain('secretEnvKeys');
    expect(row?.credential_source ?? '').toContain(envelope.encryptedData);
    expect(row?.credential_source ?? '').not.toContain(SECRET_VALUE);
  });

  it('fails without sending when the proxy wrapper did not advertise named-secret redaction', async () => {
    const { publicKey, privateKey } = generateSecretsKeyPair();
    const envelope = encryptWithPublicKey(SECRET_VALUE, publicKey);
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId(sessionId);
    const provider = createProvider();
    const sandboxStub = await installSandbox(
      sandboxId,
      provider,
      createFakeCredentialBroker(),
      privateKey
    );
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
      encryptedSecrets: { DATABASE_URL: envelope },
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const identity = launchIdentity(provider);
    const connected = await FakeWrapper.connect({ sandboxId, credential: identity.credential });
    const { result: wrapper, failures } = await captureRouteFailures(async () => {
      expect(
        await connected.hello({ wrapperId: 'wr_1', allocationId: identity.allocationId })
      ).toEqual({
        type: 'welcome',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      });

      await waitFor(async () => {
        expect(await sandboxStub.status({ sessionId })).toEqual({
          sessionId,
          view: {
            state: 'failed',
            attemptId: expect.any(String),
            reason: 'workspace_setup_failed',
          },
        });
      });
      return connected;
    });
    expect(failures).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'route_failed',
        reason: 'workspace_setup_failed',
        stage: 'wrapper_redaction_unsupported',
      })
    );
    expect(await wrapper.next(100)).toBeNull();
    expect(JSON.stringify(await readRouteRow(sandboxStub, sessionId))).not.toContain(SECRET_VALUE);
  });

  it('fails without sending when proxy secrets cannot be decrypted, leaking no value', async () => {
    const { publicKey } = generateSecretsKeyPair();
    const envelope = encryptWithPublicKey(SECRET_VALUE, publicKey);
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId(sessionId);
    const provider = createProvider();
    // No AGENT_ENV_VARS_PRIVATE_KEY binding: decryption fails at send time.
    const sandboxStub = await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    await createVercelSession({
      sessionId,
      kiloId: kiloSessionId(),
      sandboxId,
      kiloToken: token,
      seal,
      encryptedSecrets: { DATABASE_URL: envelope },
    });

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const identity = launchIdentity(provider);
    const connected = await FakeWrapper.connect({ sandboxId, credential: identity.credential });
    const { result: wrapper, failures } = await captureRouteFailures(async () => {
      expect(
        await connected.hello({
          wrapperId: 'wr_1',
          allocationId: identity.allocationId,
          redactsNamedSecrets: true,
        })
      ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });

      await waitFor(async () => {
        expect(await sandboxStub.status({ sessionId })).toEqual({
          sessionId,
          view: {
            state: 'failed',
            attemptId: expect.any(String),
            reason: 'workspace_setup_failed',
          },
        });
      });
      return connected;
    });
    expect(failures).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'route_failed',
        reason: 'workspace_setup_failed',
        stage: 'frame_materialization_failed',
      })
    );
    expect(await wrapper.next(100)).toBeNull();
    expect(JSON.stringify(await readRouteRow(sandboxStub, sessionId))).not.toContain(SECRET_VALUE);
  });

  it('rebinds trusted native props once per warm allocation per DO generation', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    const providerRef = (await warm.sandboxStub.getAllocationState()).providerRef;
    if (providerRef === null) throw new Error('missing provider ref');

    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );

    const reconnected = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await reconnected.hello({
        wrapperId: 'wr_1',
        allocationId: warm.identity.allocationId,
      })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(warm.provider.rebindCalls).toEqual([providerRef]));

    reconnected.close();
    await waitFor(async () =>
      expect((await warm.sandboxStub.getAllocationState()).kind).toBe('disconnected')
    );
    const sameGeneration = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await sameGeneration.hello({
        wrapperId: 'wr_1',
        allocationId: warm.identity.allocationId,
      })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(warm.provider.rebindCalls).toEqual([providerRef]);
    expect((await warm.sandboxStub.status({ sessionId: warm.sessionId })).view.state).toBe('ready');
    sameGeneration.close();
  });

  it('keeps status, Stop and interrupt responsive while a delayed warm refresh gates new work', async () => {
    const warm = await warmRoute('vercel', true);
    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );

    const gate = deferred();
    let refreshStarted = false;
    let policyRefreshes = 0;
    warm.provider.policyHook = async () => {
      policyRefreshes += 1;
      refreshStarted = true;
      await gate.promise;
    };

    const socket = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    const frames: ControlPlaneWrapperFrame[] = [];
    socket.onFrame(frame => frames.push(frame));
    expect(
      await socket.hello({ wrapperId: 'wr_1', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(refreshStarted).toBe(true));
    const registration = await sessionRegistration(warm.sessionStub);

    const queuedSend = warm.sessionStub.send(promptPayload(messageId()));
    const prepare = warm.sandboxStub.prepare({
      spec: registration.spec as never,
      credentials: registration.credentials as never,
    });
    const answer = warm.sandboxStub.answer({
      sessionId: warm.sessionId,
      reply: { action: 'permission', permissionId: 'permission_1', response: 'once' },
    });
    const deliver = warm.sandboxStub.deliver({
      sessionId: warm.sessionId,
      messages: [promptPayload(messageId())],
    });

    const startedStatus = Date.now();
    await expect(warm.sandboxStub.status({ sessionId: warm.sessionId })).resolves.toMatchObject({
      view: { state: 'ready' },
    });
    expect(Date.now() - startedStatus).toBeLessThan(1_000);

    const abort = warm.sandboxStub.abort({ sessionId: warm.sessionId });
    await expect(abort).resolves.toBe('sent');
    await expect(deliver).resolves.toBe('not_ready');
    const prepared = await prepare;
    expect(prepared.state).toBe('ready');
    await waitFor(() => expect(frames.some(frame => frame.type === 'session.abort')).toBe(true));
    expect(frames.some(frame => frame.type === 'session.prepare')).toBe(false);
    expect(frames.some(frame => frame.type === 'session.prompt')).toBe(false);
    expect(frames.some(frame => frame.type === 'session.answer')).toBe(false);
    let answerSettled = false;
    void answer.finally(() => {
      answerSettled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(answerSettled).toBe(false);

    gate.resolve();
    await queuedSend;
    await expect(answer).resolves.toBe('sent');
    await waitFor(() =>
      expect(
        frames.some(frame => frame.type === 'session.prompt' && frame.sessionId === warm.sessionId)
      ).toBe(true)
    );
    await waitFor(() => expect(frames.some(frame => frame.type === 'session.answer')).toBe(true));

    await expect(
      warm.sandboxStub.deliver({
        sessionId: warm.sessionId,
        messages: [promptPayload(messageId())],
      })
    ).resolves.toBe('sent');
    await expect(
      warm.sandboxStub.answer({
        sessionId: warm.sessionId,
        reply: { action: 'permission', permissionId: 'permission_1', response: 'once' },
      })
    ).resolves.toBe('sent');

    socket.close();
    await waitFor(async () =>
      expect((await warm.sandboxStub.getAllocationState()).kind).toBe('disconnected')
    );
    const sameGeneration = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await sameGeneration.hello({
        wrapperId: 'wr_1',
        allocationId: warm.identity.allocationId,
      })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(policyRefreshes).toBe(1);
    sameGeneration.close();
  });

  it('retries a transient warm refresh on the short alarm and resumes the pending prepare', async () => {
    const warm = await warmRoute('cloudflare-containers', false);
    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );

    let attempts = 0;
    warm.provider.rebindHook = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient provider failure');
    };

    const socket = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    const frames: ControlPlaneWrapperFrame[] = [];
    socket.onFrame(frame => frames.push(frame));
    expect(
      await socket.hello({ wrapperId: 'wr_1', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(attempts).toBe(1));

    // The preparing route has a long attempt deadline; the refresh retry must
    // still arm a short alarm rather than waiting for that deadline.
    const retryAt = await readAlarm(warm.sandboxStub);
    expect(retryAt).not.toBeNull();
    expect(retryAt!).toBeLessThanOrEqual(Date.now() + 3_000);
    expect(frames.some(frame => frame.type === 'session.prepare')).toBe(false);

    await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt! - Date.now()) + 25));
    await runInDurableObject(warm.sandboxStub, instance => instance.alarm());
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() =>
      expect(
        frames.some(
          frame => frame.type === 'session.prepare' && frame.spec.sessionId === warm.sessionId
        )
      ).toBe(true)
    );
    socket.close();
  });

  it('notifies a pending ready route after a transient warm refresh failure', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );

    const updates: Array<{ sessionId: string; update: unknown }> = [];
    await runInDurableObject(warm.sandboxStub, instance => {
      const peerFor = instance.sessionPeerFor.bind(instance);
      instance.sessionPeerFor = (ownerId, sessionId) => {
        const peer = peerFor(ownerId, sessionId);
        return peer === null
          ? null
          : {
              ...peer,
              onRoute: async update => {
                updates.push({ sessionId, update });
                return peer.onRoute(update);
              },
            };
      };
    });
    let attempts = 0;
    warm.provider.rebindHook = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient provider failure');
    };

    const socket = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await socket.hello({ wrapperId: 'wr_1', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(attempts).toBe(1));
    expect(
      updates.some(
        entry =>
          entry.sessionId === warm.sessionId &&
          (entry.update as { state?: string }).state === 'ready'
      )
    ).toBe(false);

    const retryAt = await readAlarm(warm.sandboxStub);
    if (retryAt === null) throw new Error('missing refresh retry alarm');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 25));
    await runInDurableObject(warm.sandboxStub, instance => instance.alarm());
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() =>
      expect(
        updates.some(
          entry =>
            entry.sessionId === warm.sessionId &&
            (entry.update as { state?: string }).state === 'ready'
        )
      ).toBe(true)
    );
    socket.close();
  });

  it('fences a superseding hello without losing the first hello restart effects', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );

    const gate = deferred();
    let refreshStarted = false;
    warm.provider.rebindHook = async () => {
      refreshStarted = true;
      await gate.promise;
    };

    const superseded = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    // The persisted wrapper id belongs to the previous generation, so this
    // hello is a restart.
    expect(
      await superseded.hello({ wrapperId: 'wr_2', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(refreshStarted).toBe(true));

    const current = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await current.hello({ wrapperId: 'wr_2', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    const frames: ControlPlaneWrapperFrame[] = [];
    current.onFrame(frame => frames.push(frame));

    gate.resolve();
    await waitFor(() =>
      expect(
        frames.some(
          frame => frame.type === 'session.prepare' && frame.spec.sessionId === warm.sessionId
        )
      ).toBe(true)
    );
    expect(superseded.receivedFrames()).toBe(1);
    expect((await warm.sandboxStub.status({ sessionId: warm.sessionId })).view.state).toBe(
      'preparing'
    );
    current.close();
  });

  it('drains a Session-queued prompt after the routing cache resets without a new hello', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    const frames: ControlPlaneWrapperFrame[] = [];
    warm.wrapper.onFrame(frame => frames.push(frame));

    // Eviction waits for active WebSocket requests in this harness. Reset only
    // the routing cache to exercise hibernated-socket recovery without a hello.
    await runInDurableObject(warm.sandboxStub, instance => {
      const ready: unknown = Reflect.get(instance, 'warmOriginRoutingReady');
      if (!(ready instanceof Set)) throw new Error('missing warm routing cache');
      ready.clear();
    });

    const gate = deferred();
    let refreshStarted = false;
    warm.provider.rebindHook = async () => {
      refreshStarted = true;
      await gate.promise;
    };
    const message = messageId();
    const queued = warm.sessionStub.send(promptPayload(message));
    await waitFor(() => expect(refreshStarted).toBe(true));
    await queued;
    expect(
      frames.some(frame => frame.type === 'session.prompt' && frame.payload.messageId === message)
    ).toBe(false);

    const releasedAt = Date.now();
    gate.resolve();
    await waitFor(() =>
      expect(
        frames.some(frame => frame.type === 'session.prompt' && frame.payload.messageId === message)
      ).toBe(true)
    );
    expect(Date.now() - releasedAt).toBeLessThan(2_000);
    warm.wrapper.close();
  });

  it('refreshes a restored native binding from a heartbeat without a new hello or work', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    const providerRef = (await warm.sandboxStub.getAllocationState()).providerRef;
    if (providerRef === null) throw new Error('missing provider ref');
    const frames: ControlPlaneWrapperFrame[] = [];
    warm.wrapper.onFrame(frame => frames.push(frame));

    // Eviction waits for active WebSocket requests in this harness. Clear only
    // the routing cache to model a new DO generation that kept the hibernated
    // wrapper socket.
    await runInDurableObject(warm.sandboxStub, instance => {
      const ready: unknown = Reflect.get(instance, 'warmOriginRoutingReady');
      if (!(ready instanceof Set)) throw new Error('missing warm routing cache');
      ready.clear();
    });

    warm.wrapper.heartbeat(false);
    await waitFor(() => expect(warm.provider.rebindCalls).toEqual([providerRef]));

    // The successful refresh is the cache entry: later idle alarms and
    // heartbeats must not probe the provider again.
    await runInDurableObject(warm.sandboxStub, instance => instance.alarm());
    warm.wrapper.heartbeat(false);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(warm.provider.rebindCalls).toEqual([providerRef]);
    expect(
      frames.some(frame => frame.type === 'session.prepare' || frame.type === 'session.prompt')
    ).toBe(false);
    warm.wrapper.close();
  });

  it('migrates a restored Vercel policy from the alarm without a new hello or work', async () => {
    const warm = await warmRoute('vercel', true);
    const policyCallsBefore = warm.provider.policyCalls.length;
    const frames: ControlPlaneWrapperFrame[] = [];
    warm.wrapper.onFrame(frame => frames.push(frame));

    await runInDurableObject(warm.sandboxStub, instance => {
      const ready: unknown = Reflect.get(instance, 'warmOriginRoutingReady');
      if (!(ready instanceof Set)) throw new Error('missing warm routing cache');
      ready.clear();
    });

    await runInDurableObject(warm.sandboxStub, instance => instance.alarm());
    await waitFor(() => expect(warm.provider.policyCalls.length).toBe(policyCallsBefore + 1));

    await runInDurableObject(warm.sandboxStub, instance => instance.alarm());
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(warm.provider.policyCalls.length).toBe(policyCallsBefore + 1);
    expect(
      frames.some(frame => frame.type === 'session.prepare' || frame.type === 'session.prompt')
    ).toBe(false);
    warm.wrapper.close();
  });

  it('retains restart revocation and route recovery after a failed refresh and eviction', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    const oldHandle = warm.prepareFrame.credentials.proxy?.handle;
    if (!oldHandle) throw new Error('missing runtime proxy handle');
    await waitFor(async () =>
      expect(await warm.sessionStub.resolveRuntimeCredentialProxyGrant(oldHandle)).not.toBeNull()
    );

    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );
    const gate = deferred();
    let refreshStarted = false;
    warm.provider.rebindHook = async () => {
      refreshStarted = true;
      await gate.promise;
    };

    const restarted = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await restarted.hello({ wrapperId: 'wr_2', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(refreshStarted).toBe(true));
    // Restart effects are durable before the refresh can succeed or the DO can
    // be evicted: the old handle is already revoked.
    await waitFor(async () =>
      expect(await warm.sessionStub.resolveRuntimeCredentialProxyGrant(oldHandle)).toBeNull()
    );

    gate.reject(new Error('provider unavailable'));
    restarted.close();
    await waitFor(async () => {
      expect((await warm.sandboxStub.getAllocationState()).kind).toBe('disconnected');
      expect(
        await runInDurableObject(warm.sandboxStub, instance =>
          Reflect.get(instance, 'warmOriginRoutingFlight')
        )
      ).toBeNull();
    });
    await evictDurableObject(warm.sandboxStub);
    await installSandbox(warm.sandboxId, warm.provider, warm.broker);
    expect(await warm.sessionStub.resolveRuntimeCredentialProxyGrant(oldHandle)).toBeNull();

    // The new generation sees the already-persisted wr_2, so this hello is not
    // a restart. Recovery must not depend on the in-memory pending hello.
    warm.provider.rebindHook = null;
    const recovered = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    const frames: ControlPlaneWrapperFrame[] = [];
    recovered.onFrame(frame => frames.push(frame));
    expect(
      await recovered.hello({ wrapperId: 'wr_2', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() =>
      expect(
        frames.some(
          frame => frame.type === 'session.prepare' && frame.spec.sessionId === warm.sessionId
        )
      ).toBe(true)
    );
    expect((await warm.sandboxStub.status({ sessionId: warm.sessionId })).view.state).toBe(
      'preparing'
    );
    recovered.close();
  });

  it('stops the bound allocation after three consecutive warm refresh failures', async () => {
    const warm = await warmRoute('cloudflare-containers', true);
    const providerRef = (await warm.sandboxStub.getAllocationState()).providerRef;
    if (providerRef === null) throw new Error('missing provider ref');
    await deployNewGeneration(
      warm.sandboxId,
      warm.sandboxStub,
      warm.provider,
      warm.wrapper,
      warm.broker
    );

    let attempts = 0;
    warm.provider.rebindHook = async () => {
      attempts += 1;
      throw new Error('provider rebind unavailable');
    };
    const updates: Array<{ sessionId: string; update: unknown }> = [];
    await runInDurableObject(warm.sandboxStub, instance => {
      const peerFor = instance.sessionPeerFor.bind(instance);
      instance.sessionPeerFor = (ownerId, sessionId) => {
        const peer = peerFor(ownerId, sessionId);
        return peer === null
          ? null
          : {
              ...peer,
              onRoute: async update => {
                updates.push({ sessionId, update });
                return peer.onRoute(update);
              },
            };
      };
    });

    const socket = await FakeWrapper.connect({
      sandboxId: warm.sandboxId,
      credential: warm.identity.credential,
    });
    expect(
      await socket.hello({ wrapperId: 'wr_1', allocationId: warm.identity.allocationId })
    ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    await waitFor(() => expect(attempts).toBe(1));

    for (let failure = 2; failure <= 3; failure += 1) {
      const retryAt = await readAlarm(warm.sandboxStub);
      if (retryAt === null) throw new Error('missing refresh retry alarm');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 25));
      await runInDurableObject(warm.sandboxStub, instance => instance.alarm());
      await waitFor(() => expect(attempts).toBe(failure));
    }

    await waitFor(async () => {
      expect(warm.provider.stopCalls).toEqual([providerRef]);
      const kind = (await warm.sandboxStub.getAllocationState()).kind;
      expect(kind === 'stopping' || kind === 'stopped').toBe(true);
    });
    await waitFor(async () => {
      expect(await warm.sessionStub.getSession()).toMatchObject({
        messages: [{ state: 'failed' }],
      });
    });
    expect(updates).toContainEqual({
      sessionId: warm.sessionId,
      update: {
        state: 'lost',
        attemptId: expect.any(String),
        reason: 'sandbox_lost',
      },
    });
    expect(warm.provider.launchEnvs).toHaveLength(1);
    socket.close();
  });
});

describe('wrapper history pages', () => {
  async function setupHistory() {
    const sessionId = newSessionId();
    const kiloId = kiloSessionId();
    const sandboxId = await generateSandboxId(sessionId);
    const provider = createProvider();
    await installSandbox(sandboxId, provider);
    const { seal, token } = await sealedRuntimeAuthorization(sessionId);
    const sessionStub = await createVercelSession({
      sessionId,
      kiloId,
      sandboxId,
      kiloToken: token,
      seal,
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);
    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_history', allocationId });
    const frame = await wrapper.next();
    if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    await runInDurableObject(sessionStub, (_instance, state) => {
      markHistoryHydrated(state.storage);
    });
    async function readPage(input: {
      sessionId?: string;
      kiloSessionId?: string;
      cursor?: string;
    }) {
      const requestId = crypto.randomUUID();
      wrapper.send({
        type: 'history.page',
        requestId,
        sessionId: input.sessionId ?? sessionId,
        kiloSessionId: input.kiloSessionId ?? kiloId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      for (;;) {
        const result = await wrapper.next(5_000);
        if (result === null) throw new Error('expected history.result');
        if (result.type === 'history.result' && result.requestId === requestId) return result;
      }
    }
    return { sessionId, kiloId, sessionStub, readPage };
  }

  it('serves a cold page, then every page of seeded native history', async () => {
    const { sessionId, kiloId, sessionStub, readPage } = await setupHistory();
    expect(await readPage({})).toMatchObject({
      ok: true,
      page: { kind: 'success', info: { id: kiloId }, messages: [], nextCursor: null },
    });

    const source = {
      version: 'v2',
      session: {
        id: kiloId,
        location: { directory: `/workspace/${sessionId}` },
        time: { created: 1, updated: 2 },
      },
    };
    const ids = Array.from({ length: 101 }, () => messageId());
    await sessionStub.onEvents({
      events: [
        { type: 'conversation.source', properties: { sessionID: kiloId, source } },
        ...ids.map((id, index) => ({
          type: 'conversation.message.updated',
          properties: {
            sessionID: kiloId,
            source,
            message: { id, type: 'user', time: { created: index + 1 }, text: `prompt ${index}` },
          },
        })),
      ],
    });

    const read: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await readPage({ cursor });
      if (!result.ok) throw new Error(result.error.code);
      const page = result.page as {
        source: { version: string };
        messages: Array<{ message: { id: string } }>;
        nextCursor: string | null;
      };
      expect(page.source.version).toBe('v2');
      read.push(...page.messages.map(item => item.message.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(read.toSorted()).toEqual(ids.toSorted());
  });

  it('rejects sessions this sandbox does not host and cursors of another session', async () => {
    const { readPage } = await setupHistory();
    const other = await setupHistory();
    expect(await readPage({ sessionId: newSessionId() })).toMatchObject({
      ok: false,
      error: { code: 'not_found', retryable: false },
    });
    expect(await readPage({ kiloSessionId: kiloSessionId() })).toMatchObject({
      ok: false,
      error: { code: 'not_found', retryable: false },
    });
    // The other sandbox's route is not hosted here, even with its own identity.
    expect(
      await readPage({ sessionId: other.sessionId, kiloSessionId: other.kiloId })
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await readPage({ cursor: 'not-a-cursor' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });
});
