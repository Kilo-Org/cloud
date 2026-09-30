import { env, reset, runInDurableObject } from 'cloudflare:test';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ControlPlaneSessionPeer,
  SandboxControlV2,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { runtimeCredentialProxyFacadeBaseUrl } from '../../src/runtime-credential-proxy.js';
import type { ProviderAdapter, StopResult } from '../../src/sandbox-control/provider.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;
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
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: 'vercel',
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
): Promise<{ seal: string; token: string; authorizationId: string }> {
  const now = Date.now();
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
      delegationExpiresAt: new Date(now + 60 * 60_000).toISOString(),
      state: 'active',
      bindings: { userPepperDigest: 'null', authorizationPepperDigest: 'null' },
      source: { admissionSource: 'user' },
    },
    SECRET
  );
  const token = jwt.sign(
    {
      runtimeAuthorization: { id: authorizationId },
      exp: Math.floor((now + 30 * 60_000) / 1000),
    },
    SECRET
  );
  return { seal, token, authorizationId };
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
  provider: FakeProvider
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, createFakeCredentialBroker(), {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
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
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  const sessionStub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  await sessionStub.createSessionWithInitialAdmission({
    metadata: metadata({
      sessionId: input.sessionId,
      kiloSessionIdValue: input.kiloId,
      sandboxId: input.sandboxId,
      kiloToken: input.kiloToken,
    }),
    message: promptPayload(messageId()),
    sandboxSelection: { provider: 'vercel' },
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
  await reset();
});

describe('SandboxControlV2 runtime credential proxy (R1)', () => {
  it('mints a handle on the connected prepare, projects it into the credentials, and resolves it', async () => {
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

  it('keeps the handle valid across a socket reconnect (same wrapperId)', async () => {
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

    wrapper.close();
    await waitFor(async () => {
      expect((await sandboxStub.getAllocationState()).kind).toBe('disconnected');
    });
    const reconnected = await FakeWrapper.connect({ sandboxId, credential });
    expect(await reconnected.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });

    // The fence ignores connectionId, so the same handle still authorizes.
    expect(await sessionStub.resolveRuntimeCredentialProxyGrant(handle)).not.toBeNull();
  });

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
