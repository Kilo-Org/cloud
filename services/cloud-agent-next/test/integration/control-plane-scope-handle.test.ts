import { readRoute } from '../../src/control-plane/sandbox/routes.js';
import {
  RUNTIME_CONTRACT_KEY,
  readRuntimeContract,
} from '../../src/control-plane/sandbox/runtime-contract.js';
import { runInDurableObject, env, reset } from 'cloudflare:test';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { routes } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { controlPlaneRouteSpecSchema } from '../../src/shared/control-plane-protocol.js';
import { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from '../../src/runtime-credential-proxy.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../../src/session/runtime-authorization-persistence.js';
import {
  addAcceptedHandleSync,
  digestRuntimeProxyHandle,
  type AcceptedHandleFence,
  type ScopeHandleResolution,
} from '../../src/control-plane/sandbox/accepted-handles.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import type { AgentSandboxProvider } from '../../src/types.js';
import type { ProviderAdapter, StopResult } from '../../src/sandbox-control/provider.js';
import {
  createFakeCredentialBroker,
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
const OTHER_USER_ID = 'user_other';
const ORG_ID = 'org_123';
const WORKER_URL = 'https://control.test';
const SECRET = env.NEXTAUTH_SECRET as string;

let sequence = 0;
function newSessionId(): string {
  sequence += 1;
  return `workspace_${crypto.randomUUID()}`;
}
function kiloSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}
function messageId(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

function metadata(input: {
  sessionId: string;
  kiloSessionIdValue: string;
  sandboxId: string;
  kiloToken: string;
  worktreeId?: string;
}) {
  const directory = input.worktreeId ?? input.sessionId;
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
      ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
      workspacePath: `/workspace/${directory}`,
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: 'vercel' as AgentSandboxProvider,
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

async function sealedRuntimeAuthorization(
  sessionId: string,
  delegationMs = 24 * 60 * 60_000,
  tokenExpMs = 60 * 60_000
): Promise<{ seal: string; token: string; authorizationId: string; delegationExpiresAt: string }> {
  const now = Date.now();
  const delegationExpiresAt = new Date(now + delegationMs).toISOString();
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
      exp: Math.floor((now + tokenExpMs) / 1000),
    },
    SECRET
  );
  return { seal, token, authorizationId, delegationExpiresAt };
}

type FakeProvider = { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] };
function createProvider(): FakeProvider {
  const provider: FakeProvider = { adapter: null as unknown as ProviderAdapter, launchEnvs: [] };
  provider.adapter = {
    persistentWorkspace: false,
    destroysOnStop: true,
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
    async stop() {
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
    async applyContainedCredentials() {},
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

async function createSession(input: {
  sessionId: string;
  kiloId: string;
  sandboxId: string;
  kiloToken: string;
  seal?: string;
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
      ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    }),
    message: {
      messageId: messageId(),
      turn: { type: 'prompt', prompt: 'hello' },
      agent: { mode: 'code', model: 'test/model' },
    },
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

type Member = {
  sessionId: string;
  kiloId: string;
  directory: string;
  runtimeIsolation: 'per-session' | undefined;
  stub: DurableObjectStub<SandboxSessionV2>;
  handle: string;
  token: string;
};

/**
 * A connected sandbox with a shared worktree scope. The creator is prepared
 * first, then each extra member joins the same scope on the same wrapper.
 */
async function createSharedScope(
  memberCount: number,
  options: { allocation?: 'existing'; wrapper?: 'legacy' | 'worktree' } = {}
) {
  const worktreeId = `worktree_${crypto.randomUUID()}`;
  const creatorId = newSessionId();
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, creatorId);
  const provider = createProvider();
  const sandbox = await installSandbox(sandboxId, provider);

  const memberIds = [creatorId];
  for (let index = 1; index < memberCount; index += 1) memberIds.push(newSessionId());
  const auths = await Promise.all(memberIds.map(id => sealedRuntimeAuthorization(id)));

  const creatorKiloId = kiloSessionId();
  const creator = await createSession({
    sessionId: creatorId,
    kiloId: creatorKiloId,
    sandboxId,
    kiloToken: auths[0]!.token,
    seal: auths[0]!.seal,
    worktreeId,
  });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const { credential, allocationId } = launchIdentity(provider);
  if (options.allocation === 'existing') {
    await runInDurableObject(sandbox, instance => {
      instance.ctx.storage.kv.delete(RUNTIME_CONTRACT_KEY);
    });
  }
  const wrapper = await FakeWrapper.connect({
    sandboxId,
    credential,
    runtimeContract: options.wrapper,
  });
  await wrapper.hello({ wrapperId: 'wr_1', allocationId });

  const members: Member[] = [];
  for (let index = 0; index < memberIds.length; index += 1) {
    const sessionId = memberIds[index]!;
    const kiloId = index === 0 ? creatorKiloId : kiloSessionId();
    const stub =
      index === 0
        ? creator
        : await createSession({
            sessionId,
            kiloId,
            sandboxId,
            kiloToken: auths[index]!.token,
            seal: auths[index]!.seal,
            worktreeId,
          });
    let frame = await wrapper.next();
    if (frame?.type === 'worktree.snapshot') {
      wrapper.send({
        type: 'worktree.result',
        requestId: frame.requestId,
        ok: false,
        error: { code: 'snapshot_unavailable', message: 'fixture', retryable: false },
      });
      frame = await wrapper.next();
    }
    if (frame?.type !== 'session.prepare') throw new Error(`expected prepare, got ${frame?.type}`);
    const handle = frame.credentials?.proxy?.handle ?? '';
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () =>
      expect((await sandbox.status({ sessionId })).view.state).toBe('ready')
    );
    await wrapper.next();
    members.push({
      sessionId,
      kiloId,
      directory: frame.spec.directory,
      runtimeIsolation: frame.spec.runtimeIsolation,
      stub,
      handle,
      token: auths[index]!.token,
    });
  }

  const scopeGrantId = `${worktreeId}:runtime`;
  return { sandbox, provider, wrapper, sandboxId, worktreeId, scopeGrantId, members };
}

async function currentFence(
  sandbox: DurableObjectStub<SandboxControlV2>
): Promise<AcceptedHandleFence> {
  const state = await sandbox.getAllocationState();
  if (
    state.allocationId === null ||
    state.connectionId === null ||
    state.providerRef === null ||
    state.wrapperId === null
  ) {
    throw new Error('fence is not connected');
  }
  return {
    plane: 'control',
    allocationId: state.allocationId,
    providerInstanceId: state.providerRef,
    connectionId: state.connectionId,
    wrapperInstanceId: state.wrapperId,
  };
}

async function seedAccepted(
  sandbox: DurableObjectStub<SandboxControlV2>,
  scopeGrantId: string,
  handle: string,
  issuer: Member,
  fence: AcceptedHandleFence,
  exp = Date.now() + 3_600_000
): Promise<void> {
  const handleDigest = await digestRuntimeProxyHandle(handle);
  const scopeId = scopeGrantId.split(':')[0] ?? scopeGrantId;
  await runInDurableObject(sandbox, instance => {
    addAcceptedHandleSync(instance.ctx.storage.kv, scopeGrantId, {
      handleDigest,
      handle,
      issuerSessionId: issuer.sessionId,
      scopeId,
      exp,
      fence,
    });
  });
}

async function setAuthorizationState(
  stub: DurableObjectStub<SandboxSessionV2>,
  state: 'revoked' | 'active'
): Promise<void> {
  await runInDurableObject(stub, async instance => {
    const raw = await instance.ctx.storage.get<Record<string, unknown>>(RUNTIME_AUTHORIZATION_KEY);
    if (raw) await instance.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, { ...raw, state });
  });
}

function resolveHandle(
  sandbox: DurableObjectStub<SandboxControlV2>,
  handle: string
): Promise<ScopeHandleResolution> {
  return sandbox.resolveScopeHandle({ handle });
}

afterEach(async () => {
  await reset();
});

describe('canonical handle adoption', () => {
  it('shares one adopted handle across siblings and the joiner carries the issuer session', async () => {
    const { members } = await createSharedScope(2);
    const [creator, sibling] = members;
    expect(sibling!.handle).toBe(creator!.handle);
    const claims = jwt.decode(creator!.handle) as { sessionId?: string } | null;
    expect(claims?.sessionId).toBe(creator!.sessionId);
  });
});

describe('rolling runtime compatibility', () => {
  it.each([
    { label: 'old wrapper', options: { wrapper: 'legacy' as const } },
    {
      label: 'existing allocation with a new wrapper',
      options: { allocation: 'existing' as const },
    },
  ])('keeps separate credentials for $label and admits siblings', async ({ options }) => {
    const { sandbox, provider, sandboxId, wrapper, members } = await createSharedScope(2, options);
    const [first, second] = members;
    expect(first!.runtimeIsolation).toBe('per-session');
    expect(second!.runtimeIsolation).toBe('per-session');
    expect(first!.handle).not.toBe(second!.handle);
    expect(jwt.decode(first!.handle)).toMatchObject({ sessionId: first!.sessionId });
    expect(jwt.decode(second!.handle)).toMatchObject({ sessionId: second!.sessionId });
    await runInDurableObject(sandbox, async (instance, state) => {
      const restored = new SandboxControlV2(state, instance.env);
      Object.assign(restored, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
      expect((await restored.getAllocationState()).kind).toBe('connected');
      for (const member of members) {
        expect((await restored.status({ sessionId: member.sessionId })).view.state).toBe('ready');
      }
    });
    const { credential, allocationId } = launchIdentity(provider);
    // A newer wrapper reconnecting to this allocation must not enable sharing.
    wrapper.close();
    await waitFor(async () =>
      expect((await sandbox.getAllocationState()).kind).toBe('disconnected')
    );
    const replacement = await FakeWrapper.connect({ sandboxId, credential });
    expect((await replacement.hello({ wrapperId: 'wr_1', allocationId }))?.type).toBe('welcome');
    await runInDurableObject(sandbox, instance => {
      expect(readRuntimeContract(instance.ctx.storage.kv, allocationId)).toBe('legacy');
    });
    expect((await sandbox.status({ sessionId: first!.sessionId })).view.state).toBe('ready');
    expect((await sandbox.status({ sessionId: second!.sessionId })).view.state).toBe('ready');
    replacement.close();
  });

  it('enables sharing when an old allocation ends through its normal lifecycle', async () => {
    const { sandbox, provider, sandboxId, members } = await createSharedScope(2, {
      wrapper: 'legacy',
    });
    const inputs = await runInDurableObject(sandbox, async (_instance, state) => {
      const db = drizzle(state.storage);
      return Promise.all(
        members.map(async member => {
          const route = await readRoute(db, member.sessionId);
          if (!route?.credentialSource) throw new Error('missing route');
          const { kilo: _kilo, ...spec } = route.spec;
          const git = spec.git;
          return {
            spec: {
              ...spec,
              ...(git
                ? { git: { url: git.url, ...(git.platform ? { platform: git.platform } : {}) } }
                : {}),
            },
            credentials: route.credentialSource,
          };
        })
      );
    });
    await sandbox.reportProviderGone();
    await sandbox.prepare(inputs[0]!);
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    const launch = provider.launchEnvs[1]!;
    const replacement = await FakeWrapper.connect({
      sandboxId,
      credential: launch.SANDBOX_CONTROL_CREDENTIAL!,
    });
    await replacement.hello({
      wrapperId: 'wr_2',
      allocationId: launch.CONTROL_PLANE_ALLOCATION_ID!,
    });
    let canonical: string | undefined;
    for (const [index, input] of inputs.entries()) {
      if (index > 0) await sandbox.prepare(input);
      const frame = await replacement.nextSkipping(['worktree.snapshot']);
      if (frame?.type !== 'session.prepare')
        throw new Error(`expected prepare, got ${frame?.type}`);
      expect(frame.spec.runtimeIsolation).toBeUndefined();
      expect(frame.credentials?.proxy?.handle).toBeTruthy();
      if (index === 0) canonical = frame.credentials?.proxy?.handle;
      else expect(frame.credentials?.proxy?.handle).toBe(canonical);
      replacement.send({ type: 'session.ready', sessionId: input.spec.sessionId });
      await waitFor(async () =>
        expect((await sandbox.status({ sessionId: input.spec.sessionId })).view.state).toBe('ready')
      );
    }
    expect(canonical).not.toBe(members[0]!.handle);
    replacement.close();
  });

  it('rejects an older reconnect without replacing a working shared wrapper', async () => {
    const { sandbox, provider, sandboxId, members } = await createSharedScope(2);
    expect(members[0]!.runtimeIsolation).toBeUndefined();
    const { credential, allocationId } = launchIdentity(provider);
    const incompatible = await FakeWrapper.connect({
      sandboxId,
      credential,
      runtimeContract: 'legacy',
    });
    expect(await incompatible.hello({ wrapperId: 'old', allocationId })).toMatchObject({
      type: 'shutdown',
      reason: 'hello_rejected',
    });
    expect((await sandbox.getAllocationState()).wrapperId).toBe('wr_1');
    expect((await sandbox.status({ sessionId: members[0]!.sessionId })).view.state).toBe('ready');
    expect(members[0]!.handle).toBe(members[1]!.handle);
  });
});

describe('adopted-handle proxy scope view', () => {
  it('reads only member identities without parsing unrelated routes or credentials', async () => {
    const { sandbox, worktreeId, members } = await createSharedScope(2);
    const [creator, sibling] = members;
    if (!creator || !sibling) throw new Error('Expected two scope members');
    await runInDurableObject(sandbox, (_instance, state) => {
      const db = drizzle(state.storage);
      db.insert(routes)
        .values({
          session_id: 'unrelated',
          spec: 'invalid JSON',
          credential_source: 'invalid JSON',
          state: 'ready',
          attempt_id: 'unrelated',
          updated_at: Date.now(),
        })
        .run();
      db.update(routes)
        .set({ credential_source: 'invalid JSON' })
        .where(eq(routes.session_id, sibling.sessionId))
        .run();
    });
    const fence = await sandbox.getRuntimeCredentialProxyFence({
      ownerId: USER_ID,
      sessionId: creator.sessionId,
      kiloSessionId: creator.kiloId,
      directory: creator.directory,
      handle: creator.handle,
    });
    expect(fence?.scopeView).toEqual({
      scopeId: worktreeId,
      expectedOrganizationId: ORG_ID,
      memberRootKiloSessionIds: [creator.kiloId, sibling.kiloId],
    });
  });

  it.each(['failed', 'missing', 'wrong-kilo', 'wrong-directory'])(
    'excludes a %s member from the current scope view',
    async condition => {
      const { sandbox, members } = await createSharedScope(2);
      const [creator, sibling] = members;
      if (!creator || !sibling) throw new Error('Expected two scope members');
      const input = {
        ownerId: USER_ID,
        sessionId: creator.sessionId,
        kiloSessionId: creator.kiloId,
        directory: creator.directory,
        handle: creator.handle,
      };
      expect(
        (await sandbox.getRuntimeCredentialProxyFence(input))?.scopeView?.memberRootKiloSessionIds
      ).toEqual([creator.kiloId, sibling.kiloId]);
      await runInDurableObject(sandbox, (_instance, state) => {
        const db = drizzle(state.storage);
        const where = eq(routes.session_id, sibling.sessionId);
        if (condition === 'missing') db.delete(routes).where(where).run();
        else if (condition === 'failed')
          db.update(routes).set({ state: 'failed' }).where(where).run();
        else {
          const row = db.select({ spec: routes.spec }).from(routes).where(where).get();
          if (!row) throw new Error('Expected the member route');
          const spec = controlPlaneRouteSpecSchema.parse(JSON.parse(row.spec));
          db.update(routes)
            .set({
              spec: JSON.stringify({
                ...spec,
                kiloSessionId: condition === 'wrong-kilo' ? kiloSessionId() : sibling.kiloId,
                directory: condition === 'wrong-directory' ? '/workspace/other' : input.directory,
              }),
            })
            .where(where)
            .run();
        }
      });
      expect(
        (await sandbox.getRuntimeCredentialProxyFence(input))?.scopeView?.memberRootKiloSessionIds
      ).toEqual([creator.kiloId]);
    }
  );
});

describe('SandboxControlV2 scope-handle resolution', () => {
  it('denies a handle that is not in the accepted set', async () => {
    const { sandbox, members } = await createSharedScope(2);
    const issuer = members[0]!;
    const fence = await currentFence(sandbox);
    const unattached = createRuntimeProxyGrant({
      plane: 'control',
      authorizationId: crypto.randomUUID(),
      sessionId: issuer.sessionId,
      kiloSessionId: issuer.kiloId,
      userId: USER_ID,
      orgId: ORG_ID,
      mode: 'direct',
      allocationId: fence.allocationId,
      providerInstanceId: fence.providerInstanceId,
      connectionId: fence.connectionId,
      wrapperInstanceId: fence.wrapperInstanceId,
      leaseExpiresAt: Date.now() + 3_600_000,
      state: 'active',
    });
    const handle = await issueRuntimeCredentialProxyHandle(env, unattached);
    const outcome = await resolveHandle(sandbox, handle);
    expect(outcome).toEqual({ type: 'denied' });
  });

  it('denies a handle for a different user without returning a sibling token', async () => {
    const { sandbox, members, scopeGrantId } = await createSharedScope(2);
    const [issuer] = members;
    const fence = await currentFence(sandbox);
    const grant = createRuntimeProxyGrant({
      plane: 'control',
      authorizationId: crypto.randomUUID(),
      sessionId: issuer!.sessionId,
      kiloSessionId: issuer!.kiloId,
      userId: OTHER_USER_ID,
      orgId: ORG_ID,
      mode: 'direct',
      allocationId: fence.allocationId,
      providerInstanceId: fence.providerInstanceId,
      connectionId: fence.connectionId,
      wrapperInstanceId: fence.wrapperInstanceId,
      leaseExpiresAt: Date.now() + 3_600_000,
      state: 'active',
    });
    const foreignHandle = await issueRuntimeCredentialProxyHandle(env, grant);
    const handleDigest = await digestRuntimeProxyHandle(foreignHandle);
    await runInDurableObject(sandbox, instance => {
      addAcceptedHandleSync(instance.ctx.storage.kv, scopeGrantId, {
        handleDigest,
        issuerSessionId: issuer!.sessionId,
        scopeId: scopeGrantId.split(':')[0] ?? scopeGrantId,
        exp: Date.now() + 3_600_000,
        fence,
      });
    });

    const outcome = await resolveHandle(sandbox, foreignHandle);
    expect(outcome).toEqual({ type: 'denied' });
  });

  it('serves through a sibling when the issuer is locally revoked', async () => {
    const { sandbox, members, scopeGrantId } = await createSharedScope(2);
    const [creator, sibling] = members;
    await seedAccepted(
      sandbox,
      scopeGrantId,
      creator!.handle,
      creator!,
      await currentFence(sandbox)
    );
    await setAuthorizationState(creator!.stub, 'revoked');

    const outcome = await resolveHandle(sandbox, creator!.handle);
    expect(outcome.type).toBe('served');
    if (outcome.type !== 'served') throw new Error('expected served');
    expect(outcome.token).toBe(sibling!.token);
    expect(outcome.runtimeAuthorization.resourceId).toBe(sibling!.sessionId);
    expect(outcome.organizationId).toBe(ORG_ID);
  });
});
