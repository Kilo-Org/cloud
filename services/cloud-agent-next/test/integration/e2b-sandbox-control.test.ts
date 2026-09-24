import {
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2BProviderError } from '../../src/byoc/e2b-errors.js';
import { fetchByocE2BCredential } from '../../src/byoc/e2b-credential-resolver.js';
import { encodeE2BProviderRef } from '../../src/sandbox-control/e2b-runtime.js';
import { SandboxAcquisitionLostError } from '../../src/shared/sandbox-control-protocol.js';
import type { AllocationRecord } from '../../src/sandbox-state/model/allocation.js';
import { POLICY } from '../../src/sandbox-state/schedule.js';
import {
  connectE2BTestWrapper,
  e2bControlFixture,
  E2B_TEST_ACCOUNT_KEY,
  E2B_TEST_BINDING,
  E2B_TEST_KILO_TOKEN,
  E2B_TEST_NATIVE_ID,
} from './e2b-control-fixture.js';

vi.mock('../../src/byoc/e2b-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/byoc/e2b-credential-resolver.js')>()),
  fetchByocE2BCredential: vi.fn(),
  resolveByocE2BApiKey: vi.fn(),
}));
vi.mock('../../src/sandbox-control/e2b-provider.js', () => ({ createE2BControlAdapter: vi.fn() }));
vi.mock('../../src/db/pg.js', () => ({
  getPgDb: () => {
    throw new Error('E2B coordinator tests do not use PostgreSQL');
  },
}));

const sockets: WebSocket[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unmocked external transport is forbidden');
    })
  );
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function targetOf(record: AllocationRecord) {
  return record.state.kind === 'stopped' ? undefined : (record.state.target ?? undefined);
}

function stopIntentOf(record: AllocationRecord) {
  const state = record.state;
  if (state.kind === 'stopping' || state.kind === 'unknown' || state.kind === 'creating')
    return state.stopIntent ?? null;
  return null;
}

function providerRefOf(record: AllocationRecord): string | null {
  const state = record.state;
  return state.kind === 'stopped' ? (state.summary?.providerRef ?? null) : (state.target?.providerRef ?? null);
}

function intentIdOf(record: AllocationRecord): string | undefined {
  return record.state.kind === 'stopped' ? undefined : record.state.createIntent?.intentId;
}

/** Holds the fixture adapter's create after the durable submission is recorded. */
async function holdFixtureCreate(fixture: Awaited<ReturnType<typeof e2bControlFixture>>) {
  const previous = fixture.provider.create.getMockImplementation();
  if (!previous) throw new Error('Missing fixture create implementation');
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    openGate = resolve;
  });
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  fixture.provider.create.mockImplementation(async intent => {
    markStarted();
    await gate;
    return previous(intent);
  });
  return { started, release: () => openGate() };
}

describe('E2B durable allocation coordination', () => {
  it('persists submission and exact ownership before launch without managed compute billing', async () => {
    const fixture = await e2bControlFixture();
    const status = await fixture.control.ensureReady(fixture.input);
    expect(status).toMatchObject({
      physical: 'running',
      connection: 'disconnected',
      attachment: {
        kilo: {
          containmentEnabled: false,
          token: E2B_TEST_KILO_TOKEN,
          organizationId: E2B_TEST_BINDING.organizationId,
        },
      },
    });
    expect(fixture.provider.create).toHaveBeenCalledTimes(1);
    expect(fixture.provider.launch).toHaveBeenCalledTimes(1);
    expect(fixture.provider.ensureBillingAdmission).not.toHaveBeenCalled();
    expect(fixture.provider.ensureLeaseAtLeast).not.toHaveBeenCalled();
    const record = await fixture.control.getAllocationRecord();
    if (record.state.kind !== 'allocated') throw new Error('Expected an allocated record');
    const e2b = record.state.target.e2b;
    expect(e2b?.submissionState).toBe('submitted');
    expect(record.state.target.resolvedContainment).toMatchObject({
      github: false,
      kilocode: false,
      worktreeScoped: true,
    });
    expect(e2b?.createDeadlineAt).toBe(fixture.input.acquisition.deadlineAt);
    expect(e2b?.reconciliationDeadlineAt).toBe(e2b!.submittedAt + 60_000);
    expect(e2b?.reconciliationAlarmAt).toBe(e2b!.reconciliationDeadlineAt - 20_000);
    expect(JSON.stringify({ record, status })).not.toContain(E2B_TEST_ACCOUNT_KEY);
    await runInDurableObject(fixture.control, async (_instance, state) => {
      expect(await state.storage.get('control_alarm_anchors')).toMatchObject({
        hardStopAt: e2b?.hardStopAt,
      });
      expect(JSON.stringify(await state.storage.get('worktree_credential_grants'))).not.toContain(
        E2B_TEST_ACCOUNT_KEY
      );
    });
  });

  it('joins concurrent readiness calls without another application create submission', async () => {
    const fixture = await e2bControlFixture();
    await Promise.all([
      fixture.control.ensureReady(fixture.input),
      fixture.control.ensureReady(fixture.input),
    ]);
    expect(fixture.provider.create).toHaveBeenCalledTimes(1);
    expect(fixture.provider.launch).toHaveBeenCalledTimes(1);
  });

  it('never invokes create when durable submission recording fails', async () => {
    const fixture = await e2bControlFixture();
    await runInDurableObject(fixture.control, (_instance, state) => {
      const original = state.storage.put.bind(state.storage);
      state.storage.put = async (key: string | Record<string, unknown>, value?: unknown) => {
        const saved = value as AllocationRecord | undefined;
        if (
          key === 'sandbox_allocation_state' &&
          saved?.state.kind === 'creating' &&
          saved.state.target.e2b?.submissionState === 'submitted'
        ) {
          throw new Error('Injected submission storage failure');
        }
        return typeof key === 'string' ? original(key, value) : original(key);
      };
    });
    await expect(fixture.control.ensureReady(fixture.input)).resolves.toMatchObject({
      physical: 'failed',
    });
    expect(fixture.provider.create).not.toHaveBeenCalled();
    expect(fixture.provider.launch).not.toHaveBeenCalled();
    fixture.provider.observe.mockResolvedValue({ status: 'terminal' });
    await fixture.control.recordStopAttempt();
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
    expect(providerRefOf(await fixture.control.getAllocationRecord())).toBeNull();
  });

  it('records the policy mismatch when the create reference names a different intent', async () => {
    const fixture = await e2bControlFixture();
    fixture.provider.create.mockResolvedValue({
      providerRef: encodeE2BProviderRef({
        physicalId: 'physicalforeign',
        intentId: crypto.randomUUID(),
      }),
    });
    // The reference validation fails inside the create effect's fenced error
    // boundary, so the provider-specific failure is recorded rather than only
    // projected as a generic unknown create.
    await expect(fixture.control.ensureReady(fixture.input)).resolves.toMatchObject({
      physical: 'failed',
      failureReason: 'byoc_e2b_policy_mismatch',
    });
    const record = await fixture.control.getAllocationRecord();
    expect(record.state.kind).toBe('unknown');
    expect(fixture.provider.launch).not.toHaveBeenCalled();
    await runInDurableObject(fixture.control, async (_instance, state) => {
      expect(await state.storage.get('failure_reason')).toBe('byoc_e2b_policy_mismatch');
    });
  });

  it('retains an uncertain create through eviction and repeated demand without another POST', async () => {
    const fixture = await e2bControlFixture();
    fixture.provider.create.mockResolvedValue({ unresolved: true });
    fixture.provider.observe.mockResolvedValue({ status: 'unknown' });
    fixture.provider.stop.mockResolvedValue('retryable');
    await expect(fixture.control.ensureReady(fixture.input)).resolves.toMatchObject({
      physical: 'failed',
      // The provider-specific unknown-create code is projected from the failure
      // key, not the generic port reason.
      failureReason: 'byoc_e2b_create_unknown',
    });
    const submittedRecord = await fixture.control.getAllocationRecord();
    if (submittedRecord.state.kind !== 'unknown') throw new Error('Expected an unknown record');
    const submittedE2b = submittedRecord.state.target?.e2b;
    const submittedIntent = submittedRecord.state.createIntent;
    await abortAllDurableObjects();
    fixture.control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
    await fixture.control.ensureReady(fixture.input);
    // The delegated reconciliation wake is the allocation deadline, driven by the
    // durable alarm rather than a direct handler call.
    await runInDurableObject(fixture.control, async instance => {
      vi.spyOn(Date, 'now').mockReturnValue(submittedE2b!.reconciliationDeadlineAt);
      await instance['alarm']();
    });
    await fixture.control.ensureReady({
      ...fixture.input,
      acquisition: { id: crypto.randomUUID(), deadlineAt: Date.now() + 120_000 },
    });
    expect(fixture.provider.create).toHaveBeenCalledTimes(1);
    expect(fixture.provider.launch).not.toHaveBeenCalled();
    const settled = await fixture.control.getAllocationRecord();
    expect(settled.state.kind).toBe('stopping');
    expect(providerRefOf(settled)).toBeNull();
    expect(intentIdOf(settled)).toBe(submittedIntent.intentId);
    expect(targetOf(settled)?.e2b).toMatchObject({ submissionState: 'submitted' });
    expect(stopIntentOf(settled)?.reason).toBe('create_unresolved');
  });

  it('retains unknown ownership when a scan does not publish a complete unique result', async () => {
    const fixture = await e2bControlFixture();
    fixture.provider.create.mockResolvedValue({ unresolved: true });
    fixture.provider.observe.mockResolvedValue({ status: 'unknown' });
    await fixture.control.ensureReady(fixture.input);
    await fixture.control.recordStopAttempt();
    const record = await fixture.control.getAllocationRecord();
    expect(record.state.kind).toBe('unknown');
    expect(providerRefOf(record)).toBeNull();
    expect(fixture.provider.launch).not.toHaveBeenCalled();
    expect(fixture.provider.create).toHaveBeenCalledTimes(1);
  });

  it('stores the list expiry as the inconclusive-scan wake and exhausts when that alarm fires', async () => {
    const fixture = await e2bControlFixture();
    fixture.provider.create.mockResolvedValue({ unresolved: true });
    fixture.provider.observe.mockResolvedValue({ status: 'unknown' });
    await fixture.control.ensureReady(fixture.input);
    const unknown = await fixture.control.getAllocationRecord();
    if (unknown.state.kind !== 'unknown') throw new Error('Expected an unknown record');
    const e2b = unknown.state.target?.e2b;
    if (e2b === undefined) throw new Error('Missing submitted block');
    // First wake is the recovery alarm. The inconclusive scan re-arms the wake.
    await runInDurableObject(fixture.control, async (instance, state) => {
      vi.spyOn(Date, 'now').mockReturnValue(e2b.reconciliationAlarmAt);
      await instance['alarm']();
      // The stored wake is the list expiry, never now + 90s.
      expect(await state.storage.getAlarm()).toBe(e2b.reconciliationDeadlineAt);
    });
    const afterScan = await fixture.control.getAllocationRecord();
    expect(afterScan.state.kind).toBe('unknown');
    const observeCalls = fixture.provider.observe.mock.calls.length;
    // Firing the stored exhaustion alarm settles the cleanup without another scan.
    await runInDurableObject(fixture.control, async (instance, state) => {
      vi.spyOn(Date, 'now').mockReturnValue(e2b.reconciliationDeadlineAt);
      await instance['alarm']();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const exhausted = await fixture.control.getAllocationRecord();
    expect(exhausted.state.kind).toBe('stopping');
    if (exhausted.state.kind !== 'stopping') throw new Error('Expected a stopping record');
    expect(exhausted.state.step).toBe('check_required');
    expect(fixture.provider.observe.mock.calls.length).toBe(observeCalls);
  });

  it('only lets fresh authorized demand replace a confirmed dead allocation in the same chat', async () => {
    const fixture = await e2bControlFixture();
    await fixture.control.ensureReady(fixture.input);
    const first = await fixture.control.getAllocationRecord();
    await fixture.control.beginStop('test runtime loss');
    await fixture.control.recordStopAttempt();
    await runInDurableObject(fixture.control, async instance => {
      await expect(instance.ensureReady(fixture.input)).rejects.toThrow(SandboxAcquisitionLostError);
    });
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
    expect(fixture.provider.create).toHaveBeenCalledTimes(1);
    await fixture.control.ensureReady({
      ...fixture.input,
      acquisition: { id: crypto.randomUUID(), deadlineAt: Date.now() + 120_000 },
    });
    const replacement = await fixture.control.getAllocationRecord();
    expect(providerRefOf(replacement)).not.toBe(providerRefOf(first));
    expect(intentIdOf(replacement)).not.toBe(intentIdOf(first));
    expect(targetOf(replacement)?.e2b?.binding).toEqual(E2B_TEST_BINDING);
    expect(fixture.provider.create).toHaveBeenCalledTimes(2);
    await expect(fixture.session.getCredentialMetadata()).resolves.toMatchObject({
      identity: { sessionId: fixture.input.sessionId },
      auth: { kiloSessionId: E2B_TEST_NATIVE_ID },
    });
  });
});

describe('E2B hard stop and in-flight submission', () => {
  it('stops an allocated E2B allocation from the due hard-stop alarm and records the lifetime reason', async () => {
    const fixture = await e2bControlFixture();
    await fixture.control.ensureReady(fixture.input);
    const record = await fixture.control.getAllocationRecord();
    const hardStopAt = targetOf(record)?.e2b?.hardStopAt;
    if (hardStopAt === undefined) throw new Error('Missing hard lifetime cap');
    vi.spyOn(Date, 'now').mockReturnValue(hardStopAt);
    await runDurableObjectAlarm(fixture.control);
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
    expect(fixture.provider.stop).toHaveBeenCalled();
    await expect(fixture.control.getStatus()).resolves.toMatchObject({
      failureReason: 'byoc_e2b_lifetime_exceeded',
    });
  });

  it('does not stop or mark a replacement allocation when a hard stop is fenced to a superseded record', async () => {
    const fixture = await e2bControlFixture();
    await fixture.control.ensureReady(fixture.input);
    const stale = await fixture.control.getAllocationRecord();
    if (stale.state.kind !== 'allocated') throw new Error('Expected an allocated record');
    const replacement: AllocationRecord = {
      ...stale,
      state: {
        ...stale.state,
        createIntent: { ...stale.state.createIntent, intentId: crypto.randomUUID() },
      },
    };
    await runInDurableObject(fixture.control, async (instance, state) => {
      await state.storage.put('sandbox_allocation_state', replacement);
      // The transaction-local identity check must reject the superseded record:
      // a stale lifetime failure never stops or marks the successor.
      await instance['dispatchHardStop'](stale, { type: 'DEADLINE' }, 'byoc_e2b_lifetime_exceeded');
      expect(await instance.getAllocationRecord()).toEqual(replacement);
      expect(await state.storage.get('failure_reason')).toBeUndefined();
    });
    expect(fixture.provider.stop).not.toHaveBeenCalled();
  });

  it('destroys the exact reference when the hard-stop alarm fires before a held create result', async () => {
    const fixture = await e2bControlFixture();
    const held = await holdFixtureCreate(fixture);
    await runInDurableObject(fixture.control, async instance => {
      const pending = instance.ensureReady(fixture.input).catch(error => error);
      await held.started;
      const creating = await instance.getAllocationRecord();
      if (creating.state.kind !== 'creating') throw new Error('Expected a creating record');
      const e2b = creating.state.target.e2b;
      if (e2b === undefined) throw new Error('Missing submitted block');
      vi.spyOn(Date, 'now').mockReturnValue(e2b.hardStopAt);
      await instance['alarm']();
      const cancelled = await instance.getAllocationRecord();
      expect(cancelled.state.kind).toBe('creating');
      expect(stopIntentOf(cancelled)?.reason).toBe('byoc_e2b_lifetime_exceeded');
      held.release();
      await pending;
    });
    const settled = await fixture.control.getAllocationRecord();
    expect(settled.state.kind).toBe('stopped');
    const ref = providerRefOf(settled);
    if (ref === null) throw new Error('Missing destroyed reference');
    expect(fixture.provider.stop).toHaveBeenCalledWith(ref, expect.anything());
    expect(fixture.provider.launch).not.toHaveBeenCalled();
    await expect(fixture.control.getStatus()).resolves.toMatchObject({
      failureReason: 'byoc_e2b_lifetime_exceeded',
    });
  });

  it('records the lifetime reason when a create result arrives at the cap with no preceding alarm', async () => {
    const fixture = await e2bControlFixture();
    const held = await holdFixtureCreate(fixture);
    await runInDurableObject(fixture.control, async instance => {
      const pending = instance.ensureReady(fixture.input).catch(error => error);
      await held.started;
      const creating = await instance.getAllocationRecord();
      if (creating.state.kind !== 'creating') throw new Error('Expected a creating record');
      const e2b = creating.state.target.e2b;
      if (e2b === undefined) throw new Error('Missing submitted block');
      // No alarm fires first: the accepted CREATE_CONFIRMED at the cap must
      // persist the lifetime reason itself, not derive it from status later.
      vi.spyOn(Date, 'now').mockReturnValue(e2b.hardStopAt);
      held.release();
      await pending;
    });
    const settled = await fixture.control.getAllocationRecord();
    expect(settled.state.kind).toBe('stopped');
    const ref = providerRefOf(settled);
    if (ref === null) throw new Error('Missing destroyed reference');
    expect(fixture.provider.stop).toHaveBeenCalledWith(ref, expect.anything());
    expect(fixture.provider.launch).not.toHaveBeenCalled();
    await runInDurableObject(fixture.control, async (_instance, state) => {
      // The accepted CREATE_CONFIRMED transition is the writer: the projection is
      // durable, not derived from status at read time.
      expect(await state.storage.get('failure_reason')).toBe('byoc_e2b_lifetime_exceeded');
    });
    await expect(fixture.control.getStatus()).resolves.toMatchObject({
      failureReason: 'byoc_e2b_lifetime_exceeded',
    });
  });

  it('does not persist the lifetime reason when the confirmation transition is rejected', async () => {
    const fixture = await e2bControlFixture();
    const held = await holdFixtureCreate(fixture);
    await runInDurableObject(fixture.control, async (instance, state) => {
      const pending = instance.ensureReady(fixture.input).catch(error => error);
      await held.started;
      const creating = await instance.getAllocationRecord();
      if (creating.state.kind !== 'creating') throw new Error('Expected a creating record');
      const e2b = creating.state.target.e2b;
      if (e2b === undefined) throw new Error('Missing submitted block');
      vi.spyOn(Date, 'now').mockReturnValue(e2b.hardStopAt);
      // The confirmation's transition persistence fails. The lifetime reason is
      // written in that same transaction, so it must not survive the rollback.
      const original = state.storage.put.bind(state.storage);
      state.storage.put = async (key: string | Record<string, unknown>, value?: unknown) => {
        const saved = value as AllocationRecord | undefined;
        if (key === 'sandbox_allocation_state' && saved?.state.kind === 'stopping') {
          throw new Error('Injected confirmation storage failure');
        }
        return typeof key === 'string' ? original(key, value) : original(key);
      };
      held.release();
      await pending;
      expect(await state.storage.get('failure_reason')).toBeUndefined();
    });
  });

  it('drives the stop ladder when the hard-stop alarm fires on a stopping allocation', async () => {
    const fixture = await e2bControlFixture();
    await fixture.control.ensureReady(fixture.input);
    const allocated = await fixture.control.getAllocationRecord();
    if (allocated.state.kind !== 'allocated') throw new Error('Expected an allocated record');
    const hardStopAt = allocated.state.target.e2b?.hardStopAt;
    if (hardStopAt === undefined) throw new Error('Missing hard lifetime cap');
    const stopping: AllocationRecord = {
      ...allocated,
      state: {
        kind: 'stopping',
        step: 'check_required',
        target: allocated.state.target,
        createIntent: allocated.state.createIntent,
        attempts: POLICY.stopMaxAttempts,
        stopIntent: { reason: 'byoc_e2b_lifetime_exceeded', createdAt: Date.now() },
      },
    };
    await runInDurableObject(fixture.control, (_instance, state) =>
      state.storage.put('sandbox_allocation_state', stopping)
    );
    await runInDurableObject(fixture.control, async (instance, state) => {
      vi.spyOn(Date, 'now').mockReturnValue(hardStopAt);
      await instance['alarm']();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    // The hard stop must not return silently for a stopping allocation: the
    // ladder is driven through CHECK to a terminal stop.
    const settled = await fixture.control.getAllocationRecord();
    expect(settled.state.kind).toBe('stopped');
  });

  it('keeps a submitted in-flight create alarm strictly in the future instead of firing the due recovery wake', async () => {
    const fixture = await e2bControlFixture();
    const held = await holdFixtureCreate(fixture);
    await runInDurableObject(fixture.control, async (instance, state) => {
      const pending = instance.ensureReady(fixture.input).catch(error => error);
      await held.started;
      const creating = await instance.getAllocationRecord();
      if (creating.state.kind !== 'creating') throw new Error('Expected a creating record');
      const e2b = creating.state.target.e2b;
      if (e2b === undefined) throw new Error('Missing submitted block');
      vi.spyOn(Date, 'now').mockReturnValue(e2b.reconciliationAlarmAt!);
      await instance['alarm']();
      const alarmAt = await state.storage.getAlarm();
      expect(alarmAt).not.toBeNull();
      expect(alarmAt!).toBeGreaterThan(Date.now());
      expect(alarmAt).not.toBe(e2b.reconciliationAlarmAt);
      expect(fixture.provider.observe).not.toHaveBeenCalled();
      // At the expiry the wake is still strictly future and no scan runs.
      vi.spyOn(Date, 'now').mockReturnValue(e2b.reconciliationDeadlineAt);
      await instance['alarm']();
      const expiryAlarmAt = await state.storage.getAlarm();
      expect(expiryAlarmAt).not.toBeNull();
      expect(expiryAlarmAt!).toBeGreaterThan(Date.now());
      expect(fixture.provider.observe).not.toHaveBeenCalled();
      held.release();
      await pending;
    });
  });
});

describe('E2B runtime authority', () => {
  it('renews only a ready wrapper and fences prompts and terminals at the allocation cap', async () => {
    const fixture = await e2bControlFixture();
    const status = await fixture.control.ensureReady(fixture.input);
    if (!status.attachment?.directory) throw new Error('Missing attachment');
    await fixture.control.attachSession({
      sessionId: fixture.input.sessionId,
      kiloSessionId: E2B_TEST_NATIVE_ID,
      directory: status.attachment.directory,
      ownerId: fixture.input.ownerId,
    });
    const { socket, wrapperInstanceId } = await connectE2BTestWrapper(fixture);
    sockets.push(socket);
    await runInDurableObject(fixture.control, async instance => {
      const identity = instance['readyWrapperRuntime']();
      if (!identity) throw new Error('Missing ready wrapper');
      await instance['renewProviderLease'](identity);
    });
    expect(fixture.provider.ensureLeaseAtLeast).toHaveBeenCalled();
    const record = await fixture.control.getAllocationRecord();
    const hardStopAt = targetOf(record)?.e2b?.hardStopAt;
    if (!hardStopAt) throw new Error('Missing hard lifetime cap');
    vi.spyOn(Date, 'now').mockReturnValue(hardStopAt);
    await expect(
      fixture.control.validateTerminalAccess({
        ownerId: fixture.input.ownerId,
        sessionId: fixture.input.sessionId,
        organizationId: E2B_TEST_BINDING.organizationId,
        wrapperInstanceId,
      })
    ).resolves.toMatchObject({ allowed: false });
    const directory = status.attachment.directory;
    await runInDurableObject(fixture.control, async instance => {
      await expect(
        instance.request({
          operation: 'session.prompt',
          expectedWrapperInstanceId: wrapperInstanceId,
          session: {
            sessionId: fixture.input.sessionId,
            kiloSessionId: E2B_TEST_NATIVE_ID,
            directory,
          },
          payload: { prompt: 'expired runtime must not receive this' },
        })
      ).rejects.toThrow('not ready');
    });
    await runDurableObjectAlarm(fixture.control);
    expect(fixture.provider.stop).toHaveBeenCalled();
  });

  it('blocks warm credential preparation and terminal control after exact connection removal', async () => {
    const fixture = await e2bControlFixture();
    const status = await fixture.control.ensureReady(fixture.input);
    if (!status.attachment?.directory) throw new Error('Missing attachment');
    await fixture.control.attachSession({
      sessionId: fixture.input.sessionId,
      kiloSessionId: E2B_TEST_NATIVE_ID,
      directory: status.attachment.directory,
      ownerId: fixture.input.ownerId,
    });
    const { socket, wrapperInstanceId } = await connectE2BTestWrapper(fixture);
    sockets.push(socket);
    vi.mocked(fetchByocE2BCredential).mockRejectedValue(
      new E2BProviderError('byoc_e2b_credential_missing')
    );
    await runInDurableObject(fixture.control, async instance => {
      await expect(instance.prepareSessionCredentials(fixture.input)).rejects.toThrow(
        'no longer available'
      );
    });
    // Terminal access is fail-closed on the same missing credential rather than
    // serving a stale grant.
    await runInDurableObject(fixture.control, async instance => {
      await expect(
        instance.validateTerminalAccess({
          ownerId: fixture.input.ownerId,
          sessionId: fixture.input.sessionId,
          organizationId: E2B_TEST_BINDING.organizationId,
          wrapperInstanceId,
        })
      ).rejects.toThrow('no longer available');
    });
    expect(providerRefOf(await fixture.control.getAllocationRecord())).not.toBeNull();
  });

  it('rejects an attach policy that disagrees with the saved direct grant', async () => {
    const fixture = await e2bControlFixture();
    const status = await fixture.control.ensureReady(fixture.input);
    if (!status.attachment?.directory || !status.attachment.kilo)
      throw new Error('Missing attachment');
    await fixture.control.attachSession({
      sessionId: fixture.input.sessionId,
      kiloSessionId: E2B_TEST_NATIVE_ID,
      directory: status.attachment.directory,
      ownerId: fixture.input.ownerId,
    });
    const { socket, wrapperInstanceId } = await connectE2BTestWrapper(fixture);
    sockets.push(socket);
    const { directory, kilo } = status.attachment;
    await runInDurableObject(fixture.control, async instance => {
      await expect(
        instance.request({
          operation: 'session.attach',
          expectedWrapperInstanceId: wrapperInstanceId,
          session: {
            sessionId: fixture.input.sessionId,
            kiloSessionId: E2B_TEST_NATIVE_ID,
            directory,
          },
          payload: { ...status.attachment, kilo: { ...kilo, containmentEnabled: true } },
        })
      ).rejects.toThrow('credential policy is invalid');
    });
  });
});
