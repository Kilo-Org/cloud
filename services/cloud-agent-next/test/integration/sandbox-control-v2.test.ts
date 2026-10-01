import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { resolveSecret } from '../../src/auth.js';
import {
  mintSandboxLaunchCredential,
  verifySandboxLaunchCredential,
} from '../../src/sandbox-control/credential.js';
import type { Env } from '../../src/types.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBillingContext,
  getBillingContext,
  updateBillingContext,
  type ContainerUsageRpcMethods,
} from '@kilocode/container-usage';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import { ProviderCreationError } from '../../src/sandbox-control/provider.js';
import { VERCEL_BILLING_SETTLEMENT_CALLBACK } from '../../src/sandbox-control/vercel-billing.js';
import { encodeVercelProviderRef } from '../../src/sandbox-control/vercel-provider.js';
import {
  VERCEL_BILLING_SCHEDULE_KEY,
  type BillingScheduleEntries,
} from '../../src/sandbox-control/billing-schedule.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { logger } from '../../src/logger.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const SANDBOX_ID = 'sbx__control_v2_smoke';
const CUTOVER_SANDBOX_ID = 'sbx__control_v2_cutover';
const CUSTOM_ALLOCATION_NAME = 'usr-shared-allocation-name';
const LEGACY_ALLOCATION_NAME = 'usr-legacy-shared-allocation';
const MINUTE = 60 * 1000;
const TIMERS = CONTROL_PLANE_TIMERS.sandbox;

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxNamespace = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;

type FakeProviderOptions = {
  failFirstCreate?: boolean;
  gateCreate?: boolean;
  gateLaunch?: boolean;
  gateStop?: boolean;
};

type FakeProvider = {
  adapter: ProviderAdapter;
  createCalls: number;
  createInputs: ProviderCreateIntent[];
  refs: string[];
  launchEnvs: Record<string, string>[];
  stopCalls: (string | null)[];
  stopResults: StopResult[];
  leaseCalls: number[];
  leaseRefs: string[];
  createGates: Array<(value: { providerRef: string }) => void>;
  launchGates: Array<(error?: unknown) => void>;
  stopGates: Array<(result: StopResult) => void>;
};

function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    createCalls: 0,
    createInputs: [],
    refs: [],
    launchEnvs: [],
    stopCalls: [],
    stopResults: [],
    leaseCalls: [],
    leaseRefs: [],
    createGates: [],
    launchGates: [],
    stopGates: [],
  };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCalls += 1;
      provider.createInputs.push(intent);
      if (options.failFirstCreate && provider.createCalls === 1) {
        throw new Error('provider create failed');
      }
      const ref = `mem_${intent.intentId}`;
      provider.refs.push(ref);
      if (options.gateCreate) {
        return new Promise(resolve => provider.createGates.push(resolve));
      }
      return { providerRef: ref };
    },
    async launch(_ref, env) {
      provider.launchEnvs.push({ ...env });
      if (options.gateLaunch) {
        await new Promise<void>((resolve, reject) => {
          provider.launchGates.push(error => (error === undefined ? resolve() : reject(error)));
        });
      }
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopCalls.push(ref);
      if (options.gateStop) {
        return new Promise<StopResult>(resolve => provider.stopGates.push(resolve));
      }
      return provider.stopResults.shift() ?? 'terminal';
    },
    async ensureLeaseAtLeast(ref, ms) {
      provider.leaseCalls.push(ms);
      provider.leaseRefs.push(ref);
    },
    async logs() {
      return '';
    },
  };
  return provider;
}

type StartOptions = {
  sandboxId?: string;
  allocationName?: string;
  billing?: unknown;
  containment?: { kilocode?: boolean; github?: boolean };
  provider?: 'cloudflare' | 'vercel';
  configuration?: { provider: 'vercel'; resources: { vcpus: number; memory: number } };
  meter?: ContainerUsageRpcMethods;
  preparingRoute?: string;
  admissionError?: string;
};

/** Injects the fake adapter, then triggers `ensure` through a real DO RPC so
 * `ctx.waitUntil` effects keep a valid event context. */
async function startAllocation(
  provider: FakeProvider,
  options: StartOptions = {}
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxId = options.sandboxId ?? SANDBOX_ID;
  const stub = sandboxNamespace.getByName(sandboxId);
  await runInDurableObject(stub, async (instance, state) => {
    await instance.getAllocationState();
    if (options.meter !== undefined) await state.storage.put('control_plane_owner', 'owner-1');
    const realAdmission = (
      instance as unknown as { admitVercelCreate(pin: unknown): Promise<unknown> }
    ).admitVercelCreate.bind(instance);
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
      ...(options.meter === undefined
        ? {}
        : { env: { ...instance.env, CONTAINER_USAGE_METER: options.meter } }),
      ...(options.admissionError === undefined
        ? {}
        : options.admissionError === 'hang'
          ? {
              admitVercelCreate: () => new Promise(() => undefined),
              sandboxTimers: () => ({ ...TIMERS, providerStopAttemptMs: 20 }),
            }
          : options.admissionError === 'throw-after-open'
            ? {
                admitVercelCreate: async (pin: unknown) => {
                  await realAdmission(pin);
                  throw new Error('Meter response lost after context write');
                },
              }
            : {
                admitVercelCreate: async () => {
                  throw new Error(options.admissionError);
                },
              }),
    });
  });
  if (options.preparingRoute !== undefined) {
    await insertPreparingRoute(stub, {
      sessionId: options.preparingRoute,
      attemptDeadlineAt: Date.now() + MINUTE,
    });
  }
  await stub.ensureAllocation({
    provider: options.provider ?? 'cloudflare',
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    allocationName: options.allocationName ?? sandboxId,
    ...(options.billing === undefined ? {} : { billing: options.billing }),
    ...(options.containment === undefined ? {} : { containment: options.containment }),
  });
  return stub;
}

async function awaitLaunch(provider: FakeProvider): Promise<void> {
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
}

async function awaitStarting(
  provider: FakeProvider,
  stub: DurableObjectStub<SandboxControlV2>
): Promise<void> {
  await awaitLaunch(provider);
  await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));
}

async function insertPreparingRoute(
  stub: DurableObjectStub<SandboxControlV2>,
  input: { sessionId: string; attemptDeadlineAt: number }
): Promise<void> {
  const spec = {
    sessionId: input.sessionId,
    kiloSessionId: `kilo-${input.sessionId}`,
    directory: `/workspace/${input.sessionId}`,
    attemptId: `${input.sessionId}-a1`,
  };
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db.insert(routesTable).values({
      session_id: input.sessionId,
      spec: JSON.stringify(spec),
      state: 'preparing',
      attempt_id: `${input.sessionId}-a1`,
      attempt_deadline_at: input.attemptDeadlineAt,
      reason: null,
      updated_at: Date.now(),
    });
  });
}

function readState(stub: DurableObjectStub<SandboxControlV2>) {
  return stub.getAllocationState();
}

function readAlarm(stub: DurableObjectStub<SandboxControlV2>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

function readProviderPin(stub: DurableObjectStub<SandboxControlV2>) {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db
      .select({ pin: allocationTable.provider_pin })
      .from(allocationTable)
      .where(eq(allocationTable.id, 'current'));
    return rows[0]?.pin ?? null;
  });
}

async function setDeadline(
  stub: DurableObjectStub<SandboxControlV2>,
  patch: Partial<{
    last_frame_at: number;
    last_activity_at: number;
    first_connect_deadline_at: number;
    create_deadline_at: number;
    stop_at: number;
  }>
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db.update(allocationTable).set(patch).where(eq(allocationTable.id, 'current'));
  });
}

async function runAlarm(stub: DurableObjectStub<SandboxControlV2>): Promise<void> {
  await runInDurableObject(stub, instance => instance.alarm());
}

/** Resolve a provider gate inside a DO action so the continuation keeps its I/O context. */
async function releaseGate(
  stub: DurableObjectStub<SandboxControlV2>,
  release: () => void
): Promise<void> {
  await runInDurableObject(stub, async () => {
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
  });
}

function launchIdentity(provider: FakeProvider): { credential: string; allocationId: string } {
  const env = provider.launchEnvs[0];
  if (!env) throw new Error('provider.launch was not called');
  const credential = env.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = env.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  return { credential, allocationId };
}

async function connectAndHello(
  provider: FakeProvider,
  stub: DurableObjectStub<SandboxControlV2>,
  wrapperId = 'wr_1'
): Promise<{ wrapper: FakeWrapper; credential: string; allocationId: string }> {
  const { credential, allocationId } = launchIdentity(provider);
  const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
  const reply = await wrapper.hello({ wrapperId, allocationId });
  expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
  await waitFor(async () => expect((await readState(stub)).kind).toBe('connected'));
  return { wrapper, credential, allocationId };
}

type AllocationWriteCounter = {
  allocationWriteCount: number;
  writeAllocation: (state: unknown) => Promise<void>;
};

/**
 * Counts allocation-row writes (`writeAllocation`) while `action` runs. The
 * counter is installed on the live instance and read back on the same instance,
 * so it observes the writes produced by the socket turn under test.
 */
async function countAllocationWrites(
  stub: DurableObjectStub<SandboxControlV2>,
  action: () => Promise<void>
): Promise<number> {
  await runInDurableObject(stub, instance => {
    const counter = instance as unknown as AllocationWriteCounter;
    const original = counter.writeAllocation.bind(instance);
    counter.allocationWriteCount = 0;
    counter.writeAllocation = async state => {
      counter.allocationWriteCount += 1;
      await original(state);
    };
  });
  await action();
  return runInDurableObject(
    stub,
    instance => (instance as unknown as AllocationWriteCounter).allocationWriteCount
  );
}

afterEach(async () => {
  await reset();
});

describe('SandboxControlV2 allocation lifecycle', () => {
  it('fails permanent launch configuration promptly while cleanup retains the existing stop ladder and uncertainty', async () => {
    const provider = createFakeProvider({ gateLaunch: true });
    provider.stopResults = Array.from(
      { length: TIMERS.providerStopLadderMs.length + 1 },
      () => 'retryable'
    );
    const stub = await startAllocation(provider, { preparingRoute: 'waiting' });
    await waitFor(() => expect(provider.launchGates).toHaveLength(1));
    await releaseGate(stub, () =>
      provider.launchGates[0](new ProviderCreationError('invalid_configuration'))
    );
    await waitFor(async () =>
      expect((await stub.status({ sessionId: 'waiting' })).view).toMatchObject({
        state: 'failed',
        reason: 'invalid_configuration',
      })
    );
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopping'));
    for (let attempt = 1; attempt <= TIMERS.providerStopLadderMs.length + 1; attempt += 1) {
      await waitFor(() => expect(provider.stopCalls).toHaveLength(attempt));
      await waitFor(async () => {
        const state = await readState(stub);
        expect(state.kind === 'stopped' || state.stopPending).toBe(true);
      });
      if ((await readState(stub)).kind === 'stopped') break;
      await setDeadline(stub, { stop_at: Date.now() - 1 });
      await runAlarm(stub);
    }
    const stopped = await readState(stub);
    expect(stopped.kind).toBe('stopped');
    expect(stopped.unconfirmedProviderRef).toBe(provider.refs[0]);
    expect(provider.createCalls).toBe(1);
    expect(provider.stopCalls).toEqual(
      Array.from({ length: TIMERS.providerStopLadderMs.length + 1 }, () => provider.refs[0])
    );
  });

  it('ignores a permanent late launch rejection after hello has acquired the allocation', async () => {
    const provider = createFakeProvider({ gateLaunch: true });
    const stub = await startAllocation(provider, { preparingRoute: 'waiting' });
    await waitFor(() => expect(provider.launchGates).toHaveLength(1));
    await insertPreparingRoute(stub, {
      sessionId: 'sibling',
      attemptDeadlineAt: Date.now() + MINUTE,
    });
    const { wrapper } = await connectAndHello(provider, stub);
    wrapper.send({ type: 'session.ready', sessionId: 'sibling' });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: 'sibling' })).view.state).toBe('ready')
    );
    const before = await readState(stub);
    await releaseGate(stub, () =>
      provider.launchGates[0](new ProviderCreationError('invalid_configuration'))
    );
    expect(await readState(stub)).toEqual(before);
    expect((await stub.status({ sessionId: 'waiting' })).view.state).toBe('preparing');
    expect((await stub.status({ sessionId: 'sibling' })).view.state).toBe('ready');
    expect(provider.stopCalls).toEqual([]);
    wrapper.close();
  });

  it('retains at most two unbound candidates without replacing a healthy socket', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { wrapper, credential, allocationId } = await connectAndHello(provider, stub);
    const before = await readState(stub);
    const first = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const second = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    await evictAllDurableObjects();
    const overflow = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    await expect(overflow.waitForClose()).resolves.toBe(1013);
    expect(await readState(stub)).toEqual(before);
    expect(await first.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    await expect(wrapper.waitForClose()).resolves.toBe(1000);
    expect(await second.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    expect((await readState(stub)).kind).toBe('connected');
    expect(provider.stopCalls).toEqual([]);
  });

  it.each(['silent', 'malformed', 'heartbeat'] as const)(
    'expires %s candidates from attachment deadlines after reconstruction even while stopped',
    async mode => {
      const provider = createFakeProvider();
      const stub = await startAllocation(provider);
      await awaitStarting(provider, stub);
      const { credential } = launchIdentity(provider);
      const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
      const deadline = await runInDurableObject(stub, (_instance, state) => {
        const socket = state.getWebSockets()[0];
        const attachment = socket.deserializeAttachment();
        expect(attachment.helloDeadlineAt).toBeGreaterThan(Date.now());
        expect(attachment.helloDeadlineAt).toBeLessThanOrEqual(Date.now() + 30_000);
        return attachment.helloDeadlineAt as number;
      });
      expect(await readAlarm(stub)).toBe(deadline);
      if (mode === 'malformed') wrapper.sendRaw('{bad');
      if (mode === 'heartbeat') wrapper.heartbeat(true);
      await stub.reportProviderGone();
      expect((await readState(stub)).kind).toBe('stopped');
      expect(await readAlarm(stub)).toBe(deadline);
      await runInDurableObject(stub, (_instance, state) => {
        const socket = state.getWebSockets()[0];
        socket.serializeAttachment({
          ...socket.deserializeAttachment(),
          helloDeadlineAt: Date.now() - 1,
        });
      });
      await evictAllDurableObjects();
      await runAlarm(stub);
      await expect(wrapper.waitForClose()).resolves.toBe(1008);
      expect((await readState(stub)).kind).toBe('stopped');
      expect(await readAlarm(stub)).toBeNull();
      expect(provider.createCalls).toBe(1);
      expect(provider.stopCalls).toEqual([]);
      expect(provider.leaseCalls).toEqual([]);
    }
  );

  it('rejects a signed retired allocation before retaining a candidate on the production route', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { credential } = launchIdentity(provider);
    await stub.reportProviderGone();
    await startAllocation(provider);
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));
    const current = await readState(stub);
    const stale = await FakeWrapper.connect({
      sandboxId: SANDBOX_ID,
      credential,
      path: `/sandbox-control/${SANDBOX_ID}`,
    });
    expect(await stale.next()).toEqual({ type: 'shutdown', reason: 'hello_rejected' });
    await expect(stale.waitForClose()).resolves.toBe(1008);
    expect(await readState(stub)).toEqual(current);
    expect(await runInDurableObject(stub, (_instance, state) => state.getWebSockets().length)).toBe(
      0
    );
    expect(provider.createCalls).toBe(2);
    expect(provider.stopCalls).toEqual([]);
  });

  it('keeps the DO credential hash authoritative for a correctly signed current allocation', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { allocationId } = launchIdentity(provider);
    const secret = await resolveSecret((env as Env).NEXTAUTH_SECRET);
    if (!secret) throw new Error('Test signing secret unavailable');
    const credential = mintSandboxLaunchCredential(
      { sandboxId: SANDBOX_ID, allocationId, credential: 'f'.repeat(64) },
      secret
    );
    expect(verifySandboxLaunchCredential(credential, secret)).not.toBeNull();
    const before = await readState(stub);
    const rejected = await FakeWrapper.connect({
      sandboxId: SANDBOX_ID,
      credential,
      path: `/sandbox-control/${SANDBOX_ID}`,
    });
    expect(await rejected.next()).toEqual({ type: 'shutdown', reason: 'hello_rejected' });
    await expect(rejected.waitForClose()).resolves.toBe(1008);
    expect(await readState(stub)).toEqual(before);
    expect(await runInDurableObject(stub, (_instance, state) => state.getWebSockets().length)).toBe(
      0
    );
  });

  it('records a distinct hello admission reason for each rejection at the validator', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { credential, allocationId } = launchIdentity(provider);
    const secret = await resolveSecret((env as unknown as Env).NEXTAUTH_SECRET);
    if (!secret) throw new Error('Test signing secret unavailable');
    const rawCredential = verifySandboxLaunchCredential(credential, secret)?.credential;
    if (!rawCredential) throw new Error('Launch credential did not verify');
    const records = await runInDurableObject(stub, async (instance, state) => {
      const validate = (id: string, presented: string | null) =>
        (
          instance as unknown as {
            validateAllocationCredential(a: string, c: string | null): Promise<boolean>;
          }
        ).validateAllocationCredential(id, presented);
      const captured: Record<string, unknown>[] = [];
      const withFields = vi.spyOn(logger, 'withFields').mockImplementation(fields => {
        const bounded = fields as unknown as Record<string, unknown>;
        if (bounded.diagnosticEvent === 'hello_admission') captured.push(bounded);
        return logger;
      });
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      try {
        await validate(allocationId, rawCredential);
        await validate('00000000-0000-4000-8000-0000000000ff', rawCredential);
        await validate(allocationId, null);
        await validate(allocationId, 'f'.repeat(64));
        const hash = await state.storage.get<string>('wrapper_credential_hash');
        await state.storage.delete('wrapper_credential_hash');
        await validate(allocationId, rawCredential);
        if (typeof hash === 'string') await state.storage.put('wrapper_credential_hash', hash);
        const db = drizzle(state.storage, { logger: false });
        await db
          .update(allocationTable)
          .set({ state: 'stopping' })
          .where(eq(allocationTable.id, 'current'));
        await validate(allocationId, rawCredential);
        await db
          .update(allocationTable)
          .set({ state: 'stopped' })
          .where(eq(allocationTable.id, 'current'));
        await validate(allocationId, rawCredential);
      } finally {
        withFields.mockRestore();
        info.mockRestore();
      }
      return captured;
    });

    expect(records.map(record => record.reason)).toEqual([
      'accepted',
      'allocation_mismatch',
      'missing_credential',
      'credential_mismatch',
      'missing_credential_hash',
      'allocation_stopping',
      'allocation_stopped',
    ]);
    expect(records[1]).toMatchObject({
      allocationKind: 'starting',
      expectedAllocationId: allocationId,
      receivedAllocationId: '00000000-0000-4000-8000-0000000000ff',
      credentialPresent: true,
      accepted: false,
    });
    expect(records[2]).toMatchObject({ credentialPresent: false });
    expect(records[4]).toMatchObject({ credentialHashPresent: false });
    expect(records[5]).toMatchObject({ allocationKind: 'stopping' });
    expect(JSON.stringify(records)).not.toContain(credential);
    expect(JSON.stringify(records)).not.toContain(rawCredential);
  });

  it('records the old and new allocation ids on an allocation transition', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { allocationId } = launchIdentity(provider);
    const records = await runInDurableObject(stub, async instance => {
      const captured: Record<string, unknown>[] = [];
      const withFields = vi.spyOn(logger, 'withFields').mockImplementation(fields => {
        const bounded = fields as unknown as Record<string, unknown>;
        if (bounded.diagnosticEvent === 'allocation_transition') captured.push(bounded);
        return logger;
      });
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      try {
        await instance.reportProviderGone();
        await instance.ensureAllocation();
      } finally {
        withFields.mockRestore();
        info.mockRestore();
      }
      return captured;
    });
    const reset = records.find(record => record.event === 'provider-gone');
    expect(reset).toMatchObject({
      from: 'starting',
      to: 'stopped',
      fromAllocationId: allocationId,
      toAllocationId: null,
    });
    const replacement = records.find(record => record.event === 'ensure');
    const current = await readState(stub);
    expect(replacement).toMatchObject({
      from: 'stopped',
      to: 'creating',
      fromAllocationId: null,
      toAllocationId: current.allocationId,
    });
    expect(current.allocationId).not.toBe(allocationId);
  });

  it('does not accept a late hello after its deadline or move allocation and route state', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    await insertPreparingRoute(stub, {
      sessionId: 'waiting',
      attemptDeadlineAt: Date.now() + 12 * MINUTE,
    });
    const before = await readState(stub);
    const { credential, allocationId } = launchIdentity(provider);
    const candidate = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        helloDeadlineAt: Date.now() - 1,
      });
    });
    expect(await candidate.hello({ wrapperId: 'wr_late', allocationId })).toBeNull();
    await expect(candidate.waitForClose()).resolves.toBe(1008);
    expect(await readState(stub)).toEqual(before);
    expect((await stub.status({ sessionId: 'waiting' })).view.state).toBe('preparing');
    expect(provider.stopCalls).toEqual([]);
    expect(provider.leaseCalls).toEqual([]);
  });

  it('ignores unbound control-result frames instead of settling a bound wrapper request', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { wrapper, credential } = await connectAndHello(provider, stub);
    const candidate = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    let settled = false;
    const pending = stub
      .worktreeCapture({
        operation: 'summary',
        session: {
          sessionId: 'workspace_test',
          kiloSessionId: 'ses_test',
          directory: '/workspace/test',
        },
        payload: { revision: 1 },
      })
      .then(result => {
        settled = true;
        return result;
      });
    const frame = await wrapper.next();
    if (frame?.type !== 'worktree.summary') throw new Error('Missing bound request');
    candidate.send({
      type: 'worktree.result',
      requestId: frame.requestId,
      ok: true,
      result: { source: 'unbound' },
    });
    await candidate.hello({ wrapperId: 'invalid', allocationId: 'stale' });
    expect(settled).toBe(false);
    wrapper.send({
      type: 'worktree.result',
      requestId: frame.requestId,
      ok: true,
      result: { source: 'bound' },
    });
    expect(await pending).toEqual({ ok: true, result: { source: 'bound' } });
  });

  it('expires a candidate while keeping the healthy bound connection and its alarm unchanged', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    const { wrapper, credential } = await connectAndHello(provider, stub);
    const before = await readState(stub);
    const candidate = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state
        .getWebSockets()
        .find(ws => ws.deserializeAttachment().helloDeadlineAt !== undefined);
      if (!socket) throw new Error('Missing candidate');
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        helloDeadlineAt: Date.now() - 1,
      });
    });
    await evictAllDurableObjects();
    await runAlarm(stub);
    await expect(candidate.waitForClose()).resolves.toBe(1008);
    expect(await readState(stub)).toEqual(before);
    expect(await readAlarm(stub)).toBe((before.lastFrameAt ?? 0) + TIMERS.heartbeatMs);
    wrapper.heartbeat(false);
    await waitFor(async () =>
      expect((await readState(stub)).lastFrameAt).toBeGreaterThan(before.lastFrameAt ?? 0)
    );
    expect((await readState(stub)).connectionId).toBe(before.connectionId);
    expect(provider.stopCalls).toEqual([]);
  });

  it('creates, launches and accepts a hello as connected', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));

    const starting = await readState(stub);
    expect(starting.provider).toBe('cloudflare');
    expect(await readAlarm(stub)).toBe(starting.firstConnectDeadlineAt);

    const { credential, allocationId } = launchIdentity(provider);
    expect(credential.length).toBeGreaterThan(0);
    const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper.hello({ wrapperId: 'wr_hello', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });

    const state = await readState(stub);
    expect(state.kind).toBe('connected');
    expect(state.wrapperId).toBe('wr_hello');
    expect(state.allocationId).toBe(allocationId);
    expect(state.providerRef).toBe(provider.refs[0]);
    expect(await readAlarm(stub)).toBe((state.lastFrameAt ?? 0) + TIMERS.heartbeatMs);
  });

  it('passes billing and containment into the create intent', async () => {
    const provider = createFakeProvider();
    const billing = { marker: 'billing' };
    await startAllocation(provider, { billing, containment: { kilocode: true } });
    await awaitLaunch(provider);

    expect(provider.createInputs[0]?.billing).toEqual(billing);
    expect(provider.createInputs[0]?.containment).toEqual({ kilocode: true });
  });

  it('stops the sandbox when the wrapper never connects within the first-connect window', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);

    await setDeadline(stub, { first_connect_deadline_at: Date.now() - 1 });
    await runAlarm(stub);

    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(provider.stopCalls).toEqual([provider.refs[0]]);
    expect(await readAlarm(stub)).toBeNull();
  });

  it('treats a missing heartbeat as a lost socket and marks the allocation disconnected', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { wrapper } = await connectAndHello(provider, stub);

    await setDeadline(stub, { last_frame_at: Date.now() - 60_000 });
    await runAlarm(stub);

    await waitFor(async () => expect((await readState(stub)).kind).toBe('disconnected'));
    await expect(wrapper.waitForClose()).resolves.toBe(1000);
    const state = await readState(stub);
    expect(await readAlarm(stub)).toBe((state.lastFrameAt ?? 0) + TIMERS.reconnectMs);
  });

  it('reconnects while the last frame is inside the reconnect window', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { credential, allocationId } = await connectAndHello(provider, stub);

    await setDeadline(stub, { last_frame_at: Date.now() - 60_000 });
    await runAlarm(stub);
    await waitFor(async () => expect((await readState(stub)).kind).toBe('disconnected'));
    const disconnected = await readState(stub);

    const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper.hello({ wrapperId: 'wr_reconnect', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });

    const state = await readState(stub);
    expect(state.kind).toBe('connected');
    expect(state.wrapperId).toBe('wr_reconnect');
    // M3: reconnecting refreshes liveness but must not extend the idle window.
    expect(state.lastActivityAt).toBe(disconnected.lastActivityAt);
    expect(await readAlarm(stub)).toBe((state.lastFrameAt ?? 0) + TIMERS.heartbeatMs);
    expect(provider.stopCalls).toEqual([]);
  });

  it('stops the sandbox after the reconnect window elapses in silence', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    await connectAndHello(provider, stub);

    await setDeadline(stub, { last_frame_at: Date.now() - 60_000 });
    await runAlarm(stub);
    await waitFor(async () => expect((await readState(stub)).kind).toBe('disconnected'));

    await setDeadline(stub, { last_frame_at: Date.now() - (5 * MINUTE + 1_000) });
    await runAlarm(stub);

    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(provider.stopCalls).toEqual([provider.refs[0]]);
  });

  it('rejects a stale hello with shutdown and closes the socket', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { credential } = launchIdentity(provider);

    const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper.hello({ wrapperId: 'wr_stale', allocationId: 'stale-allocation' });
    expect(reply).toEqual({ type: 'shutdown', reason: 'hello_rejected' });
    await expect(wrapper.waitForClose()).resolves.toBe(1008);

    expect((await readState(stub)).kind).toBe('starting');
  });

  it('rejects an unsupported protocol version with shutdown', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { credential, allocationId } = launchIdentity(provider);

    const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper.hello({ wrapperId: 'wr_old', allocationId, protocolVersion: 1 });
    expect(reply).toEqual({ type: 'shutdown', reason: 'unsupported_protocol_version' });
    await expect(wrapper.waitForClose()).resolves.toBe(1008);
    expect((await readState(stub)).kind).toBe('starting');
  });

  it('sends shutdown (not 401) for a bad credential hello', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { allocationId } = launchIdentity(provider);

    const wrapper = await FakeWrapper.connect({
      sandboxId: SANDBOX_ID,
      credential: 'wrong-credential',
    });
    const reply = await wrapper.hello({ wrapperId: 'wr_bad', allocationId });
    expect(reply).toEqual({ type: 'shutdown', reason: 'hello_rejected' });
    await expect(wrapper.waitForClose()).resolves.toBe(1008);
    expect((await readState(stub)).kind).toBe('starting');
  });

  it('ignores a pre-hello heartbeat sent on a second socket while connected', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { credential } = await connectAndHello(provider, stub, 'wr_a');

    const other = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    other.heartbeat(true);
    // Ordering on one socket: the heartbeat is processed before this hello.
    const reply = await other.hello({ wrapperId: 'wr_b', allocationId: 'stale' });
    expect(reply).toEqual({ type: 'shutdown', reason: 'hello_rejected' });
    await other.waitForClose();

    expect(provider.leaseCalls).toHaveLength(0);
    const state = await readState(stub);
    expect(state.kind).toBe('connected');
    expect(state.wrapperId).toBe('wr_a');
  });

  it('does not disconnect when a replaced socket closes', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { credential, allocationId } = await connectAndHello(provider, stub, 'wr_first');
    const firstConnectionId = (await readState(stub)).connectionId;
    expect(firstConnectionId).not.toBeNull();

    const replacement = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await replacement.hello({ wrapperId: 'wr_second', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
    await waitFor(async () => expect((await readState(stub)).wrapperId).toBe('wr_second'));

    // Deliver the replaced socket's close directly, with its stale connection id.
    await runInDurableObject(stub, async instance => {
      const stale = {
        deserializeAttachment: () => ({
          credential: null,
          allocationId,
          connectionId: firstConnectionId,
          wrapperId: 'wr_first',
        }),
      } as unknown as WebSocket;
      await instance.webSocketClose(stale);
    });

    const state = await readState(stub);
    expect(state.kind).toBe('connected');
    expect(state.wrapperId).toBe('wr_second');
  });

  it('does not disconnect when a rejected socket closes', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { credential } = await connectAndHello(provider, stub);

    const rejected = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await rejected.hello({ wrapperId: 'wr_rejected', allocationId: 'stale' });
    expect(reply).toEqual({ type: 'shutdown', reason: 'hello_rejected' });
    await rejected.waitForClose();

    expect((await readState(stub)).kind).toBe('connected');
  });

  it('renews the provider lease for an active heartbeat but not an idle one', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { wrapper } = await connectAndHello(provider, stub);

    wrapper.heartbeat(true);
    await waitFor(() => expect(provider.leaseCalls).toHaveLength(1));
    const activeState = await readState(stub);
    expect(activeState.lastActivityAt).not.toBeNull();

    const activityBefore = activeState.lastActivityAt;
    wrapper.heartbeat(false);
    await waitFor(async () => {
      const state = await readState(stub);
      expect(state.lastFrameAt).not.toBe(activeState.lastFrameAt);
    });

    expect(provider.leaseCalls).toHaveLength(1);
    expect((await readState(stub)).lastActivityAt).toBe(activityBefore);
  });

  it('persists liveness on the heartbeat, not on every event frame', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    const { wrapper } = await connectAndHello(provider, stub);
    const leasesBefore = provider.leaseCalls.length;
    const frameSentAt = Date.now();

    const writes = await countAllocationWrites(stub, async () => {
      // An event frame only means the socket is alive and persists nothing.
      wrapper.send({ type: 'session.progress', sessionId: 'sess-no-route', step: 'clone' });
      // The heartbeat is the periodic write the timers rely on, and the barrier
      // that proves the event frame ahead of it was processed.
      wrapper.heartbeat(true);
      await waitFor(() => expect(provider.leaseCalls.length).toBeGreaterThan(leasesBefore));
    });

    // Exactly one write: the heartbeat. The event frame persists nothing.
    expect(writes).toBe(1);

    const persisted = await readState(stub);
    expect(persisted.lastFrameAt).toBeGreaterThanOrEqual(frameSentAt);
    expect(await readAlarm(stub)).toBe((persisted.lastFrameAt ?? 0) + TIMERS.heartbeatMs);
  });

  it('stops immediately when the provider reports the sandbox gone', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitLaunch(provider);
    await connectAndHello(provider, stub);

    await runInDurableObject(stub, instance => instance.reportProviderGone());

    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(await readAlarm(stub)).toBeNull();
  });

  it('retries a failed create while a route attempt deadline remains', async () => {
    const provider = createFakeProvider({ failFirstCreate: true });
    const stub = sandboxNamespace.getByName(SANDBOX_ID);
    await insertPreparingRoute(stub, {
      sessionId: 'sess-1',
      // The real 12-min attempt deadline outlasts the 5-min first-connect
      // deadline, so the allocation alarm stays the earlier of the two.
      attemptDeadlineAt: Date.now() + 12 * MINUTE,
    });
    await startAllocation(provider);

    await waitFor(async () => expect((await readState(stub)).kind).toBe('creating'));
    let state = await readState(stub);
    expect(provider.createCalls).toBe(1);
    expect(state.providerRef).toBeNull();
    const firstAllocationId = state.allocationId;

    await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
    await runAlarm(stub);

    await waitFor(() => expect(provider.createCalls).toBe(2));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));
    state = await readState(stub);
    expect(state.allocationId).not.toBe(firstAllocationId);
    expect(await readAlarm(stub)).toBe(state.firstConnectDeadlineAt);
  });

  it('stops after a failed create when only a passed route deadline remains', async () => {
    const provider = createFakeProvider({ failFirstCreate: true });
    const stub = sandboxNamespace.getByName(SANDBOX_ID);
    await insertPreparingRoute(stub, {
      sessionId: 'sess-passed',
      attemptDeadlineAt: Date.now() - 1_000,
    });
    await startAllocation(provider);

    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(provider.createCalls).toBe(1);
    expect(await readAlarm(stub)).toBeNull();
  });

  it('keeps retrying when another route has a later deadline', async () => {
    const provider = createFakeProvider({ failFirstCreate: true });
    const stub = sandboxNamespace.getByName(SANDBOX_ID);
    await insertPreparingRoute(stub, {
      sessionId: 'sess-passed',
      attemptDeadlineAt: Date.now() - 1_000,
    });
    await insertPreparingRoute(stub, {
      sessionId: 'sess-later',
      attemptDeadlineAt: Date.now() + 5 * MINUTE,
    });
    await startAllocation(provider);

    await waitFor(async () => expect((await readState(stub)).kind).toBe('creating'));
    await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
    await runAlarm(stub);

    await waitFor(() => expect(provider.createCalls).toBe(2));
  });

  it('re-issues exactly one stop per backstop and ignores a superseded result', async () => {
    const provider = createFakeProvider({ gateStop: true });
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);

    await setDeadline(stub, { first_connect_deadline_at: Date.now() - 1 });
    await runAlarm(stub);
    await waitFor(() => expect(provider.stopGates).toHaveLength(1));
    let state = await readState(stub);
    expect(state.kind).toBe('stopping');
    expect(state.stopAttempt).toBe(1);

    // Backstop fires while attempt 1 is still in flight: supersede once.
    await setDeadline(stub, { stop_at: Date.now() - 1 });
    await runAlarm(stub);
    await waitFor(() => expect(provider.stopGates).toHaveLength(2));
    expect(provider.stopCalls).toHaveLength(2);
    state = await readState(stub);
    expect(state.stopAttempt).toBe(2);
    const stopAtAfter = state.stopAt;

    // A late result for the superseded attempt must not advance the ladder.
    await releaseGate(stub, () => provider.stopGates[0]('retryable'));
    state = await readState(stub);
    expect(state.stopAttempt).toBe(2);
    expect(state.stopAt).toBe(stopAtAfter);
    expect(provider.stopCalls).toHaveLength(2);

    await releaseGate(stub, () => provider.stopGates[1]('terminal'));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(await readAlarm(stub)).toBeNull();
  });

  it('does not overlap create attempts', async () => {
    const provider = createFakeProvider({ gateCreate: true, gateLaunch: true });
    const stub = await startAllocation(provider);
    await waitFor(() => expect(provider.createGates).toHaveLength(1));

    await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
    await runAlarm(stub);
    expect(provider.createCalls).toBe(1);

    await setDeadline(stub, { create_deadline_at: Date.now() + MINUTE });
    await releaseGate(stub, () => provider.createGates[0]({ providerRef: provider.refs[0] }));
    await waitFor(() => expect(provider.launchGates).toHaveLength(1));

    await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
    await runAlarm(stub);
    expect(provider.createCalls).toBe(1);
    expect(provider.launchGates).toHaveLength(1);

    await setDeadline(stub, { create_deadline_at: Date.now() + MINUTE });
    await releaseGate(stub, () => provider.launchGates[0]());
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));
  });

  it('bounds create and launch together by the create deadline', async () => {
    const provider = createFakeProvider({ gateCreate: true, gateLaunch: true });
    const stub = await startAllocation(provider);
    await waitFor(() => expect(provider.createGates).toHaveLength(1));

    // The shared bound is already short when create resolves; launch must obey it.
    await setDeadline(stub, { create_deadline_at: Date.now() + 150 });
    await releaseGate(stub, () => provider.createGates[0]({ providerRef: provider.refs[0] }));
    await waitFor(() => expect(provider.launchGates).toHaveLength(1));

    await waitFor(() => expect(provider.stopCalls).toContain(provider.refs[0]));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
  });

  it('accepts a hello during creating and keeps the persisted ref for a later stop', async () => {
    const provider = createFakeProvider({ gateLaunch: true });
    const stub = await startAllocation(provider);
    await waitFor(() => expect(provider.launchGates).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);

    let state = await readState(stub);
    expect(state.kind).toBe('creating');
    expect(state.providerRef).toBe(provider.refs[0]);

    const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper.hello({ wrapperId: 'wr_early', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
    state = await readState(stub);
    expect(state.kind).toBe('connected');
    expect(state.providerRef).toBe(provider.refs[0]);

    await releaseGate(stub, () => provider.launchGates[0]());
    expect((await readState(stub)).kind).toBe('connected');

    await setDeadline(stub, { last_activity_at: Date.now() - (10 * MINUTE + 1_000) });
    await runAlarm(stub);
    await waitFor(() => expect(provider.stopCalls).toContain(provider.refs[0]));
  });

  it('rebuilds its provider adapter from the stored pin after eviction', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider, { allocationName: CUSTOM_ALLOCATION_NAME });
    await awaitLaunch(provider);
    const { allocationId } = await connectAndHello(provider, stub);
    const before = await readState(stub);
    expect(before.provider).toBe('cloudflare');

    await evictAllDurableObjects();
    // No fake re-install: the reloaded instance must rebuild from the pin.
    await runInDurableObject(stub, instance => instance.getAllocationState());

    const after = await readState(stub);
    expect(after.providerRef).toBe(before.providerRef);
    expect(after.allocationId).toBe(allocationId);
    expect(after.provider).toBe('cloudflare');
    const runtime = await runInDurableObject(stub, instance => instance.getProviderRuntime());
    expect(runtime).toEqual({ provider: 'cloudflare', allocationName: CUSTOM_ALLOCATION_NAME });
    const pin = await readProviderPin(stub);
    expect(pin === null ? null : JSON.parse(pin)).toMatchObject({
      provider: 'cloudflare',
      allocationName: CUSTOM_ALLOCATION_NAME,
    });
  });

  it('renews the lease after eviction using the persisted ref', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider, { allocationName: CUSTOM_ALLOCATION_NAME });
    await awaitLaunch(provider);
    const { credential, allocationId } = await connectAndHello(provider, stub);
    const before = await readState(stub);

    await evictAllDurableObjects();
    await runInDurableObject(stub, async instance => {
      await instance.getAllocationState();
      // Observe the lease call without hiding the rebuild assertion above.
      Object.assign(instance, { provider: provider.adapter });
    });

    const reconnected = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await reconnected.hello({ wrapperId: 'wr_after_evict', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
    await waitFor(async () => expect((await readState(stub)).kind).toBe('connected'));

    reconnected.heartbeat(true);
    await waitFor(() => expect(provider.leaseRefs.length).toBeGreaterThan(0));
    expect(provider.leaseRefs[0]).toBe(before.providerRef);
  });

  it('does not destroy a sandbox that connected while launch was failing', async () => {
    const provider = createFakeProvider({ gateLaunch: true });
    const stub = await startAllocation(provider);
    await waitFor(() => expect(provider.launchGates).toHaveLength(1));
    const { credential, allocationId } = launchIdentity(provider);

    const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper.hello({ wrapperId: 'wr_n5', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
    expect((await readState(stub)).kind).toBe('connected');

    await releaseGate(stub, () => provider.launchGates[0](new Error('launch failed')));

    const state = await readState(stub);
    expect(state.kind).toBe('connected');
    expect(state.providerRef).toBe(provider.refs[0]);
    expect(provider.stopCalls).toEqual([]);
  });

  it('wipes old-plane storage and stops the old allocation before any create', async () => {
    let stub = sandboxNamespace.getByName(CUTOVER_SANDBOX_ID);
    // First access establishes the V2 generation and tables.
    await runInDurableObject(stub, instance => instance.getAllocationState());

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete('control_plane_generation');
      await state.storage.put('provider_kind', 'cloudflare');
      await state.storage.put('provider_configuration', { provider: 'cloudflare' });
      await state.storage.put('sandbox_allocation_state', {
        state: {
          kind: 'allocated',
          target: {
            providerRef: 'legacy-provider-ref',
            allocationName: LEGACY_ALLOCATION_NAME,
          },
        },
      });
    });

    // Evict so the cutover wipe runs, and evict again before the stop so the
    // stop must read the persisted provider ref rather than in-memory state.
    await evictAllDurableObjects();
    stub = sandboxNamespace.getByName(CUTOVER_SANDBOX_ID);
    await runInDurableObject(stub, instance => instance.getAllocationState());
    await evictAllDurableObjects();
    stub = sandboxNamespace.getByName(CUTOVER_SANDBOX_ID);

    const provider = createFakeProvider();
    await runInDurableObject(stub, async instance => {
      await instance.getAllocationState();
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
      await instance.ensureAllocation({
        provider: 'cloudflare',
        allocationName: LEGACY_ALLOCATION_NAME,
      });
    });

    const stopping = await readState(stub);
    expect(stopping.kind).toBe('stopping');
    expect(stopping.providerRef).toBe('legacy-provider-ref');
    expect(await readAlarm(stub)).not.toBeNull();
    expect(provider.createCalls).toBe(0);

    const persistedPin = await readProviderPin(stub);
    expect(persistedPin === null ? null : JSON.parse(persistedPin)).toMatchObject({
      provider: 'cloudflare',
      allocationName: LEGACY_ALLOCATION_NAME,
      configuration: { provider: 'cloudflare' },
    });
    const runtime = await runInDurableObject(stub, instance => instance.getProviderRuntime());
    expect(runtime).toEqual({ provider: 'cloudflare', allocationName: LEGACY_ALLOCATION_NAME });

    // Move the backstop into the past and let the alarm run the stop ladder.
    await setDeadline(stub, { stop_at: Date.now() - 1 });
    await runAlarm(stub);
    await waitFor(() => expect(provider.stopCalls).toEqual(['legacy-provider-ref']));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(provider.createCalls).toBe(0);
    expect(provider.launchEnvs).toHaveLength(0);

    const leftovers = await runInDurableObject(stub, async (_instance, state) => ({
      kind: await state.storage.get('provider_kind'),
      configuration: await state.storage.get('provider_configuration'),
      allocation: await state.storage.get('sandbox_allocation_state'),
    }));
    expect(leftovers.kind).toBeUndefined();
    expect(leftovers.configuration).toBeUndefined();
    expect(leftovers.allocation).toBeUndefined();
  });

  it('preserves the provider ref when the stop ladder is exhausted without confirmation', async () => {
    const provider = createFakeProvider({ gateStop: true });
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);

    await setDeadline(stub, { first_connect_deadline_at: Date.now() - 1 });
    await runAlarm(stub);
    await waitFor(() => expect(provider.stopGates).toHaveLength(1));

    const maxAttempts = TIMERS.providerStopLadderMs.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await waitFor(() => expect(provider.stopGates).toHaveLength(attempt));
      await releaseGate(stub, () => provider.stopGates[attempt - 1]('retryable'));
      if (attempt < maxAttempts) {
        await waitFor(async () => expect((await readState(stub)).stopPending).toBe(true));
        await setDeadline(stub, { stop_at: Date.now() - 1 });
        await runAlarm(stub);
      }
    }

    await waitFor(async () => {
      const state = await readState(stub);
      expect(state.kind).toBe('stopped');
      expect(state.providerRef).toBeNull();
      expect(state.unconfirmedProviderRef).toBe(provider.refs[0]);
    });
    expect(await readAlarm(stub)).toBeNull();
    expect(provider.stopCalls).toHaveLength(maxAttempts);
  });

  it('preserves an unsettled billing continuation during the legacy storage cutover', async () => {
    const sandboxId = `ses-${'e'.repeat(48)}`;
    let stub = sandboxNamespace.getByName(sandboxId);
    const billing = {
      sandboxId,
      subject: { type: 'user' as const, id: 'owner-1' },
      actor: { type: 'user' as const, id: 'owner-1' },
      sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      metadata: { origin: 'cloud-agent' },
      enforcementRequested: true,
    };
    const dueAtMs = Date.now() + MINUTE;
    await runInDurableObject(stub, instance => instance.getAllocationState());
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete('control_plane_generation');
      await state.storage.put('provider_kind', 'vercel');
      await state.storage.put('billing_input', billing);
      await state.storage.put(VERCEL_BILLING_SCHEDULE_KEY, {
        [VERCEL_BILLING_SETTLEMENT_CALLBACK]: {
          dueAtMs,
          payload: 'generation-1',
        },
      });
      await state.storage.put('container-usage:start-ack-generation:v1', 'generation-1');
    });
    await evictAllDurableObjects();
    stub = sandboxNamespace.getByName(sandboxId);
    await stub.getAllocationState();
    const retained = await runInDurableObject(stub, async (_instance, state) => ({
      schedule: await state.storage.get<BillingScheduleEntries>(VERCEL_BILLING_SCHEDULE_KEY),
      acknowledgement: await state.storage.get('container-usage:start-ack-generation:v1'),
    }));
    expect(retained.schedule?.[VERCEL_BILLING_SETTLEMENT_CALLBACK]?.dueAtMs).toBe(dueAtMs);
    expect(retained.acknowledgement).toBe('generation-1');
    expect(await readAlarm(stub)).toBe(dueAtMs);
    expect(JSON.parse((await readProviderPin(stub)) ?? '{}').billing).toMatchObject(billing);
  });

  it('keeps a legacy sandbox recoverable when its optional billing input is malformed', async () => {
    const sandboxId = `ses-${'e'.repeat(47)}f`;
    let stub = sandboxNamespace.getByName(sandboxId);
    await runInDurableObject(stub, instance => instance.getAllocationState());
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete('control_plane_generation');
      await state.storage.put('provider_kind', 'vercel');
      await state.storage.put('billing_input', { invalid: true });
    });
    await evictAllDurableObjects();
    stub = sandboxNamespace.getByName(sandboxId);
    expect((await stub.getAllocationState()).kind).toBe('stopped');
    expect(JSON.parse((await readProviderPin(stub)) ?? '{}').billing).toBeNull();
  });

  it.each(['acked', 'insufficient', 'uncertain', 'budget'] as const)(
    'admits Vercel create only after %s billing admission settles',
    async result => {
      const sandboxId = `ses-${(result === 'acked' ? 'a' : result === 'insufficient' ? 'b' : result === 'budget' ? 'd' : 'c').repeat(48)}`;
      const provider = createFakeProvider({ gateStop: result === 'budget' });
      const providerRef = encodeVercelProviderRef({ sandboxName: sandboxId, sessionId: 'vsess_1' });
      provider.adapter.create = async intent => {
        provider.createCalls++;
        provider.createInputs.push(intent);
        return { providerRef };
      };
      const starts: string[] = [];
      const stops: number[] = [];
      const heartbeats: number[] = [];
      const meter: ContainerUsageRpcMethods = {
        async recordStart(input) {
          starts.push(input.instanceId);
          if (result === 'uncertain') throw new Error('Meter unavailable');
          if (result === 'insufficient')
            return {
              success: false,
              error: { code: 'insufficient_credits', message: 'No credits' },
            };
          return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
        },
        async recordHeartbeat(input) {
          heartbeats.push(input.usageSinceLast);
          return {
            intervalId: 'interval-1',
            durable: 'pg',
            dedup: false,
            budget: { verdict: result === 'budget' ? 'stop' : 'continue' },
          };
        },
        async recordStop(input) {
          stops.push(input.usageSinceLast);
          return { intervalId: 'interval-1', durable: 'pg', dedup: false };
        },
      };
      const stub = await startAllocation(provider, {
        sandboxId,
        provider: 'vercel',
        configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
        billing: {
          sandboxId,
          subject: { type: 'user', id: 'owner-1' },
          actor: { type: 'user', id: 'owner-1' },
          sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          metadata: { origin: 'cloud-agent' },
          enforcementRequested: true,
        },
        meter,
        ...(result === 'insufficient'
          ? { preparingRoute: 'workspace_11111111-1111-4111-8111-111111111111' }
          : {}),
      });
      await waitFor(() => expect(starts).toContain(sandboxId));
      if (result === 'acked' || result === 'budget') {
        await waitFor(() => expect(provider.createCalls).toBe(1));
      } else {
        await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
        expect(provider.createCalls).toBe(0);
      }
      const billing = await runInDurableObject(stub, async (_instance, state) => ({
        context: await getBillingContext(state.storage),
        schedule: await state.storage.get<BillingScheduleEntries>(VERCEL_BILLING_SCHEDULE_KEY),
      }));
      expect(billing.context === undefined).toBe(result === 'insufficient');
      expect(billing.schedule?.[VERCEL_BILLING_SETTLEMENT_CALLBACK] !== undefined).toBe(
        result !== 'insufficient'
      );
      if (result === 'insufficient') {
        const row = await runInDurableObject(stub, async (_instance, state) => {
          const db = drizzle(state.storage, { logger: false });
          return db.select().from(routesTable);
        });
        expect(row[0]).toMatchObject({ state: 'failed', reason: 'billing_blocked' });
      }
      if (result === 'acked' || result === 'budget') {
        const createdAtMs = Date.now() - 20_000;
        const terminalAtMs = createdAtMs + 10_000;
        await runInDurableObject(stub, instance =>
          (
            instance as unknown as {
              recordVercelBillingLifetime: (evidence: {
                providerRef: string;
                createdAtMs: number;
              }) => Promise<void>;
            }
          ).recordVercelBillingLifetime({ providerRef, createdAtMs })
        );
        await stub.ensureAllocation();
        await runInDurableObject(stub, async instance => {
          const context = await getBillingContext(instance.ctx.storage);
          if (context === undefined) throw new Error('Billing interval was not opened');
          await (
            instance as unknown as {
              billingSchedule: {
                schedule(callback: string, at: number, generation: string): Promise<void>;
              };
            }
          ).billingSchedule.schedule(
            VERCEL_BILLING_SETTLEMENT_CALLBACK,
            Date.now() - 1,
            context.generation
          );
        });
        await runAlarm(stub);
        await waitFor(() => expect(heartbeats).toHaveLength(1));
        expect(heartbeats[0]).toBeGreaterThanOrEqual(19);
        if (result === 'budget') {
          await waitFor(() => expect(provider.stopCalls).toContain(providerRef));
          const generation = billing.context?.generation;
          if (generation === undefined) throw new Error('Expected active budget-stop generation');
          await runInDurableObject(stub, instance =>
            (
              instance as unknown as {
                billingSchedule: {
                  schedule(callback: string, at: number, generation: string): Promise<void>;
                };
              }
            ).billingSchedule.schedule('billingForceStop', Date.now() - 1, generation)
          );
          await runAlarm(stub);
          const forceSchedule = await runInDurableObject(stub, (_instance, state) =>
            state.storage.get<BillingScheduleEntries>(VERCEL_BILLING_SCHEDULE_KEY)
          );
          expect(forceSchedule?.billingForceStop).toBeDefined();
          await releaseGate(stub, () => provider.stopGates.shift()?.('terminal'));
          await waitFor(async () => {
            expect(
              await runInDurableObject(stub, (_instance, state) => getBillingContext(state.storage))
            ).toBeUndefined();
          });
          return;
        }
        await runInDurableObject(stub, instance =>
          (
            instance as unknown as {
              recordVercelBillingLifetime: (evidence: {
                providerRef: string;
                createdAtMs: number;
                terminalAtMs: number;
              }) => Promise<void>;
            }
          ).recordVercelBillingLifetime({ providerRef, createdAtMs, terminalAtMs })
        );
        await runAlarm(stub);
        await waitFor(() => expect(stops).toHaveLength(1));
        expect(stops[0]).toBe(0);
        await waitFor(async () => {
          const context = await runInDurableObject(stub, (_instance, state) =>
            getBillingContext(state.storage)
          );
          expect(context).toBeUndefined();
        });
      }
    }
  );

  it('settles an uncertain pre-create generation before retrying a preparing route', async () => {
    const sandboxId = `ses-${'f'.repeat(48)}`;
    const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
    let starts = 0;
    let stops = 0;
    let meterUnavailable = true;
    const meter: ContainerUsageRpcMethods = {
      async recordStart(input) {
        starts++;
        if (meterUnavailable) throw new Error('Meter temporarily unavailable');
        return {
          success: true,
          ack: { intervalId: `${input.startEpochMs}`, durable: 'pg', dedup: false },
        };
      },
      async recordHeartbeat() {
        return {
          intervalId: 'interval-1',
          durable: 'pg',
          dedup: false,
          budget: { verdict: 'continue' },
        };
      },
      async recordStop() {
        stops++;
        return { intervalId: 'interval-1', durable: 'pg', dedup: false };
      },
    };
    const provider = createFakeProvider();
    const stub = await startAllocation(provider, {
      sandboxId,
      provider: 'vercel',
      configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
      billing: {
        sandboxId,
        subject: { type: 'user', id: 'owner-1' },
        actor: { type: 'user', id: 'owner-1' },
        sessionId,
        metadata: { origin: 'cloud-agent' },
        enforcementRequested: true,
      },
      meter,
      preparingRoute: sessionId,
    });
    await waitFor(() => expect(starts).toBeGreaterThanOrEqual(1));
    await waitFor(async () => expect((await readState(stub)).kind).not.toBe('stopped'));
    await waitFor(async () =>
      expect(
        await runInDurableObject(stub, instance =>
          Promise.resolve((instance as unknown as { createInFlight: boolean }).createInFlight)
        )
      ).toBe(false)
    );
    const generation = await runInDurableObject(stub, (_instance, state) =>
      getBillingContext(state.storage)
    );
    if (generation === undefined) throw new Error('Expected an uncertain billing generation');
    expect(generation.measurementStarted).toBe(false);
    expect(provider.createCalls).toBe(0);
    meterUnavailable = false;
    await runInDurableObject(stub, async (instance, state) => {
      const current = await getBillingContext(state.storage);
      if (current?.generation !== generation.generation) return;
      await (
        instance as unknown as {
          billingSchedule: {
            schedule(callback: string, at: number, generation: string): Promise<void>;
          };
        }
      ).billingSchedule.schedule(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() - 1,
        generation.generation
      );
    });
    await runAlarm(stub);
    await waitFor(() => expect(stops).toBeGreaterThanOrEqual(1));
    await waitFor(async () => {
      const current = await runInDurableObject(stub, (_instance, state) =>
        getBillingContext(state.storage)
      );
      expect(current?.generation).not.toBe(generation.generation);
    });
    if (provider.createCalls === 0) {
      await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
      await runAlarm(stub);
    }
    await waitFor(() => expect(provider.createCalls).toBe(1));
    expect(starts).toBeGreaterThan(1);
  }, 20_000);

  it.each(['disconnected', 'stopping'] as const)(
    'retires a %s allocation with missing billing while preserving its preparing route',
    async existingState => {
      const sandboxId = `ses-${'d'.repeat(47)}${existingState === 'stopping' ? 'b' : 'a'}`;
      const meter: ContainerUsageRpcMethods = {
        async recordStart() {
          return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
        },
        async recordHeartbeat() {
          return {
            intervalId: 'interval-1',
            durable: 'pg',
            dedup: false,
            budget: { verdict: 'continue' },
          };
        },
        async recordStop() {
          return { intervalId: 'interval-1', durable: 'pg', dedup: false };
        },
      };
      const provider = createFakeProvider({ gateStop: existingState === 'stopping' });
      provider.adapter.updateNetworkPolicy = async ref => {
        if (ref === provider.refs[0]) throw new Error('Old sandbox is retiring');
      };
      const stub = await startAllocation(provider, {
        sandboxId,
        provider: 'vercel',
        configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
        billing: {
          sandboxId,
          subject: { type: 'user', id: 'owner-1' },
          actor: { type: 'user', id: 'owner-1' },
          sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          metadata: { origin: 'cloud-agent' },
          enforcementRequested: true,
        },
        meter,
      });
      await awaitStarting(provider, stub);
      if (existingState === 'disconnected') {
        await runInDurableObject(stub, async instance => {
          const state = await instance.getAllocationState();
          if (state.allocationId === null) throw new Error('Missing allocation');
          const applyEvent = (
            instance as unknown as {
              applyEvent(event: {
                type: 'hello-accepted' | 'socket-closed';
                at: number;
                allocationId: string;
                connectionId: string;
                wrapperId?: string;
              }): Promise<void>;
            }
          ).applyEvent.bind(instance);
          await applyEvent({
            type: 'hello-accepted',
            at: Date.now(),
            allocationId: state.allocationId,
            connectionId: 'conn-1',
            wrapperId: 'wr-1',
          });
          await applyEvent({
            type: 'socket-closed',
            at: Date.now(),
            allocationId: state.allocationId,
            connectionId: 'conn-1',
          });
        });
      } else {
        await runInDurableObject(stub, instance =>
          (
            instance as unknown as {
              applyEvent(event: {
                type: 'stop-requested';
                at: number;
                reason: 'sandbox_stopped';
              }): Promise<void>;
            }
          ).applyEvent({ type: 'stop-requested', at: Date.now(), reason: 'sandbox_stopped' })
        );
        await waitFor(() => expect(provider.stopGates).toHaveLength(1));
      }
      await runInDurableObject(stub, (_instance, state) => clearBillingContext(state.storage));
      await insertPreparingRoute(stub, {
        sessionId: 'workspace_missing_billing',
        attemptDeadlineAt: Date.now() + MINUTE,
      });
      const stopReasons: string[] = [];
      await runInDurableObject(stub, instance => {
        const original = (
          instance as unknown as {
            applyEvent(event: { type: string; reason?: string }): Promise<void>;
          }
        ).applyEvent.bind(instance);
        Object.assign(instance, {
          applyEvent: async (event: { type: string; reason?: string }) => {
            if (event.type === 'stop-requested' && event.reason !== undefined)
              stopReasons.push(event.reason);
            await original(event);
          },
        });
        return Promise.resolve();
      });
      const result = await stub.prepare({
        spec: {
          sessionId: 'workspace_missing_billing',
          kiloSessionId: 'kilo-missing-billing',
          directory: '/workspace/test',
          attemptId: 'attempt-1',
        },
        credentials: {
          userId: 'owner-1',
          kiloSessionId: 'kilo-missing-billing',
          kiloToken: 'test-token',
          scopeId: 'scope-1',
        },
      });
      expect(result).toMatchObject({ state: 'preparing' });
      if (existingState === 'disconnected') expect(stopReasons).toContain('sandbox_lost');
      if (existingState === 'stopping') {
        await releaseGate(stub, () => provider.stopGates.shift()?.('terminal'));
      }
      await waitFor(() => expect(provider.createCalls).toBe(2));
      expect(provider.createInputs[1]?.networkPolicy).toBeDefined();
      const route = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        return db
          .select()
          .from(routesTable)
          .where(eq(routesTable.session_id, 'workspace_missing_billing'));
      });
      expect(route[0]).toMatchObject({ state: 'preparing', reason: null });
    },
    20_000
  );

  it('rejects a blocked billing route before sending wrapper preparation', async () => {
    const sandboxId = `ses-${'d'.repeat(47)}c`;
    const meter: ContainerUsageRpcMethods = {
      async recordStart() {
        return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
      },
      async recordHeartbeat() {
        return {
          intervalId: 'interval-1',
          durable: 'pg',
          dedup: false,
          budget: { verdict: 'continue' },
        };
      },
      async recordStop() {
        return { intervalId: 'interval-1', durable: 'pg', dedup: false };
      },
    };
    const provider = createFakeProvider();
    const stub = await startAllocation(provider, {
      sandboxId,
      provider: 'vercel',
      configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
      billing: {
        sandboxId,
        subject: { type: 'user', id: 'owner-1' },
        actor: { type: 'user', id: 'owner-1' },
        sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        metadata: { origin: 'cloud-agent' },
        enforcementRequested: true,
      },
      meter,
    });
    await awaitStarting(provider, stub);
    const sent: string[] = [];
    await runInDurableObject(stub, instance => {
      const control = instance as unknown as {
        vercelBilling: { lifecycle: { isBillingBlocked(): Promise<boolean> } };
      };
      Object.assign(control.vercelBilling.lifecycle, { isBillingBlocked: async () => true });
      Object.assign(instance, { sendSessionPrepare: () => sent.push('prepare') });
      return Promise.resolve();
    });
    const result = await stub.prepare({
      spec: {
        sessionId: 'workspace_blocked_billing',
        kiloSessionId: 'kilo-blocked',
        directory: '/workspace/test',
        attemptId: 'attempt-1',
      },
      credentials: {
        userId: 'owner-1',
        kiloSessionId: 'kilo-blocked',
        kiloToken: 'test-token',
        scopeId: 'scope-1',
      },
    });
    expect(result).toMatchObject({ state: 'failed', reason: 'billing_blocked' });
    expect(sent).toEqual([]);
    const route = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      return db
        .select()
        .from(routesTable)
        .where(eq(routesTable.session_id, 'workspace_blocked_billing'));
    });
    expect(route[0]).toMatchObject({ state: 'failed', reason: 'billing_blocked' });
  });

  it.each([
    ['Invalid billing state', 'failed', 'billing_unavailable'],
    ['Vercel billing admission timed out', 'failed', 'billing_unavailable'],
    ['hang', 'preparing', null],
  ] as const)(
    'classifies thrown admission error %s without masking a definite failure as retry',
    async (error, routeState, reason) => {
      const sandboxId = `ses-${(error === 'hang' ? 'b' : error === 'Invalid billing state' ? 'a' : 'c').repeat(47)}d`;
      const provider = createFakeProvider();
      const meter: ContainerUsageRpcMethods = {
        async recordStart() {
          throw new Error('The admission override should run');
        },
        async recordHeartbeat() {
          throw new Error('The admission override should run');
        },
        async recordStop() {
          throw new Error('The admission override should run');
        },
      };
      const stub = await startAllocation(provider, {
        sandboxId,
        provider: 'vercel',
        configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
        billing: {
          sandboxId,
          subject: { type: 'user', id: 'owner-1' },
          actor: { type: 'user', id: 'owner-1' },
          sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          metadata: { origin: 'cloud-agent' },
          enforcementRequested: true,
        },
        meter,
        preparingRoute: 'workspace_admission_error',
        admissionError: error,
      });
      await waitFor(async () => {
        const rows = await runInDurableObject(stub, async (_instance, state) => {
          const db = drizzle(state.storage, { logger: false });
          return db
            .select()
            .from(routesTable)
            .where(eq(routesTable.session_id, 'workspace_admission_error'));
        });
        expect(rows[0]).toMatchObject({ state: routeState, reason });
      });
      expect(provider.createCalls).toBe(0);
      expect((await readState(stub)).kind).toBe(routeState === 'failed' ? 'stopped' : 'creating');
    }
  );

  it('expires a route even when billing continuation fails', async () => {
    const provider = createFakeProvider();
    const stub = await startAllocation(provider);
    await awaitStarting(provider, stub);
    await insertPreparingRoute(stub, {
      sessionId: 'workspace_alarm',
      attemptDeadlineAt: Date.now() - 1,
    });
    await runInDurableObject(stub, instance => {
      Object.assign(instance, {
        runBillingAlarm: async () => {
          throw new Error('Meter unavailable');
        },
      });
      return Promise.resolve();
    });
    await runAlarm(stub);
    const row = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      return db.select().from(routesTable).where(eq(routesTable.session_id, 'workspace_alarm'));
    });
    expect(row[0]).toMatchObject({ state: 'failed', reason: 'preparation_timeout' });
  });

  it.each(['provider-gone', 'confirmed-stop'] as const)(
    'settles measured billing before reallocating a preparing route after %s',
    async termination => {
      const sandboxId = `ses-${(termination === 'provider-gone' ? 'b' : 'c').repeat(47)}a`;
      let stops = 0;
      const meter: ContainerUsageRpcMethods = {
        async recordStart() {
          return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
        },
        async recordHeartbeat() {
          return {
            intervalId: 'interval-1',
            durable: 'pg',
            dedup: false,
            budget: { verdict: 'continue' },
          };
        },
        async recordStop() {
          stops++;
          return { intervalId: 'interval-1', durable: 'pg', dedup: false };
        },
      };
      const provider = createFakeProvider();
      const stub = await startAllocation(provider, {
        sandboxId,
        provider: 'vercel',
        configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
        billing: {
          sandboxId,
          subject: { type: 'user', id: 'owner-1' },
          actor: { type: 'user', id: 'owner-1' },
          sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          metadata: { origin: 'cloud-agent' },
          enforcementRequested: true,
        },
        meter,
      });
      await awaitStarting(provider, stub);
      const providerRef = provider.refs[0];
      if (providerRef === undefined) throw new Error('Missing created provider reference');
      await runInDurableObject(stub, instance =>
        (
          instance as unknown as {
            recordVercelBillingLifetime(evidence: {
              providerRef: string;
              createdAtMs: number;
            }): Promise<void>;
          }
        ).recordVercelBillingLifetime({ providerRef, createdAtMs: Date.now() - 20_000 })
      );
      await stub.ensureAllocation();
      await waitFor(async () => {
        const context = await runInDurableObject(stub, (_instance, state) =>
          getBillingContext(state.storage)
        );
        expect(context?.measurementStarted).toBe(true);
      });
      await insertPreparingRoute(stub, {
        sessionId: 'workspace_recover',
        attemptDeadlineAt: Date.now() + MINUTE,
      });
      if (termination === 'provider-gone') {
        await stub.reportProviderGone();
      } else {
        await runInDurableObject(stub, instance =>
          (
            instance as unknown as {
              applyEvent(event: {
                type: 'stop-requested';
                at: number;
                reason: 'sandbox_stopped';
              }): Promise<void>;
            }
          ).applyEvent({ type: 'stop-requested', at: Date.now(), reason: 'sandbox_stopped' })
        );
      }
      await waitFor(() => expect(stops).toBeGreaterThanOrEqual(1));
      if (provider.createCalls === 1) {
        await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
        await runAlarm(stub);
      }
      await waitFor(() => expect(provider.createCalls).toBe(2));
    },
    20_000
  );

  it.each(['stop', 'observation'] as const)(
    'settles a bound Vercel ref after launch fails via %s before retrying its route',
    async terminalEvidence => {
      const sandboxId = `ses-${(terminalEvidence === 'stop' ? 'a' : 'b').repeat(47)}e`;
      let stops = 0;
      const meter: ContainerUsageRpcMethods = {
        async recordStart() {
          return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
        },
        async recordHeartbeat() {
          return {
            intervalId: 'interval-1',
            durable: 'pg',
            dedup: false,
            budget: { verdict: 'continue' },
          };
        },
        async recordStop() {
          stops++;
          return { intervalId: 'interval-1', durable: 'pg', dedup: false };
        },
      };
      const provider = createFakeProvider({ gateLaunch: true });
      provider.stopResults.push('retryable', 'terminal');
      if (terminalEvidence === 'observation') {
        provider.adapter.observe = async () => ({ status: 'terminal' });
      }
      const stub = await startAllocation(provider, {
        sandboxId,
        provider: 'vercel',
        configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
        billing: {
          sandboxId,
          subject: { type: 'user', id: 'owner-1' },
          actor: { type: 'user', id: 'owner-1' },
          sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          metadata: { origin: 'cloud-agent' },
          enforcementRequested: true,
        },
        meter,
        preparingRoute: 'workspace_retry_launch',
      });
      await awaitLaunch(provider);
      const ref = provider.refs[0];
      if (ref === undefined) throw new Error('Expected a created Vercel ref');
      await runInDurableObject(stub, instance =>
        (
          instance as unknown as {
            recordVercelBillingLifetime(evidence: {
              providerRef: string;
              createdAtMs: number;
            }): Promise<void>;
          }
        ).recordVercelBillingLifetime({ providerRef: ref, createdAtMs: Date.now() - 20_000 })
      );
      await releaseGate(stub, () => provider.launchGates.shift()?.(new Error('launch failed')));
      await waitFor(() => expect(provider.stopCalls).toEqual([ref]));
      await waitFor(async () => expect((await readState(stub)).kind).toBe('creating'));
      const billing = await runInDurableObject(stub, (_instance, state) =>
        getBillingContext(state.storage)
      );
      expect(billing?.pendingStop).toBeUndefined();
      expect(provider.createCalls).toBe(1);
      if (billing === undefined) throw new Error('Expected unsettled generation');
      await runInDurableObject(stub, instance =>
        (
          instance as unknown as {
            billingSchedule: {
              schedule(callback: string, at: number, generation: string): Promise<void>;
            };
          }
        ).billingSchedule.schedule(
          VERCEL_BILLING_SETTLEMENT_CALLBACK,
          Date.now() - 1,
          billing.generation
        )
      );
      await runAlarm(stub);
      await waitFor(() =>
        expect(provider.stopCalls).toEqual(terminalEvidence === 'stop' ? [ref, ref] : [ref])
      );
      await waitFor(() => expect(stops).toBe(1));
      if (provider.createCalls === 1) {
        await setDeadline(stub, { create_deadline_at: Date.now() - 1 });
        await runAlarm(stub);
      }
      await waitFor(() => expect(provider.createCalls).toBe(2));
    },
    20_000
  );

  it('fails waiting routes when cleanup is unconfirmed but retains its billing alarm', async () => {
    const sandboxId = `ses-${'c'.repeat(47)}e`;
    let meterStops = 0;
    const meter: ContainerUsageRpcMethods = {
      async recordStart() {
        return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
      },
      async recordHeartbeat() {
        return {
          intervalId: 'interval-1',
          durable: 'pg',
          dedup: false,
          budget: { verdict: 'continue' },
        };
      },
      async recordStop() {
        meterStops++;
        return { intervalId: 'interval-1', durable: 'pg', dedup: false };
      },
    };
    const provider = createFakeProvider({ gateLaunch: true });
    provider.adapter.stop = async ref => {
      provider.stopCalls.push(ref);
      return 'retryable';
    };
    const stub = await startAllocation(provider, {
      sandboxId,
      provider: 'vercel',
      configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
      billing: {
        sandboxId,
        subject: { type: 'user', id: 'owner-1' },
        actor: { type: 'user', id: 'owner-1' },
        sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        metadata: { origin: 'cloud-agent' },
        enforcementRequested: true,
      },
      meter,
      preparingRoute: 'workspace_pending_cleanup',
    });
    await awaitLaunch(provider);
    const ref = provider.refs[0];
    if (ref === undefined) throw new Error('Expected created ref');
    await runInDurableObject(stub, instance =>
      (
        instance as unknown as {
          recordVercelBillingLifetime(evidence: {
            providerRef: string;
            createdAtMs: number;
          }): Promise<void>;
        }
      ).recordVercelBillingLifetime({ providerRef: ref, createdAtMs: Date.now() - 20_000 })
    );
    await releaseGate(stub, () => provider.launchGates.shift()?.(new Error('launch failed')));
    await waitFor(() => expect(provider.stopCalls).toEqual([ref]));
    const generation = await runInDurableObject(stub, async (_instance, state) => {
      const context = await getBillingContext(state.storage);
      if (context === undefined) throw new Error('Missing bound generation');
      await updateBillingContext(state.storage, {
        ...context,
        startEpochMs: Date.now() - TIMERS.providerCreateMs - 1,
      });
      return context.generation;
    });
    const scheduleCleanup = () =>
      runInDurableObject(stub, instance =>
        (
          instance as unknown as {
            billingSchedule: {
              schedule(callback: string, at: number, generation: string): Promise<void>;
            };
          }
        ).billingSchedule.schedule(VERCEL_BILLING_SETTLEMENT_CALLBACK, Date.now() - 1, generation)
      );
    await scheduleCleanup();
    await runAlarm(stub);
    const route = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      return db
        .select()
        .from(routesTable)
        .where(eq(routesTable.session_id, 'workspace_pending_cleanup'));
    });
    expect(route[0]).toMatchObject({ state: 'failed', reason: 'sandbox_lost' });
    expect((await readState(stub)).kind).toBe('stopped');
    expect(
      (await runInDurableObject(stub, (_instance, state) => getBillingContext(state.storage)))
        ?.pendingStop
    ).toBeUndefined();
    expect(meterStops).toBe(0);
    expect(provider.stopCalls).toEqual([ref, ref]);
    const schedule = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<BillingScheduleEntries>(VERCEL_BILLING_SCHEDULE_KEY)
    );
    const continuation = schedule?.[VERCEL_BILLING_SETTLEMENT_CALLBACK];
    expect(continuation?.payload).toBe(generation);
    expect(continuation?.dueAtMs).toBeGreaterThan(Date.now());
    expect(meterStops).toBe(0);
  }, 20_000);

  it.each(['valid', 'wrong-owner', 'invalid-size'] as const)(
    'handles a shadow admission exception with %s billing identity',
    async identity => {
      const sandboxId = `ses-${(identity === 'valid' ? 'b' : identity === 'wrong-owner' ? 'c' : 'd').repeat(47)}e`;
      const meter: ContainerUsageRpcMethods = {
        async recordStart() {
          return { success: true, ack: { intervalId: 'interval-1', durable: 'pg', dedup: false } };
        },
        async recordHeartbeat() {
          return {
            intervalId: 'interval-1',
            durable: 'pg',
            dedup: false,
            budget: { verdict: 'continue' },
          };
        },
        async recordStop() {
          return { intervalId: 'interval-1', durable: 'pg', dedup: false };
        },
      };
      const provider = createFakeProvider();
      const stub = await startAllocation(provider, {
        sandboxId,
        provider: 'vercel',
        configuration: {
          provider: 'vercel',
          resources: { vcpus: identity === 'invalid-size' ? 3 : 2, memory: 4096 },
        },
        billing: {
          sandboxId,
          subject: { type: 'user', id: identity === 'wrong-owner' ? 'other' : 'owner-1' },
          actor: { type: 'user', id: 'owner-1' },
          sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          metadata: { origin: 'cloud-agent' },
          enforcementRequested: false,
        },
        meter,
        preparingRoute: 'workspace_shadow_exception',
        admissionError: 'throw-after-open',
      });
      if (identity === 'valid') {
        await waitFor(() => expect(provider.createCalls).toBe(1));
        const context = await runInDurableObject(stub, (_instance, state) =>
          getBillingContext(state.storage)
        );
        expect(context?.subject.id).toBe('owner-1');
      } else {
        await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
        expect(provider.createCalls).toBe(0);
        const route = await runInDurableObject(stub, async (_instance, state) => {
          const db = drizzle(state.storage, { logger: false });
          return db
            .select()
            .from(routesTable)
            .where(eq(routesTable.session_id, 'workspace_shadow_exception'));
        });
        expect(route[0]).toMatchObject({ state: 'failed', reason: 'billing_unavailable' });
      }
    }
  );
});
