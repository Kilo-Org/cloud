import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { routes as routesTable } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import { WORKTREE_CREDENTIAL_CONTAINMENT } from '../../src/sandbox-control/credential-containment.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import {
  controlPlanePrepareInputSchema,
  type ControlPlaneCredentialSource,
  type ControlPlanePrepareInput,
  type ControlPlaneRouteSpec,
  type ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  fakeOutboundContainerId,
  installFakeCredentialEnv,
  type FakeCredentialBroker,
} from './helpers/fake-credentials.js';
import { createRuntimeProxyMintingPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const SANDBOX_ID = 'sbx__control_v2_credentials';
const SESSION = 'workspace_11111111-1111-1111-1111-111111111111';
const SESSION_NEXT = 'workspace_22222222-2222-2222-2222-222222222222';
const OUTBOUND_CONTAINER_ID = fakeOutboundContainerId(SANDBOX_ID);
const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
const NATIVE_GIT_TOKEN = 'ghp_nativeGittoken0000000000000000000000';
const VERCEL_TARGET = 'https://worker.example.com';
const TIMERS = CONTROL_PLANE_TIMERS.sandbox;

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxNamespace = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;

type FakeProvider = {
  adapter: ProviderAdapter;
  refs: string[];
  launchEnvs: Record<string, string>[];
  policyCalls: unknown[];
  /** Wrapper frames received at the moment each policy update was applied. */
  policyFrameCounts: number[];
  framesSeen: () => number;
  /** When set, `updateNetworkPolicy` blocks on this until the test resolves it. */
  policyGate: { promise: Promise<void>; resolve: () => void } | null;
  policyBlocked: boolean;
  failPolicy: boolean;
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    refs: [],
    launchEnvs: [],
    policyCalls: [],
    policyFrameCounts: [],
    framesSeen: () => 0,
    policyGate: null,
    policyBlocked: false,
    failPolicy: false,
  };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      const ref = encodeCloudflareProviderRef({
        sandboxId: intent.allocationName ?? SANDBOX_ID,
        containment: true,
        instanceId: intent.intentId,
      });
      provider.refs.push(ref);
      return { providerRef: ref };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(): Promise<StopResult> {
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async updateNetworkPolicy(_ref, policy) {
      if (provider.failPolicy) throw new Error('network policy update failed');
      if (provider.policyGate) {
        provider.policyBlocked = true;
        await provider.policyGate.promise;
        provider.policyBlocked = false;
      }
      provider.policyCalls.push(policy);
      provider.policyFrameCounts.push(provider.framesSeen());
    },
    async logs() {
      return '';
    },
  };
  return provider;
}

function kiloSessionIdFor(sessionId: string): string {
  return sessionId === SESSION_NEXT
    ? 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb'
    : 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
}

function b64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** A Kilo token that decodes to `runtimeAuthorization`, enabling the Vercel runtime proxy. */
function runtimeAuthorizedKiloToken(): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ runtimeAuthorization: { id: 'ra_1' } }));
  return `${header}.${payload}.sig`;
}

function credentialsSource(
  sessionId: string,
  options: {
    userId?: string;
    kiloToken?: string;
    repository?: ControlPlaneCredentialSource['repository'];
  } = {}
): ControlPlaneCredentialSource {
  return {
    userId: options.userId ?? 'user_123',
    kiloSessionId: kiloSessionIdFor(sessionId),
    kiloToken: options.kiloToken ?? NATIVE_KILO_TOKEN,
    orgId: 'org_123',
    repository: options.repository ?? { type: 'github', repo: 'acme/widgets' },
    scopeId: sessionId,
  };
}

function routeSpec(sessionId: string): ControlPlaneRouteSpec {
  // The input spec must carry no credential material: git and kilo come from the
  // issued grant (B3 review 2, N3).
  return {
    sessionId,
    kiloSessionId: kiloSessionIdFor(sessionId),
    directory: `/workspace/${sessionId}`,
    attemptId: `${sessionId}-requested`,
  };
}

function prepareInput(
  sessionId: string,
  source: ControlPlaneCredentialSource = credentialsSource(sessionId),
  spec: ControlPlaneRouteSpec = routeSpec(sessionId)
): ControlPlanePrepareInput {
  return { spec, credentials: source };
}

function promptPayload(messageId: string) {
  return {
    messageId,
    turn: { type: 'prompt' as const, prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

function readRouteRow(stub: DurableObjectStub<SandboxControlV2>, sessionId: string) {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    return rows[0] ?? null;
  });
}

async function patchGrant(
  stub: DurableObjectStub<SandboxControlV2>,
  sessionId: string,
  patch: (grant: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    const row = rows[0];
    if (row === undefined || row.grant === null) throw new Error('route has no grant');
    const grant = patch(JSON.parse(row.grant) as Record<string, unknown>);
    await db
      .update(routesTable)
      .set({ grant: JSON.stringify(grant) })
      .where(eq(routesTable.session_id, sessionId));
  });
}

function setGrantExpiry(
  stub: DurableObjectStub<SandboxControlV2>,
  sessionId: string,
  expiresAt: number
): Promise<void> {
  return patchGrant(stub, sessionId, grant => ({ ...grant, expiresAt }));
}

async function setup(
  provider: FakeProvider,
  broker: FakeCredentialBroker = createFakeCredentialBroker(),
  extraEnv: Record<string, unknown> = {}
): Promise<DurableObjectStub<SandboxControlV2>> {
  const stub = sandboxNamespace.getByName(SANDBOX_ID);
  // R1: a Vercel route with a runtime proxy now mints a handle on the first
  // connected `session.prepare`; the fake Session peer mints a verifiable one.
  const sessionPeer = createRuntimeProxyMintingPeer(env, sessionId => ({
    userId: 'user_123',
    kiloSessionId: kiloSessionIdFor(sessionId),
  }));
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    // This suite asserts contained grants; keep containment on by default so the
    // local `.dev.vars` value cannot change what each test means.
    installFakeCredentialEnv(instance.env, broker, {
      CREDENTIAL_CONTAINMENT_ENABLED: 'true',
      ...extraEnv,
    });
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
      sessionPeerFor: (_ownerId: string, sessionId: string) => sessionPeer(sessionId),
    });
  });
  return stub;
}

/** Prepare a route, connect a wrapper and drive it ready. Returns its prepare frame. */
async function prepareWarmRoute(
  stub: DurableObjectStub<SandboxControlV2>,
  provider: FakeProvider,
  input: ControlPlanePrepareInput = prepareInput(SESSION)
): Promise<{
  wrapper: FakeWrapper;
  prepareFrame: ControlPlaneWrapperFrame | null;
  credential: string;
  allocationId: string;
}> {
  const view = await stub.prepare(input);
  expect(view).toEqual({ state: 'preparing', attemptId: expect.any(String) });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv) throw new Error('provider.launch was not called');
  const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
  expect(await wrapper.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
    type: 'welcome',
    protocolVersion: 2,
  });
  const prepareFrame = await wrapper.next();
  wrapper.send({ type: 'session.ready', sessionId: input.spec.sessionId });
  await waitFor(async () => {
    expect(await stub.status({ sessionId: input.spec.sessionId })).toEqual({
      sessionId: input.spec.sessionId,
      view: { state: 'ready', attemptId: expect.any(String) },
    });
  });
  return { wrapper, prepareFrame, credential, allocationId };
}

/** A source that enables the Vercel runtime proxy (Kilo token with runtimeAuthorization). */
function vercelSource(sessionId: string): ControlPlaneCredentialSource {
  return credentialsSource(sessionId, {
    kiloToken: runtimeAuthorizedKiloToken(),
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
  });
}

async function setupVercel(
  provider: FakeProvider,
  broker: FakeCredentialBroker
): Promise<DurableObjectStub<SandboxControlV2>> {
  const stub = await setup(provider, broker, {
    WORKER_URL: VERCEL_TARGET,
    KILOCODE_BACKEND_BASE_URL: VERCEL_TARGET,
    KILO_OPENROUTER_BASE: VERCEL_TARGET,
    KILO_SESSION_INGEST_URL: VERCEL_TARGET,
  });
  await runInDurableObject(stub, async instance => {
    await instance.ensureAllocation({
      provider: 'vercel',
      allocationName: SANDBOX_ID,
      containment: WORKTREE_CREDENTIAL_CONTAINMENT,
    });
  });
  return stub;
}

afterEach(async () => {
  await reset();
});

describe('SandboxControlV2 credentials (B3)', () => {
  it('cold prepare on the default provider issues a grant and starts the sandbox', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);

    const view = await stub.prepare(prepareInput(SESSION));
    expect(view).toEqual({ state: 'preparing', attemptId: expect.any(String) });

    // The route and its grant exist before the sandbox is created, and the cold
    // prepare must not throw on the missing provider ref (B3 review 1).
    const row = await readRouteRow(stub, SESSION);
    expect(row?.state).toBe('preparing');
    expect(row?.grant).not.toBeNull();
    const grant = JSON.parse(row?.grant ?? '{}') as { outboundContainerId?: string };
    expect(grant.outboundContainerId).toBe(OUTBOUND_CONTAINER_ID);

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const state = await stub.getAllocationState();
    expect(state.kind).not.toBe('stopped');
  });

  it('honours CREDENTIAL_CONTAINMENT_ENABLED=false with a containment-off selection', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker, { CREDENTIAL_CONTAINMENT_ENABLED: 'false' });
    const source = credentialsSource(SESSION, {
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
    });

    const view = await stub.prepare({
      ...prepareInput(SESSION, source),
      sandboxSelection: { provider: 'cloudflare', containment: { kilocode: false, github: false } },
    });
    expect(view).toEqual({ state: 'preparing', attemptId: expect.any(String) });

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      containmentEnabled?: boolean;
      kilo?: { alias?: string };
    };
    // Uncontained: no alias is minted and the grant opts out of containment.
    expect(grant.containmentEnabled).toBe(false);
    expect(grant.kilo?.alias).toBeUndefined();
  });

  it('stays contained when the selection carries containment on', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker, { CREDENTIAL_CONTAINMENT_ENABLED: 'true' });
    const source = credentialsSource(SESSION, {
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
    });

    await stub.prepare({
      ...prepareInput(SESSION, source),
      sandboxSelection: { provider: 'cloudflare', containment: { kilocode: true, github: true } },
    });

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      containmentEnabled?: boolean;
      kilo?: { alias?: string };
    };
    expect(grant.containmentEnabled).toBeUndefined();
    expect(grant.kilo?.alias).toBeDefined();
  });

  it('falls back to CREDENTIAL_CONTAINMENT_ENABLED when the selection omits containment', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker, { CREDENTIAL_CONTAINMENT_ENABLED: 'false' });
    const source = credentialsSource(SESSION, {
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
    });

    await stub.prepare(prepareInput(SESSION, source));

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      containmentEnabled?: boolean;
    };
    expect(grant.containmentEnabled).toBe(false);
  });

  it('derives the outbound container id from a custom allocation name while stopped', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);

    // A pin whose allocation name differs from the sandbox id (cutover/explicit
    // ensure), then a provider-gone leaves the DO stopped with that pin.
    await runInDurableObject(stub, instance =>
      instance.ensureAllocation({ allocationName: 'custom_alloc' })
    );
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    await stub.reportProviderGone();
    await waitFor(async () => expect((await stub.getAllocationState()).kind).toBe('stopped'));

    const view = await stub.prepare(prepareInput(SESSION));
    expect(view).toEqual({ state: 'preparing', attemptId: expect.any(String) });
    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      outboundContainerId?: string;
    };
    // Must match the name create will use for this same pin (N1), not sandboxId.
    expect(grant.outboundContainerId).toBe(fakeOutboundContainerId('custom_alloc'));
  });

  it('sends issued aliases in session.prepare and never the credential source', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);

    const { prepareFrame } = await prepareWarmRoute(stub, provider);

    expect(prepareFrame?.type).toBe('session.prepare');
    const serialized = JSON.stringify(prepareFrame);
    expect(serialized).not.toContain(NATIVE_KILO_TOKEN);
    expect(serialized).not.toContain(NATIVE_GIT_TOKEN);
    expect(serialized).not.toContain('user_123');
    expect(serialized).not.toContain('repository');
    expect(serialized).not.toContain('"userId"');

    if (prepareFrame?.type !== 'session.prepare') throw new Error('missing prepare frame');
    expect(prepareFrame.credentials?.kilo.token).toMatch(/^kcp1\./);
    expect(prepareFrame.credentials?.git?.token).toMatch(/^kcp1\./);
    expect(prepareFrame.credentials?.git?.platform).toBe('github');
    expect(prepareFrame.spec.kilo?.token).toBe(prepareFrame.credentials?.kilo.token);
    expect(prepareFrame.spec.env?.KILOCODE_TOKEN).toMatch(/^kcp1\./);
    expect(prepareFrame.spec.env?.GH_TOKEN).toMatch(/^kcp1\./);
    expect(prepareFrame.credentials?.sessionId).toBe(SESSION);

    const row = await readRouteRow(stub, SESSION);
    expect(row?.credential_source).toContain(kiloSessionIdFor(SESSION));
    const grant = JSON.parse(row?.grant ?? '{}') as {
      kilo: { alias: string; token: string };
    };
    expect(grant.kilo.token).toBe(NATIVE_KILO_TOKEN);
    expect(grant.kilo.alias).toBe(prepareFrame.credentials?.kilo.token);
    expect(broker.kiloIssued()).toBe(1);
    expect(broker.githubIssued()).toBe(1);
  });

  it('re-issues below one hour with fresh tokens and sends session.credentials before prompts', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    const { wrapper } = await prepareWarmRoute(stub, provider);

    const first = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };
    const firstAlias = first.kilo.alias;
    expect(broker.kiloIssued()).toBe(1);

    await setGrantExpiry(stub, SESSION, Date.now() + TIMERS.credentialGrantReissueBelowMs / 2);

    const result = await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] });
    expect(result).toBe('sent');

    const credentialsFrame = await wrapper.next();
    expect(credentialsFrame?.type).toBe('session.credentials');
    const promptFrame = await wrapper.next();
    expect(promptFrame?.type).toBe('session.prompt');

    const refreshed = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
      expiresAt: number;
    };
    expect(refreshed.kilo.alias).not.toBe(firstAlias);
    expect(broker.kiloIssued()).toBe(2);
    expect(broker.githubIssued()).toBe(2);
    expect(refreshed.expiresAt - Date.now()).toBeGreaterThan(TIMERS.credentialGrantReissueBelowMs);
    if (credentialsFrame?.type !== 'session.credentials') throw new Error('missing frame');
    expect(credentialsFrame.kilo.token).toBe(refreshed.kilo.alias);
    expect(credentialsFrame.sessionId).toBe(SESSION);
  });

  it('resolves contained outbound credentials for a routed session and rejects unknown/expired/mutated', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    await prepareWarmRoute(stub, provider);

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string; targets: { backendBaseUrl: string } };
    };
    const alias = grant.kilo.alias;
    const url = `${grant.kilo.targets.backendBaseUrl}/api/user`;

    const resolved = await stub.resolveCredential({
      credential: alias,
      outboundContainerId: OUTBOUND_CONTAINER_ID,
      url,
      method: 'GET',
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.credential).toMatch(/^kka1\./);
    expect(resolved?.organizationId).toBe('org_123');

    // Unknown, mutated (same purpose and scope, different suffix) and wrong
    // container all fail closed.
    expect(
      await stub.resolveCredential({
        credential: 'kcp1.unknown.scope.kilo.xyz',
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url,
        method: 'GET',
      })
    ).toBeNull();
    expect(
      await stub.resolveCredential({
        credential: `${alias.slice(0, -1)}${alias.endsWith('a') ? 'b' : 'a'}`,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url,
        method: 'GET',
      })
    ).toBeNull();
    expect(
      await stub.resolveCredential({
        credential: alias,
        outboundContainerId: 'oc_other',
        url,
        method: 'GET',
      })
    ).toBeNull();

    await setGrantExpiry(stub, SESSION, Date.now() - 1_000);
    expect(
      await stub.resolveCredential({
        credential: alias,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url,
        method: 'GET',
      })
    ).toBeNull();
  });

  it('revokes the grant on release and rejects the stale alias afterwards', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    const { wrapper } = await prepareWarmRoute(stub, provider);

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string; targets: { backendBaseUrl: string } };
    };
    const alias = grant.kilo.alias;
    const url = `${grant.kilo.targets.backendBaseUrl}/api/user`;
    expect(
      await stub.resolveCredential({
        credential: alias,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url,
        method: 'GET',
      })
    ).not.toBeNull();

    await stub.release({ sessionId: SESSION });

    expect(await readRouteRow(stub, SESSION)).toBeNull();
    expect(await stub.status({ sessionId: SESSION })).toEqual({
      sessionId: SESSION,
      view: { state: 'unknown' },
    });
    expect(
      await stub.resolveCredential({
        credential: alias,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url,
        method: 'GET',
      })
    ).toBeNull();
    expect(await wrapper.next()).toEqual({ type: 'session.release', sessionId: SESSION });
  });

  it('re-issues Vercel grants with the runtime-proxy members and applies policy before credentials', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    const { wrapper } = await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, vercelSource(SESSION), routeSpec(SESSION))
    );

    const member = {
      sessionId: SESSION,
      kiloSessionId: kiloSessionIdFor(SESSION),
      handle: 'handle_1',
    };
    await patchGrant(stub, SESSION, grant => ({
      ...grant,
      kilo: {
        ...(grant.kilo as Record<string, unknown>),
        runtimeProxy: {
          ...((grant.kilo as Record<string, unknown>).runtimeProxy as Record<string, unknown>),
          members: [member],
        },
      },
    }));
    const first = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };
    const firstAlias = first.kilo.alias;
    provider.policyCalls.length = 0;
    provider.policyFrameCounts.length = 0;
    // Count frames received so the policy timing is observable.
    provider.framesSeen = () => wrapper.receivedFrames();
    const framesBeforeDeliver = wrapper.receivedFrames();

    await setGrantExpiry(stub, SESSION, Date.now() + TIMERS.credentialGrantReissueBelowMs / 2);
    // Block the policy application: no credential frame may arrive until it is
    // applied (proves the order, not just that a frame eventually appeared).
    const gate = createDeferred();
    provider.policyGate = gate;
    const deliverPromise = stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] });
    await waitFor(() => expect(provider.policyBlocked).toBe(true));
    expect(await wrapper.next(100)).toBeNull();
    gate.resolve();
    provider.policyGate = null;
    expect(await deliverPromise).toBe('sent');

    const refreshed = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: {
        alias: string;
        runtimeProxy?: { members: Array<{ handle: string }> };
      };
    };
    // Fresh alias, but the bound runtime-proxy handle survives the re-issue.
    expect(refreshed.kilo.alias).not.toBe(firstAlias);
    expect(refreshed.kilo.runtimeProxy?.members).toEqual([member]);
    // The policy was rebuilt from the candidate grant (with the carried
    // runtime-proxy handle) before the `session.credentials` frame.
    expect(provider.policyCalls.length).toBe(1);
    expect(JSON.stringify(provider.policyCalls[0])).toContain('handle_1');

    const credentialsFrame = await wrapper.next();
    expect(credentialsFrame?.type).toBe('session.credentials');
    expect(
      credentialsFrame && 'kilo' in credentialsFrame ? credentialsFrame.kilo.token : null
    ).toBe(refreshed.kilo.alias);
    // R1: the runtime-proxy handle and facade targets travel in the
    // `session.credentials` payload too, not the route spec.
    expect(credentialsFrame && 'proxy' in credentialsFrame ? credentialsFrame.proxy : null).toEqual(
      {
        handle: 'handle_1',
        targets: expect.objectContaining({ backendBaseUrl: VERCEL_TARGET }),
      }
    );
    // credentials + the one prompt.
    expect(wrapper.receivedFrames()).toBe(framesBeforeDeliver + 2);
  });

  it('keeps a Vercel route ready and delivers on the old grant when re-issue policy fails', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    const { wrapper } = await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, vercelSource(SESSION), routeSpec(SESSION))
    );
    await setGrantExpiry(stub, SESSION, Date.now() + TIMERS.credentialGrantReissueBelowMs / 2);
    const framesBefore = wrapper.receivedFrames();
    const grantBefore = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };

    provider.failPolicy = true;
    const result = await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] });

    // The still-due previous grant carries the prompts: no `session.credentials`
    // frame is sent, the prompt is delivered, and the route stays `ready` so the
    // next send retries the re-issue.
    expect(result).toBe('sent');
    expect(await wrapper.next()).toMatchObject({ type: 'session.prompt', sessionId: SESSION });
    expect(wrapper.receivedFrames()).toBe(framesBefore + 1);
    expect(await stub.status({ sessionId: SESSION })).toEqual({
      sessionId: SESSION,
      view: { state: 'ready', attemptId: expect.any(String) },
    });
    // The failed policy did not persist the unsent grant (N4).
    const grantAfterFailure = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };
    expect(grantAfterFailure.kilo.alias).toBe(grantBefore.kilo.alias);

    // Recovery: a later send retries the re-issue and sends the fresh frame
    // before the prompt.
    provider.failPolicy = false;
    const retry = await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m2')] });
    expect(retry).toBe('sent');
    const credentialsFrame = await wrapper.next();
    expect(credentialsFrame?.type).toBe('session.credentials');
    const grantAfterRetry = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };
    expect(grantAfterRetry.kilo.alias).not.toBe(grantBefore.kilo.alias);
    if (credentialsFrame?.type !== 'session.credentials') throw new Error('missing frame');
    expect(credentialsFrame.kilo.token).toBe(grantAfterRetry.kilo.alias);
  });

  it('fails the route as workspace_setup_failed when re-issue policy fails and the old grant expired', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    const { wrapper } = await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, vercelSource(SESSION), routeSpec(SESSION))
    );
    // The re-issue window is only entered while the previous grant is still due;
    // push it past expiry so the failure has no usable grant to fall back on.
    await setGrantExpiry(stub, SESSION, Date.now() - 1);
    const framesBefore = wrapper.receivedFrames();
    const grantBefore = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };
    provider.policyCalls.length = 0;

    provider.failPolicy = true;
    const result = await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] });

    // No usable grant and no frame: the route leaves `ready` so the Session DO
    // fails its queued messages with the real reason instead of waiting for the
    // 20-minute backstop.
    expect(result).toBe('not_ready');
    expect(await stub.status({ sessionId: SESSION })).toEqual({
      sessionId: SESSION,
      view: {
        state: 'failed',
        attemptId: expect.any(String),
        reason: 'workspace_setup_failed',
      },
    });
    expect((await stub.getAllocationState()).kind).toBe('connected');
    expect(provider.policyCalls.length).toBe(0);
    expect(await wrapper.next(50)).toBeNull();
    expect(wrapper.receivedFrames()).toBe(framesBefore);
    // The previous (already-applied) grant is kept; the failed policy did not
    // persist the unsent grant (N4).
    const grantAfterFailure = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      kilo: { alias: string };
    };
    expect(grantAfterFailure.kilo.alias).toBe(grantBefore.kilo.alias);
  });

  it('stops the sandbox as a platform failure when a Vercel release cannot apply the policy', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, vercelSource(SESSION), routeSpec(SESSION))
    );

    provider.failPolicy = true;
    await stub.release({ sessionId: SESSION });

    // The alias could not be removed, so the sandbox must stop (fail closed as
    // `sandbox_lost`, a platform failure).
    const state = await stub.getAllocationState();
    expect(state.kind === 'stopping' || state.kind === 'stopped').toBe(true);
    expect(await readRouteRow(stub, SESSION)).toBeNull();
  });

  it('rejects prepare without a credential source and never emits raw material', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);

    expect(controlPlanePrepareInputSchema.safeParse({ spec: routeSpec(SESSION) }).success).toBe(
      false
    );
    // N3: the input spec must not carry `git.token` or `kilo`. The shared schema
    // documents the contract, but the live `stub.prepare` path is authoritative:
    // this is what catches a DO that stops applying the shared schema.
    const specWithGitToken = {
      ...routeSpec(SESSION),
      git: { url: 'https://github.com/acme/widgets.git', token: NATIVE_GIT_TOKEN },
    };
    expect(
      controlPlanePrepareInputSchema.safeParse({
        spec: specWithGitToken,
        credentials: credentialsSource(SESSION),
      }).success
    ).toBe(false);
    const specWithKilo = {
      ...routeSpec(SESSION),
      kilo: {
        scopeId: SESSION,
        token: NATIVE_KILO_TOKEN,
        targets: {
          backendBaseUrl: 'https://api.kilo.ai',
          providerBaseUrl: 'https://api.kilo.ai',
          sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
        },
      },
    };
    expect(
      controlPlanePrepareInputSchema.safeParse({
        spec: specWithKilo,
        credentials: credentialsSource(SESSION),
      }).success
    ).toBe(false);

    // Call inside the DO so the expected rejection does not surface as an
    // unhandled RPC rejection in the Workers test runtime.
    const rejects = (spec: unknown, credentials?: unknown) =>
      runInDurableObject(stub, async instance => {
        try {
          await instance.prepare({
            spec,
            ...(credentials === undefined ? {} : { credentials }),
          } as unknown as ControlPlanePrepareInput);
          return false;
        } catch {
          return true;
        }
      });
    expect(await rejects(specWithGitToken, credentialsSource(SESSION))).toBe(true);
    expect(await rejects(specWithKilo, credentialsSource(SESSION))).toBe(true);
    // Missing credentials is rejected by the same live path.
    expect(await rejects(routeSpec(SESSION))).toBe(true);
    expect(await readRouteRow(stub, SESSION)).toBeNull();
    expect(provider.launchEnvs).toHaveLength(0);
  });

  it('rejects a different owner and fails a cross-scope directory collision', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    await prepareWarmRoute(stub, provider);

    const rejected = await runInDurableObject(stub, async instance => {
      try {
        await instance.prepare(
          prepareInput(SESSION_NEXT, credentialsSource(SESSION_NEXT, { userId: 'user_other' }))
        );
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
    expect(await readRouteRow(stub, SESSION_NEXT)).toBeNull();

    // Same working directory under a different credential scope must fail.
    const colliding = { ...routeSpec(SESSION_NEXT), directory: `/workspace/${SESSION}` };
    const view = await stub.prepare(
      prepareInput(SESSION_NEXT, credentialsSource(SESSION_NEXT), colliding)
    );
    expect(view).toEqual({
      state: 'failed',
      attemptId: expect.any(String),
      reason: 'workspace_setup_failed',
    });
    const row = await readRouteRow(stub, SESSION_NEXT);
    expect(row?.state).toBe('failed');
  });

  it('fails only the route whose issuance fails and still prepares a later route', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const original = broker.issueGitHubSessionCapability.bind(broker);
    // Fail issuance for the first route only; issuance is not retried.
    let failing = true;
    broker.issueGitHubSessionCapability = () => {
      if (failing) return Promise.reject(new Error('git-token-service unavailable'));
      return original();
    };
    const stub = await setup(provider, broker);

    const failed = await stub.prepare(prepareInput(SESSION));
    expect(failed).toEqual({
      state: 'failed',
      attemptId: expect.any(String),
      reason: 'workspace_setup_failed',
    });
    const failedRow = await readRouteRow(stub, SESSION);
    expect(failedRow?.state).toBe('failed');
    expect(failedRow?.grant).toBeNull();

    // The next route still gets an attempt and a grant.
    failing = false;
    const next = await stub.prepare(prepareInput(SESSION_NEXT));
    expect(next).toEqual({ state: 'preparing', attemptId: expect.any(String) });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const nextRow = await readRouteRow(stub, SESSION_NEXT);
    expect(nextRow?.state).toBe('preparing');
    expect(nextRow?.grant).not.toBeNull();
  });

  it('retries a transient policy failure inside the attempt instead of failing the route', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    // Warm the sandbox so the next attempt's policy is applied against a running
    // provider; a cold prepare has no provider ref to update.
    await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, vercelSource(SESSION), routeSpec(SESSION))
    );

    // The provider credential policy refresh fails once, then succeeds.
    provider.failPolicy = true;
    const update = provider.adapter.updateNetworkPolicy!.bind(provider.adapter);
    provider.adapter.updateNetworkPolicy = async (ref, policy) => {
      if (provider.failPolicy) {
        provider.failPolicy = false;
        throw new Error('network policy update failed');
      }
      return update(ref, policy);
    };

    const { prepareFrame } = await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION_NEXT, vercelSource(SESSION_NEXT), routeSpec(SESSION_NEXT))
    );
    expect(prepareFrame?.type).toBe('session.prepare');
  });

  it('bounds the credential-policy retry to one retry (two attempts)', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, vercelSource(SESSION), routeSpec(SESSION))
    );

    // A persistent policy failure is retried once, then fails the route. Each
    // attempt is one policy update, so two attempts means exactly two updates.
    let policyUpdates = 0;
    provider.adapter.updateNetworkPolicy = async () => {
      policyUpdates += 1;
      throw new Error('network policy update failed');
    };

    const failed = await stub.prepare(
      prepareInput(SESSION_NEXT, vercelSource(SESSION_NEXT), routeSpec(SESSION_NEXT))
    );
    expect(failed).toEqual({
      state: 'failed',
      attemptId: expect.any(String),
      reason: 'workspace_setup_failed',
    });
    expect(policyUpdates).toBe(2);
  });

  it('fails the route at once when grant issuance throws, without retrying', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    // A permanent/validation issuance error: retrying a hung issuer would hold
    // the serial queue, so issuance is attempted exactly once.
    let issueCalls = 0;
    broker.issueGitHubSessionCapability = () => {
      issueCalls += 1;
      return Promise.reject(new Error('git-token-service unavailable'));
    };
    const stub = await setup(provider, broker);

    const failed = await stub.prepare(prepareInput(SESSION));
    expect(failed).toEqual({
      state: 'failed',
      attemptId: expect.any(String),
      reason: 'workspace_setup_failed',
    });
    expect(issueCalls).toBe(1);
  });

  it('bounds a hung grant issuance and releases the queue when it times out', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const original = broker.issueGitHubSessionCapability.bind(broker);
    let hang = true;
    broker.issueGitHubSessionCapability = () => {
      if (hang) return new Promise<never>(() => {});
      return original();
    };
    const stub = await setup(provider, broker);
    // Production uses the 30 s provider-stop bound; shorten it for the test.
    await runInDurableObject(stub, instance => {
      Object.assign(instance, { grantIssueTimeoutMs: () => 200 });
    });

    const started = Date.now();
    const view = await stub.prepare(prepareInput(SESSION));
    const elapsed = Date.now() - started;
    expect(view).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(5_000);
    expect((await readRouteRow(stub, SESSION))?.state).toBe('failed');

    // The serial queue is free: deliver, a later prepare, and alarm are prompt.
    hang = false;
    const queueStarted = Date.now();
    expect(await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] })).toBe(
      'not_ready'
    );
    expect((await stub.prepare(prepareInput(SESSION_NEXT))).state).toBe('preparing');
    await runInDurableObject(stub, instance => instance.alarm());
    expect(Date.now() - queueStarted).toBeLessThan(5_000);
  });

  it('does not persist raw issuer material on a failed route', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    broker.issueGitHubSessionCapability = () =>
      Promise.reject(new Error('git-token-service unavailable'));
    const stub = await setup(provider, broker);

    await stub.prepare(prepareInput(SESSION));
    const row = await readRouteRow(stub, SESSION);
    expect(row?.state).toBe('failed');
    expect(JSON.stringify(row?.spec)).not.toContain(NATIVE_KILO_TOKEN);
    expect(JSON.stringify(row?.spec)).not.toContain(NATIVE_GIT_TOKEN);
    expect(row?.credential_source).toBeNull();
  });

  it('continues the restart loop when re-issuance fails for one route', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    const { wrapper, credential, allocationId } = await prepareWarmRoute(stub, provider);

    // A sibling route is already preparing on the same sandbox.
    await stub.prepare(prepareInput(SESSION_NEXT));
    const siblingPrepare = await wrapper.next();
    expect(siblingPrepare?.type).toBe('session.prepare');

    // Fail the next issuance (the ready route's restart re-mint).
    broker.issueGitHubSessionCapability = () =>
      Promise.reject(new Error('git-token-service unavailable'));
    wrapper.close();
    await waitFor(async () => expect((await stub.getAllocationState()).kind).toBe('disconnected'));
    const wrapper2 = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    expect(await wrapper2.hello({ wrapperId: 'wr_2', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });

    // The failing route is marked failed; the loop still serves the sibling.
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('failed'));
    const next = await wrapper2.next();
    expect(next?.type).toBe('session.prepare');
    if (next?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(next.spec.sessionId).toBe(SESSION_NEXT);
  });
});
