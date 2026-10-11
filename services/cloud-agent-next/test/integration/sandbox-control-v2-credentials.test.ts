import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import migrations from '../../src/control-plane/sandbox/drizzle/migrations.js';
import {
  routes as routesTable,
  allocation as allocationTable,
  scopeGrants,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import { readScopeGrant } from '../../src/control-plane/sandbox/scope-grants.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
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
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlaneCredentialSource,
  type ControlPlanePrepareInput,
  type ControlPlaneRouteSpec,
  type ControlPlaneRouteUpdate,
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
  /** Create intents, in call order, so tests can assert the resolved containment. */
  intents: ProviderCreateIntent[];
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
    intents: [],
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
      provider.intents.push(intent);
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
      return { startSource: 'image' as const };
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
    const row = rows[0];
    if (row === undefined) return null;
    const grant = row.grant === null ? null : readScopeGrant(db, row.grant);
    return { ...row, grant: grant === null ? null : JSON.stringify(grant) };
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
    const existing = readScopeGrant(db, row.grant);
    if (existing === null) throw new Error('scope has no grant');
    const grant = patch(existing);
    await db
      .update(scopeGrants)
      .set({ grant: JSON.stringify(grant) })
      .where(eq(scopeGrants.id, row.grant));
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
  extraEnv: Record<string, unknown> = {},
  sandboxId: string = SANDBOX_ID
): Promise<DurableObjectStub<SandboxControlV2>> {
  const stub = sandboxNamespace.getByName(sandboxId);
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
      KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
      KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
      KILO_SESSION_INGEST_URL: 'https://ingest.kilosessions.ai',
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
  expect(view).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv) throw new Error('provider.launch was not called');
  const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
  expect(await wrapper.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
    type: 'welcome',
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
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

async function reconstructPreB(
  stub: DurableObjectStub<SandboxControlV2>,
  provider: FakeProvider,
  check: (
    instance: SandboxControlV2,
    updates: Array<{ sessionId: string; update: ControlPlaneRouteUpdate }>
  ) => Promise<void>
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const db = drizzle(state.storage);
    const rows = db.select().from(routesTable).all();
    const allocation = db.select().from(allocationTable).get();
    if (allocation === undefined) throw new Error('missing allocation fixture');
    const snapshots = rows.map(row => {
      const grant = row.grant === null ? null : readScopeGrant(db, row.grant);
      if (grant === null) throw new Error('missing grant fixture');
      return {
        ...row,
        grant: JSON.stringify({
          ...grant,
          members: grant.members.filter(member => member.sessionId === row.session_id),
          kilo: {
            ...grant.kilo,
            ...(row.session_id === SESSION
              ? {}
              : { alias: createControlPlaneCredential(SANDBOX_ID, 'kilo') }),
            capabilities: {},
            ...(grant.kilo.runtimeProxy === undefined
              ? {}
              : {
                  runtimeProxy: {
                    ...grant.kilo.runtimeProxy,
                    members: grant.kilo.runtimeProxy.members.filter(
                      member => member.sessionId === row.session_id
                    ),
                  },
                }),
          },
        }),
      };
    });
    const retained = await state.storage.list();
    await state.storage.deleteAll();
    const first = migrations.journal.entries[0];
    if (first === undefined) throw new Error('missing pre-B generated migration');
    await migrate(db, {
      journal: { entries: [first] },
      migrations: { m0000: migrations.migrations.m0000 },
    });
    for (const [key, value] of retained) await state.storage.put(key, value);
    expect(await state.storage.get('control_plane_generation')).toBe(2);
    db.insert(allocationTable).values(allocation).run();
    // Raw SQL: the pre-B routes table predates `repo_key`, which the schema now carries.
    for (const snapshot of snapshots) {
      db.run(
        sql`INSERT INTO routes (session_id, spec, grant, credential_source, state, attempt_id, attempt_deadline_at, reason, updated_at)
            VALUES (${snapshot.session_id}, ${snapshot.spec}, ${snapshot.grant}, ${snapshot.credential_source},
                    ${snapshot.state}, ${snapshot.attempt_id}, ${snapshot.attempt_deadline_at}, ${snapshot.reason}, ${snapshot.updated_at})`
      );
    }
    const updates: Array<{ sessionId: string; update: ControlPlaneRouteUpdate }> = [];
    const reconstructed = new SandboxControlV2(state, instance.env);
    Object.assign(reconstructed, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
      sessionPeerFor: (_ownerId: string, sessionId: string) => ({
        onRoute: async (update: ControlPlaneRouteUpdate) => {
          updates.push({ sessionId, update });
        },
        onEvents: async () => {},
        onOutcome: async () => {},
        issueRuntimeCredentialProxyGrant: async () => null,
      }),
    });
    await check(reconstructed, updates);
  });
}

afterEach(async () => {
  await reset();
});

describe('SandboxControlV2 credentials (B3)', () => {
  it.each([false, true])(
    'retires pre-B generation-2 JSON grants and recovers warm shared sends with modern=%s',
    async modern => {
      const provider = createFakeProvider();
      let stopCalls = 0;
      provider.adapter.stop = async () => {
        stopCalls += 1;
        return 'terminal';
      };
      const stub = await setup(provider, createFakeCredentialBroker(), {
        WORKER_URL: VERCEL_TARGET,
      });
      const input = (sessionId: string) =>
        prepareInput(
          sessionId,
          {
            ...credentialsSource(
              sessionId,
              modern ? { kiloToken: runtimeAuthorizedKiloToken() } : {}
            ),
            scopeId: 'upgrade_shared',
          },
          {
            ...routeSpec(sessionId),
            directory: '/workspace/upgrade_shared',
            ...(modern ? { runtimeIsolation: 'per-session' as const } : {}),
          }
        );
      const { wrapper, prepareFrame } = await prepareWarmRoute(stub, provider, input(SESSION));
      if (prepareFrame?.type !== 'session.prepare') throw new Error('missing old preparation');
      await stub.prepare(input(SESSION_NEXT));
      expect((await wrapper.next())?.type).toBe('session.prepare');
      await reconstructPreB(stub, provider, async (reconstructed, updates) => {
        expect(
          await reconstructed.deliver({
            sessionId: SESSION,
            messages: [promptPayload('msg_upgrade')],
          })
        ).toBe('not_ready');
        expect((await reconstructed.status({ sessionId: SESSION })).view.state).toBe('failed');
        expect((await reconstructed.status({ sessionId: SESSION_NEXT })).view.state).toBe('failed');
        expect((await reconstructed.getAllocationState()).kind).toBe('stopping');
        expect(stopCalls).toBe(0);
        const retiredState = await reconstructed.getAllocationState();
        expect(retiredState).toMatchObject({ stopAttempt: 1, stopPending: true });
        const db = drizzle(reconstructed.ctx.storage);
        expect(db.select().from(scopeGrants).all()).toEqual([]);
        expect(
          db
            .select()
            .from(routesTable)
            .all()
            .every(route => route.grant === null && route.state === 'failed')
        ).toBe(true);
        const resumed = new SandboxControlV2(reconstructed.ctx, reconstructed.env);
        Object.assign(resumed, {
          createProviderAdapter: () => provider.adapter,
          provider: provider.adapter,
        });
        expect(await resumed.getAllocationState()).toEqual(retiredState);
        await waitFor(() =>
          expect(updates.map(entry => [entry.sessionId, entry.update.state])).toEqual([
            [SESSION, 'lost'],
            [SESSION_NEXT, 'failed'],
          ])
        );
        expect(
          updates.every(
            entry => 'reason' in entry.update && entry.update.reason === 'agent_restarted'
          )
        ).toBe(true);
        expect(
          await reconstructed.resolveCredential({
            credential: prepareFrame.credentials.kilo.token,
            outboundContainerId: OUTBOUND_CONTAINER_ID,
            url: 'https://api.kilo.ai/api/openrouter/chat/completions',
            method: 'POST',
          })
        ).toBeNull();
        if (modern)
          expect(
            await reconstructed.getRuntimeCredentialProxyFence({
              ownerId: 'user_123',
              sessionId: SESSION,
              kiloSessionId: kiloSessionIdFor(SESSION),
              directory: '/workspace/upgrade_shared',
            })
          ).toBeNull();
        const view = await reconstructed.prepare(input(SESSION));
        expect(view.state).toBe('preparing');
        await reconstructed.alarm();
        await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
        expect(stopCalls).toBe(1);
        expect((await reconstructed.getAllocationState()).kind).toBe('starting');
      });
      const launch = provider.launchEnvs[1];
      if (launch === undefined) throw new Error('missing upgraded launch');
      const replacement = await FakeWrapper.connect({
        sandboxId: SANDBOX_ID,
        credential: launch.SANDBOX_CONTROL_CREDENTIAL,
      });
      await replacement.hello({
        wrapperId: 'wr_upgrade',
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
      });
      const first = await replacement.next();
      if (first?.type !== 'session.prepare') throw new Error('missing upgraded preparation');
      expect(first.credentials.kilo.token === prepareFrame.credentials.kilo.token).toBe(false);
      if (modern) expect(Boolean(first.credentials.proxy?.handle)).toBe(true);
      replacement.send({ type: 'session.ready', sessionId: SESSION });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
      );
      expect(
        await stub.deliver({
          sessionId: SESSION,
          messages: [promptPayload('msg_upgrade_recovered')],
        })
      ).toBe('sent');
      expect((await replacement.next())?.type).toBe('session.prompt');
      expect((await stub.prepare(input(SESSION_NEXT))).state).toBe('preparing');
      const second = await replacement.next();
      if (second?.type !== 'session.prepare')
        throw new Error('missing upgraded sibling preparation');
      expect(second.credentials.kilo.token === first.credentials.kilo.token).toBe(true);
      replacement.send({ type: 'session.ready', sessionId: SESSION_NEXT });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION_NEXT })).view.state).toBe('ready')
      );
      const resolve = (url: string, credential = first.credentials.kilo.token, method = 'POST') =>
        stub.resolveCredential({
          credential,
          outboundContainerId: OUTBOUND_CONTAINER_ID,
          url,
          method,
        });
      if (modern) {
        expect(first.credentials.proxy?.handle === second.credentials.proxy?.handle).toBe(false);
        const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}');
        expect(Object.keys(grant.kilo.capabilities)).toEqual([]);
        expect(await resolve('https://api.kilo.ai/api/openrouter/chat/completions')).toBeNull();
      } else {
        for (const sessionId of [SESSION, SESSION_NEXT]) {
          expect(
            await resolve('https://api.kilo.ai/api/openrouter/chat/completions')
          ).not.toBeNull();
          for (const operation of ['ingest', 'export'])
            expect(
              await resolve(
                `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(sessionId)}/${operation}`,
                first.credentials.kilo.token,
                operation === 'export' ? 'GET' : 'POST'
              )
            ).not.toBeNull();
        }
      }
      await stub.release({ sessionId: SESSION });
      expect((await stub.getAllocationState()).kind).toBe('connected');
      expect(
        await resolve(
          'https://github.com/acme/widgets.git/info/refs',
          first.credentials.git?.token,
          'GET'
        )
      ).not.toBeNull();
      if (!modern) {
        expect(await resolve('https://api.kilo.ai/api/openrouter/chat/completions')).not.toBeNull();
        for (const operation of ['ingest', 'export']) {
          expect(
            await resolve(
              `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(SESSION)}/${operation}`,
              first.credentials.kilo.token,
              operation === 'export' ? 'GET' : 'POST'
            )
          ).toBeNull();
          expect(
            await resolve(
              `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(SESSION_NEXT)}/${operation}`,
              first.credentials.kilo.token,
              operation === 'export' ? 'GET' : 'POST'
            )
          ).not.toBeNull();
        }
      }
      await runInDurableObject(stub, async (instance, state) => {
        const again = new SandboxControlV2(state, instance.env);
        expect((await again.status({ sessionId: SESSION_NEXT })).view.state).toBe('ready');
        expect(await state.storage.get('control_plane_generation')).toBe(2);
        expect(drizzle(state.storage).select().from(scopeGrants).all()).toHaveLength(1);
      });
    }
  );

  it('retires a credential-bearing ready route with a missing canonical owner', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);
    await prepareWarmRoute(stub, provider);
    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage);
      const row = db.select().from(routesTable).get();
      if (row?.grant == null) throw new Error('missing route reference');
      db.delete(scopeGrants).where(eq(scopeGrants.id, row.grant)).run();
      const reconstructed = new SandboxControlV2(state, instance.env);
      Object.assign(reconstructed, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
      expect((await reconstructed.status({ sessionId: SESSION })).view.state).toBe('failed');
      expect(
        await reconstructed.deliver({
          sessionId: SESSION,
          messages: [promptPayload('msg_missing_owner')],
        })
      ).toBe('not_ready');
    });
  });

  it('does not retire a healthy canonical sibling for an already-failed retired scope reference', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);
    await prepareWarmRoute(stub, provider);
    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage);
      const row = db.select().from(routesTable).get();
      if (row === undefined) throw new Error('missing route fixture');
      db.insert(routesTable)
        .values({
          ...row,
          session_id: SESSION_NEXT,
          spec: JSON.stringify(routeSpec(SESSION_NEXT)),
          grant: 'retired_scope:legacy',
          state: 'failed',
          reason: 'agent_unavailable',
          credential_source: JSON.stringify(credentialsSource(SESSION_NEXT)),
        })
        .run();
      const reconstructed = new SandboxControlV2(state, instance.env);
      Object.assign(reconstructed, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
      expect((await reconstructed.status({ sessionId: SESSION })).view.state).toBe('ready');
      expect((await reconstructed.getAllocationState()).kind).toBe('connected');
      expect(db.select().from(scopeGrants).all()).toHaveLength(1);
    });
  });

  it.each([false, true])(
    'keeps mixed managed-SCM admission fail-closed when modern-first=%s',
    async modernFirst => {
      const provider = createFakeProvider();
      const stub = await setup(provider, createFakeCredentialBroker(), {
        WORKER_URL: VERCEL_TARGET,
      });
      const input = (sessionId: string, modern: boolean) =>
        prepareInput(
          sessionId,
          {
            ...credentialsSource(sessionId),
            scopeId: 'managed_mixed',
            ...(modern ? { kiloToken: runtimeAuthorizedKiloToken() } : {}),
          },
          {
            ...routeSpec(sessionId),
            directory: '/workspace/managed_mixed',
            ...(modern ? { runtimeIsolation: 'per-session' as const } : {}),
          }
        );
      await prepareWarmRoute(stub, provider, input(SESSION, modernFirst));
      const before = (await readRouteRow(stub, SESSION))?.grant;
      expect((await stub.prepare(input(SESSION_NEXT, !modernFirst))).state).toBe('failed');
      expect((await readRouteRow(stub, SESSION))?.grant === before).toBe(true);
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready');
    }
  );

  it('keeps modern and legacy backing authorities separate for repository-only mixed scopes', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    const input = (sessionId: string, modern: boolean) =>
      prepareInput(
        sessionId,
        {
          ...credentialsSource(sessionId, {
            repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
          }),
          scopeId: 'mixed',
          ...(modern ? { kiloToken: runtimeAuthorizedKiloToken() } : {}),
        },
        {
          ...routeSpec(sessionId),
          directory: '/workspace/mixed',
          ...(modern ? { runtimeIsolation: 'per-session' as const } : {}),
        }
      );
    const { wrapper, prepareFrame } = await prepareWarmRoute(stub, provider, input(SESSION, false));
    await stub.prepare(input(SESSION_NEXT, true));
    const modern = await wrapper.next();
    if (
      prepareFrame?.type !== 'session.prepare' ||
      modern?.type !== 'session.prepare' ||
      !modern.credentials.proxy
    )
      throw new Error('missing mixed preparation');
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage);
      expect(db.select().from(scopeGrants).all()).toHaveLength(2);
      expect(readScopeGrant(db, 'mixed:legacy')?.kilo.runtimeProxy).toBeUndefined();
      expect(
        readScopeGrant(db, 'mixed:runtime')?.kilo.runtimeProxy?.members.map(
          member => member.sessionId
        )
      ).toEqual([SESSION_NEXT]);
      expect(Object.keys(readScopeGrant(db, 'mixed:runtime')?.kilo.capabilities ?? {})).toEqual([]);
    });
    expect(broker.kiloIssued()).toBe(0);
    await stub.release({ sessionId: SESSION_NEXT });
    expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready');
    expect((await stub.getAllocationState()).kind).toBe('connected');
    expect(
      JSON.stringify(provider.policyCalls.at(-1)).includes(prepareFrame.credentials.kilo.token)
    ).toBe(true);
    expect(
      JSON.stringify(provider.policyCalls.at(-1)).includes(modern.credentials.proxy.handle)
    ).toBe(false);
  });

  it('does not publish a runtime handle whose Vercel policy update failed', async () => {
    const provider = createFakeProvider();
    const stub = await setupVercel(provider, createFakeCredentialBroker());
    await prepareWarmRoute(stub, provider, prepareInput(SESSION, vercelSource(SESSION)));
    const before = (await readRouteRow(stub, SESSION))?.grant;
    const fence = await stub.getRuntimeCredentialProxyFence({
      ownerId: 'user_123',
      sessionId: SESSION,
      kiloSessionId: kiloSessionIdFor(SESSION),
      directory: routeSpec(SESSION).directory,
    });
    if (fence === null) throw new Error('missing proxy fence');
    const peer = createRuntimeProxyMintingPeer(env, sessionId => ({
      userId: 'user_123',
      kiloSessionId: kiloSessionIdFor(sessionId),
    }));
    const handle = await peer(SESSION).issueRuntimeCredentialProxyGrant(fence);
    if (handle === null) throw new Error('missing handle');
    provider.failPolicy = true;
    const failed = await runInDurableObject(stub, async instance => {
      try {
        await instance.bindRuntimeCredentialProxyHandle({
          ownerId: 'user_123',
          sessionId: SESSION,
          kiloSessionId: kiloSessionIdFor(SESSION),
          directory: routeSpec(SESSION).directory,
          handle,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toBe(true);
    expect((await readRouteRow(stub, SESSION))?.grant === before).toBe(true);
  });

  it('does not publish sibling ingestion membership when its Vercel policy update failed', async () => {
    const provider = createFakeProvider();
    const stub = await setupVercel(provider, createFakeCredentialBroker());
    const input = (sessionId: string) =>
      prepareInput(
        sessionId,
        {
          ...credentialsSource(sessionId, {
            repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
          }),
          scopeId: 'shared_legacy',
        },
        { ...routeSpec(sessionId), directory: '/workspace/shared_legacy' }
      );
    await prepareWarmRoute(stub, provider, input(SESSION));
    const before = (await readRouteRow(stub, SESSION))?.grant;
    provider.failPolicy = true;
    expect((await stub.prepare(input(SESSION_NEXT))).state).toBe('failed');
    expect((await readRouteRow(stub, SESSION))?.grant === before).toBe(true);
    expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready');
    await runInDurableObject(stub, (_instance, state) => {
      const rows = drizzle(state.storage).select().from(scopeGrants).all();
      expect(rows).toHaveLength(1);
      expect(
        JSON.parse(rows[0]?.grant ?? '{}').members.map(
          (member: { sessionId: string }) => member.sessionId
        )
      ).toEqual([SESSION]);
    });
  });

  it('reconstructs one persisted scope owner without credential copies on its routes', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);
    const input = (sessionId: string) =>
      prepareInput(
        sessionId,
        { ...credentialsSource(sessionId), scopeId: 'shared_worktree' },
        { ...routeSpec(sessionId), directory: '/workspace/shared_worktree' }
      );
    await prepareWarmRoute(stub, provider, input(SESSION));
    await stub.prepare(input(SESSION_NEXT));
    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      expect(db.select().from(scopeGrants).all()).toHaveLength(1);
      expect(db.select({ grant: routesTable.grant }).from(routesTable).all()).toEqual([
        { grant: 'shared_worktree:legacy' },
        { grant: 'shared_worktree:legacy' },
      ]);
      const grant = readScopeGrant(db, 'shared_worktree:legacy');
      if (!grant?.kilo.alias) throw new Error('missing canonical grant');
      const reconstructed = new SandboxControlV2(state, instance.env);
      expect((await reconstructed.status({ sessionId: SESSION })).view.state).toBe('ready');
      expect(
        await reconstructed.resolveCredential({
          credential: grant.kilo.alias,
          outboundContainerId: OUTBOUND_CONTAINER_ID,
          url: 'https://ingest.kilosessions.ai/api/session/ses_bbbbbbbbbbbbbbbbbbbbbbbbbb/ingest',
          method: 'POST',
        })
      ).not.toBeNull();
      expect(db.select().from(scopeGrants).all()).toHaveLength(1);
    });
  });

  it('keeps modern scope handles per session and removes only the released member', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setupVercel(provider, broker);
    const input = (sessionId: string) =>
      prepareInput(
        sessionId,
        { ...vercelSource(sessionId), scopeId: 'shared_modern' },
        {
          ...routeSpec(sessionId),
          directory: '/workspace/shared_modern',
          runtimeIsolation: 'per-session',
        }
      );
    const { wrapper, prepareFrame } = await prepareWarmRoute(stub, provider, input(SESSION));
    await stub.prepare(input(SESSION_NEXT));
    const second = await wrapper.next();
    if (prepareFrame?.type !== 'session.prepare' || second?.type !== 'session.prepare')
      throw new Error('missing modern preparation');
    expect(Boolean(prepareFrame.credentials.proxy?.handle)).toBe(true);
    expect(Boolean(second.credentials.proxy?.handle)).toBe(true);
    expect(prepareFrame.credentials.proxy?.handle === second.credentials.proxy?.handle).toBe(false);
    const before = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}');
    expect(before.members).toHaveLength(2);
    expect(before.kilo.runtimeProxy.members).toHaveLength(2);
    expect(broker.kiloIssued()).toBe(0);
    await stub.release({ sessionId: SESSION });
    const fence = (sessionId: string) =>
      stub.getRuntimeCredentialProxyFence({
        ownerId: 'user_123',
        sessionId,
        kiloSessionId: kiloSessionIdFor(sessionId),
        directory: '/workspace/shared_modern',
      });
    expect(await fence(SESSION)).toBeNull();
    expect(await fence(SESSION_NEXT)).not.toBeNull();
    const after = JSON.parse((await readRouteRow(stub, SESSION_NEXT))?.grant ?? '{}');
    expect(
      after.kilo.runtimeProxy.members.map((member: { sessionId: string }) => member.sessionId)
    ).toEqual([SESSION_NEXT]);
    expect(
      JSON.stringify(provider.policyCalls.at(-1)).includes(
        prepareFrame.credentials.proxy?.handle ?? 'absent'
      )
    ).toBe(false);
    expect(
      JSON.stringify(provider.policyCalls.at(-1)).includes(
        second.credentials.proxy?.handle ?? 'absent'
      )
    ).toBe(true);
    expect((await stub.getAllocationState()).kind).toBe('connected');
  });

  it.each([
    'organization',
    'repository',
    'legacy backing authorization',
    'modern backing authorization',
  ])('fails incompatible same-scope %s closed without changing the live owner', async kind => {
    const provider = createFakeProvider();
    const stub = await setup(provider, createFakeCredentialBroker(), { WORKER_URL: VERCEL_TARGET });
    const input = (sessionId: string) =>
      prepareInput(
        sessionId,
        { ...credentialsSource(sessionId), scopeId: 'shared_worktree' },
        { ...routeSpec(sessionId), directory: '/workspace/shared_worktree' }
      );
    await prepareWarmRoute(stub, provider, input(SESSION));
    const before = (await readRouteRow(stub, SESSION))?.grant;
    const next = input(SESSION_NEXT);
    if (kind === 'organization') next.credentials.orgId = 'org_other';
    if (kind === 'repository')
      next.credentials.repository = { type: 'github', repo: 'acme/private' };
    if (kind === 'legacy backing authorization')
      next.credentials.kiloToken = 'different-user-authority';
    if (kind === 'modern backing authorization')
      next.credentials.kiloToken = runtimeAuthorizedKiloToken();
    expect((await stub.prepare(next)).state).toBe('failed');
    expect((await readRouteRow(stub, SESSION))?.grant === before).toBe(true);
    expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready');
  });

  it('retires physical aliases and rebinds a preparing route without resetting its attempt', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);
    const first = await prepareWarmRoute(stub, provider);
    if (first.prepareFrame?.type !== 'session.prepare') throw new Error('missing prepare');
    await runInDurableObject(stub, async (_instance, state) => {
      drizzle(state.storage)
        .update(routesTable)
        .set({ state: 'preparing' })
        .where(eq(routesTable.session_id, SESSION))
        .run();
    });
    const before = await readRouteRow(stub, SESSION);
    await stub.reportProviderGone();
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    expect(
      await stub.resolveCredential({
        credential: first.prepareFrame.credentials.kilo.token,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url: 'https://api.kilo.ai/api/user',
        method: 'GET',
      })
    ).toBeNull();
    const launch = provider.launchEnvs[1];
    if (!launch) throw new Error('missing replacement launch');
    const replacement = await FakeWrapper.connect({
      sandboxId: SANDBOX_ID,
      credential: launch.SANDBOX_CONTROL_CREDENTIAL,
    });
    expect(
      (
        await replacement.hello({
          wrapperId: 'wr_replacement',
          allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
        })
      )?.type
    ).toBe('welcome');
    const prepared = await replacement.next();
    if (prepared?.type !== 'session.prepare') throw new Error('missing replacement prepare');
    expect(prepared.credentials.kilo.token === first.prepareFrame.credentials.kilo.token).toBe(
      false
    );
    const after = await readRouteRow(stub, SESSION);
    expect(after?.attempt_id).toBe(before?.attempt_id);
    expect(after?.attempt_deadline_at).toBe(before?.attempt_deadline_at);
    expect(
      await stub.resolveCredential({
        credential: prepared.credentials.kilo.token,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url: 'https://api.kilo.ai/api/user',
        method: 'GET',
      })
    ).not.toBeNull();
  });

  it('shares legacy scope aliases and resolves both native histories after creator release', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);
    const sharedInput = (sessionId: string) =>
      prepareInput(
        sessionId,
        { ...credentialsSource(sessionId), scopeId: 'shared_worktree' },
        { ...routeSpec(sessionId), directory: '/workspace/shared_worktree' }
      );
    const { wrapper, prepareFrame } = await prepareWarmRoute(stub, provider, sharedInput(SESSION));
    if (prepareFrame?.type !== 'session.prepare') throw new Error('missing prepare frame');
    const alias = prepareFrame.credentials.kilo.token;
    await stub.prepare(sharedInput(SESSION_NEXT));
    const sibling = await wrapper.next();
    expect(sibling?.type).toBe('session.prepare');
    if (sibling?.type !== 'session.prepare') throw new Error('missing sibling prepare');
    expect(sibling.credentials.kilo.token === alias).toBe(true);
    wrapper.send({ type: 'session.ready', sessionId: SESSION_NEXT });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION_NEXT })).view.state).toBe('ready')
    );
    const resolve = (url: string, credential = alias, method = 'POST') =>
      stub.resolveCredential({
        credential,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url,
        method,
      });
    for (const sessionId of [SESSION, SESSION_NEXT]) {
      expect(await resolve('https://api.kilo.ai/api/openrouter/chat/completions')).not.toBeNull();
      for (const operation of ['ingest', 'export']) {
        expect(
          await resolve(
            `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(sessionId)}/${operation}`,
            alias,
            operation === 'export' ? 'GET' : 'POST'
          )
        ).not.toBeNull();
      }
    }
    await stub.release({ sessionId: SESSION });
    expect((await stub.getAllocationState()).kind).toBe('connected');
    expect(await resolve('https://api.kilo.ai/api/user', alias, 'GET')).not.toBeNull();
    expect(
      await resolve(
        `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(SESSION_NEXT)}/ingest`
      )
    ).not.toBeNull();
    expect(
      await resolve(
        `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(SESSION)}/ingest`
      )
    ).toBeNull();
    expect(
      await resolve(
        `https://ingest.kilosessions.ai/api/session/${kiloSessionIdFor(SESSION)}/export`,
        alias,
        'GET'
      )
    ).toBeNull();
    expect(
      await resolve(
        'https://github.com/acme/widgets.git/info/refs',
        prepareFrame.credentials.git?.token,
        'GET'
      )
    ).not.toBeNull();
    await stub.release({ sessionId: SESSION_NEXT });
    expect(await resolve('https://api.kilo.ai/api/user', alias, 'GET')).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(scopeGrants).all()).toEqual([]);
    });
  });

  it('keeps installed aliases usable during warm renewal with fresh backing capabilities', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    const { wrapper, prepareFrame } = await prepareWarmRoute(stub, provider);
    if (prepareFrame?.type !== 'session.prepare') throw new Error('missing prepare frame');
    const alias = prepareFrame.credentials.kilo.token;
    const resolve = () =>
      stub.resolveCredential({
        credential: alias,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url: 'https://api.kilo.ai/api/user',
        method: 'GET',
      });
    const before = await resolve();
    await patchGrant(stub, SESSION, grant => ({
      ...grant,
      expiresAt: Date.now() + TIMERS.credentialGrantReissueBelowMs / 2,
      kilo: { ...(grant.kilo as Record<string, unknown>), capabilities: {} },
    }));
    expect(
      await stub.deliver({ sessionId: SESSION, messages: [promptPayload('busy_followup')] })
    ).toBe('sent');
    expect((await wrapper.next())?.type).toBe('session.credentials');
    const after = await resolve();
    expect(after).not.toBeNull();
    expect(after?.credential === before?.credential).toBe(false);
    expect(broker.kiloIssued()).toBe(2);
  });

  it('keeps old preparation aliases when an expired attempt retries before the old wrapper finishes', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);
    const { wrapper, prepareFrame } = await prepareWarmRoute(stub, provider);
    if (prepareFrame?.type !== 'session.prepare') throw new Error('missing prepare frame');
    await runInDurableObject(stub, async (instance, state) => {
      drizzle(state.storage)
        .update(routesTable)
        .set({ state: 'preparing', attempt_deadline_at: Date.now() - 1 })
        .where(eq(routesTable.session_id, SESSION))
        .run();
      await instance.alarm();
    });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed')
    );
    await stub.prepare(prepareInput(SESSION));
    const next = await wrapper.next();
    if (next?.type !== 'session.prepare') throw new Error('missing retry prepare');
    expect(next.spec.attemptId).not.toBe(prepareFrame.spec.attemptId);
    expect(next.credentials.kilo.token === prepareFrame.credentials.kilo.token).toBe(true);
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view).toEqual({
        state: 'ready',
        attemptId: next.spec.attemptId,
      })
    );
    expect(
      await stub.resolveCredential({
        credential: prepareFrame.credentials.kilo.token,
        outboundContainerId: OUTBOUND_CONTAINER_ID,
        url: 'https://api.kilo.ai/api/user',
        method: 'GET',
      })
    ).not.toBeNull();
  });

  it('cold prepare on the default provider issues a grant and starts the sandbox', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);

    const view = await stub.prepare(prepareInput(SESSION));
    expect(view).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });

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
    expect(view).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      containmentEnabled?: boolean;
      outboundContainerId?: string;
      kilo?: { alias?: string };
    };
    // Uncontained: no alias is minted and the grant opts out of containment.
    expect(grant.containmentEnabled).toBe(false);
    expect(grant.kilo?.alias).toBeUndefined();
    expect(grant.outboundContainerId).toBeUndefined();
    await waitFor(() => expect(provider.intents).toHaveLength(1));
    expect(provider.intents[0]?.containment).toEqual({ kilocode: false, github: false });
  });

  it('prepares with a containment-off selection when no containment namespaces are bound', async () => {
    // Reproduces the deployed e2e Worker: containment is off and the containment
    // container classes are stripped from the config, so resolving a containment
    // proxy container would throw during prepare.
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker, { CREDENTIAL_CONTAINMENT_ENABLED: 'false' });
    await runInDurableObject(stub, instance => {
      const mutableEnv = instance.env as Record<string, unknown>;
      delete mutableEnv.SandboxContainment;
      delete mutableEnv.SandboxSmallContainment;
    });
    const source = credentialsSource(SESSION, {
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
    });

    const view = await stub.prepare({
      ...prepareInput(SESSION, source),
      sandboxSelection: { provider: 'cloudflare', containment: { kilocode: false, github: false } },
    });
    expect(view).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });
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
    await waitFor(() => expect(provider.intents).toHaveLength(1));
    expect(provider.intents[0]?.containment).toEqual({ kilocode: true, github: true });
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
      outboundContainerId?: string;
    };
    expect(grant.containmentEnabled).toBe(false);
    // Containment off must not resolve a containment proxy container, which the
    // e2e Worker does not bind and which would otherwise throw during prepare.
    expect(grant.outboundContainerId).toBeUndefined();
    await waitFor(() => expect(provider.intents).toHaveLength(1));
    expect(provider.intents[0]?.containment).toEqual({
      kilocode: false,
      github: false,
      worktreeScoped: true,
    });
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
    expect(view).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });
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

    const { prepareFrame } = await prepareWarmRoute(
      stub,
      provider,
      prepareInput(SESSION, { ...credentialsSource(SESSION), createdOnPlatform: 'code-review' })
    );

    expect(prepareFrame?.type).toBe('session.prepare');
    const serialized = JSON.stringify(prepareFrame);
    expect(serialized).not.toContain(NATIVE_KILO_TOKEN);
    expect(serialized).not.toContain(NATIVE_GIT_TOKEN);
    expect(serialized).not.toContain('user_123');
    expect(serialized).not.toContain('repository');
    expect(serialized).not.toContain('"userId"');

    if (prepareFrame?.type !== 'session.prepare') throw new Error('missing prepare frame');
    expect(prepareFrame.spec.createdOnPlatform).toBe('code-review');
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
    expect(refreshed.kilo.alias === firstAlias).toBe(true);
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
    expect(refreshed.kilo.alias === firstAlias).toBe(true);
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
    expect(grantAfterRetry.kilo.alias === grantBefore.kilo.alias).toBe(true);
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
    // queued backstop.
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
    expect(next).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });
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

  it('continues the restart loop when refresh fails for one expiring route', async () => {
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const stub = await setup(provider, broker);
    const { wrapper, credential, allocationId } = await prepareWarmRoute(stub, provider);

    // A sibling route is already preparing on the same sandbox.
    await stub.prepare(prepareInput(SESSION_NEXT));
    const siblingPrepare = await wrapper.next();
    expect(siblingPrepare?.type).toBe('session.prepare');
    await setGrantExpiry(stub, SESSION, Date.now() + TIMERS.credentialGrantReissueBelowMs / 2);

    // Fail the next issuance (the ready route's restart re-mint).
    broker.issueGitHubSessionCapability = () =>
      Promise.reject(new Error('git-token-service unavailable'));
    wrapper.close();
    await waitFor(async () => expect((await stub.getAllocationState()).kind).toBe('disconnected'));
    const wrapper2 = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    expect(await wrapper2.hello({ wrapperId: 'wr_2', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    });

    // The failing route is marked failed; the loop still serves the sibling.
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('failed'));
    const next = await wrapper2.next();
    expect(next?.type).toBe('session.prepare');
    if (next?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(next.spec.sessionId).toBe(SESSION_NEXT);
  });
});

describe('SandboxControlV2 placed sandbox keys', () => {
  const PLACED_ID = `sbx-${'d'.repeat(48)}`;
  const smallPool = { idFromName: (name: string) => ({ toString: () => `small_${name}` }) };
  const codeReviewPool = { idFromName: (name: string) => ({ toString: () => `review_${name}` }) };

  function setupPlaced(provider: FakeProvider) {
    return setup(
      provider,
      createFakeCredentialBroker(),
      { SandboxSmallContainment: smallPool, SandboxCodeReviewContainment: codeReviewPool },
      PLACED_ID
    );
  }

  function readPin(stub: DurableObjectStub<SandboxControlV2>) {
    return runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const rows = await db
        .select({ pin: allocationTable.provider_pin })
        .from(allocationTable)
        .where(eq(allocationTable.id, 'current'));
      return JSON.parse(rows[0]?.pin ?? 'null') as { sandboxKind?: unknown } | null;
    });
  }

  it('pins the kind and names the outbound container in its pool', async () => {
    const provider = createFakeProvider();
    const stub = await setupPlaced(provider);

    await stub.prepare({
      ...prepareInput(SESSION),
      sandboxSelection: {
        provider: 'cloudflare',
        sandboxKind: 'isolated',
        containment: WORKTREE_CREDENTIAL_CONTAINMENT,
      },
    });

    const grant = JSON.parse((await readRouteRow(stub, SESSION))?.grant ?? '{}') as {
      outboundContainerId?: string;
    };
    // A placed key never reaches the prefix table, which would have chosen SandboxContainment.
    expect(grant.outboundContainerId).toBe(`small_${PLACED_ID}`);
    expect((await readPin(stub))?.sandboxKind).toBe('isolated');
  });

  it('keeps the pinned kind when a later prepare names another', async () => {
    const provider = createFakeProvider();
    const stub = await setupPlaced(provider);
    await stub.prepare({
      ...prepareInput(SESSION),
      sandboxSelection: {
        provider: 'cloudflare',
        sandboxKind: 'isolated',
        containment: WORKTREE_CREDENTIAL_CONTAINMENT,
      },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    await stub.prepare({
      ...prepareInput(SESSION_NEXT),
      sandboxSelection: {
        provider: 'cloudflare',
        sandboxKind: 'code-review',
        containment: WORKTREE_CREDENTIAL_CONTAINMENT,
      },
    });

    const grant = JSON.parse((await readRouteRow(stub, SESSION_NEXT))?.grant ?? '{}') as {
      outboundContainerId?: string;
    };
    expect(grant.outboundContainerId).toBe(`small_${PLACED_ID}`);
    expect((await readPin(stub))?.sandboxKind).toBe('isolated');
  });

  it('rejects a placed key selection without its kind', async () => {
    const provider = createFakeProvider();
    const stub = await setupPlaced(provider);

    // In-DO call: the rejection is asserted without crossing the RPC boundary.
    await runInDurableObject(stub, instance =>
      expect(
        instance.prepare({
          ...prepareInput(SESSION),
          sandboxSelection: {
            provider: 'cloudflare',
            containment: WORKTREE_CREDENTIAL_CONTAINMENT,
          },
        })
      ).rejects.toThrow('Sandbox selection kind does not match the sandbox key')
    );
    expect(provider.intents).toHaveLength(0);
  });

  it('rejects a kind for a legacy prefixed key', async () => {
    const provider = createFakeProvider();
    const stub = await setup(provider);

    await runInDurableObject(stub, instance =>
      expect(
        instance.prepare({
          ...prepareInput(SESSION),
          sandboxSelection: {
            provider: 'cloudflare',
            sandboxKind: 'isolated',
            containment: WORKTREE_CREDENTIAL_CONTAINMENT,
          },
        })
      ).rejects.toThrow('Sandbox selection kind does not match the sandbox key')
    );
  });
});
