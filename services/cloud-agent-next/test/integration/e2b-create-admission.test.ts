import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { E2BProviderError } from '../../src/byoc/e2b-errors.js';
import { resolveByocE2BApiKey } from '../../src/byoc/e2b-credential-resolver.js';
import { createE2BControlAdapter } from '../../src/sandbox-control/e2b-provider.js';
import { launchE2BWrapper } from '../../src/sandbox-control/e2b-envd.js';
import { ACQUISITION_RECEIPTS_KEY } from '../../src/sandbox-control/allocation-controller.js';
import { SandboxAcquisitionLostError } from '../../src/shared/sandbox-control-protocol.js';
import type { AllocationRecord } from '../../src/sandbox-state/model/allocation.js';
import { e2bControlFixture, E2B_TEST_ACCOUNT_KEY, E2B_TEST_ENV } from './e2b-control-fixture.js';

vi.mock('../../src/byoc/e2b-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/byoc/e2b-credential-resolver.js')>()),
  fetchByocE2BCredential: vi.fn(),
  resolveByocE2BApiKey: vi.fn(),
}));
vi.mock('../../src/sandbox-control/e2b-provider.js', () => ({ createE2BControlAdapter: vi.fn() }));
vi.mock('../../src/sandbox-control/e2b-envd.js', () => ({
  launchE2BWrapper: vi.fn(async () => undefined),
}));
vi.mock('../../src/db/pg.js', () => ({
  getPgDb: () => {
    throw new Error('E2B creation tests do not use PostgreSQL');
  },
}));

beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
  vi.unstubAllGlobals();
});

type Receipt = { id: string; allocation: { kind: string; id: string } };

async function fixtureWithRealAdapter() {
  const fixture = await e2bControlFixture();
  const actual = await vi.importActual<typeof import('../../src/sandbox-control/e2b-provider.js')>(
    '../../src/sandbox-control/e2b-provider.js'
  );
  vi.mocked(createE2BControlAdapter).mockImplementation(actual.createE2BControlAdapter);
  const posts: Request[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const created = new Map<string, Record<string, string>>();
  const deleted: string[] = [];
  let nextId = 1;
  let holdPosts = false;
  let releaseCreate: () => void = () => undefined;
  let createGate = Promise.resolve();
  let markCreateStarted: () => void = () => undefined;
  let createStarted = Promise.resolve();

  function enableHold(): void {
    holdPosts = true;
    createStarted = new Promise<void>(resolve => {
      markCreateStarted = resolve;
    });
    createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input instanceof URL ? input.toString() : input, init);
      const url = new URL(request.url);
      if (url.origin !== 'https://api.e2b.app') throw new Error('Uncontrolled provider transport');
      requests.push({ method: request.method, path: url.pathname });
      if (request.method === 'POST' && url.pathname === '/sandboxes') {
        posts.push(request.clone());
        const body = z
          .object({ metadata: z.record(z.string(), z.string()) })
          .parse(await request.json());
        const id = `admission${nextId++}`;
        created.set(id, body.metadata);
        if (holdPosts) {
          markCreateStarted();
          await createGate;
        }
        return Response.json(
          { sandboxID: id, templateID: E2B_TEST_ENV.E2B_SANDBOX_TEMPLATE_ID },
          { status: 201 }
        );
      }
      const physical = /^\/sandboxes\/([^/]+)$/.exec(url.pathname)?.[1];
      if (request.method === 'GET' && physical !== undefined && created.has(physical)) {
        return Response.json({
          sandboxID: physical,
          templateID: E2B_TEST_ENV.E2B_SANDBOX_TEMPLATE_ID,
          clientID: 'test-client',
          metadata: created.get(physical),
          state: 'running',
          startedAt: new Date().toISOString(),
          endAt: new Date(Date.now() + 300_000).toISOString(),
          cpuCount: 2,
          memoryMB: 4096,
          diskSizeMB: 10240,
          envdVersion: '0.5.7',
          envdAccessToken: 'test-envd-token',
          lifecycle: { onTimeout: 'kill', autoResume: false },
          network: { allowPublicTraffic: false },
        });
      }
      if (request.method === 'DELETE' && physical !== undefined && created.has(physical)) {
        deleted.push(physical);
        created.delete(physical);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected controlled provider request ${request.method} ${url.pathname}`);
    })
  );
  return {
    ...fixture,
    posts,
    requests,
    deleted,
    enableHold,
    createStarted: () => createStarted,
    releaseCreate: () => releaseCreate(),
    lists: () => requests.filter(entry => entry.path === '/v2/sandboxes'),
  };
}

function delayCreateKey() {
  let resolveKey: (key: string) => void = () => {
    throw new Error('Key lookup has not started');
  };
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  vi.mocked(resolveByocE2BApiKey).mockImplementation(() => {
    markStarted();
    return new Promise<string>(resolve => {
      resolveKey = resolve;
    });
  });
  return { started, complete: () => resolveKey(E2B_TEST_ACCOUNT_KEY) };
}

/** Two independent key lookups, one per create generation. */
function delayCreateKeys(count: number) {
  const resolvers: Array<(key: string) => void> = [];
  const started: Array<() => void> = [];
  const startedPromises = Array.from({ length: count }, () => new Promise<void>(resolve => started.push(resolve)));
  let call = 0;
  vi.mocked(resolveByocE2BApiKey).mockImplementation(() => {
    const index = call++;
    // Only the first `count` lookups are gated (one per create generation); a
    // later launch credential lookup resolves immediately.
    if (index >= count) return Promise.resolve(E2B_TEST_ACCOUNT_KEY);
    started[index]?.();
    return new Promise<string>(resolve => {
      resolvers[index] = resolve;
    });
  });
  return {
    started: (index: number) => startedPromises[index],
    complete: (index: number) => resolvers[index](E2B_TEST_ACCOUNT_KEY),
  };
}

function canonicalState(record: AllocationRecord): string {
  return record.state.kind;
}

describe('E2B real-adapter create admission', () => {
  it('recovers a pre-POST credential lookup failure without permanently blocking the chat', async () => {
    const fixture = await fixtureWithRealAdapter();
    vi.mocked(resolveByocE2BApiKey).mockRejectedValueOnce(
      new E2BProviderError('byoc_e2b_unavailable')
    );
    await expect(fixture.control.ensureReady(fixture.input)).resolves.toMatchObject({
      physical: 'failed',
    });
    expect(fixture.posts).toHaveLength(0);
    const failed = await fixture.control.getAllocationRecord();
    expect(failed.state.kind).toBe('unknown');
    if (failed.state.kind !== 'unknown') throw new Error('Expected an unknown allocation');
    expect(failed.state.target?.e2b?.submissionState).toBe('pending');
    expect(failed.state.target?.providerRef).toBeNull();
    const failedIntentId = failed.state.createIntent.intentId;
    await fixture.control.recordStopAttempt();
    expect(fixture.lists()).toHaveLength(0);
    expect(fixture.deleted).toHaveLength(0);
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
    const retryInput = {
      ...fixture.input,
      acquisition: { id: crypto.randomUUID(), deadlineAt: Date.now() + 60_000 },
    };
    await expect(fixture.control.ensureReady(retryInput)).resolves.toMatchObject({
      physical: 'running',
    });
    expect(fixture.posts).toHaveLength(1);
    const replacement = await fixture.control.getAllocationRecord();
    expect(replacement.state.kind).toBe('allocated');
    if (replacement.state.kind !== 'allocated') throw new Error('Expected an allocated record');
    expect(replacement.state.createIntent.intentId).not.toBe(failedIntentId);
    expect(replacement.state.target.e2b).toMatchObject({
      submissionState: 'submitted',
      createDeadlineAt: retryInput.acquisition.deadlineAt,
    });
    expect(JSON.stringify(replacement)).not.toContain(E2B_TEST_ACCOUNT_KEY);
  });

  it('releases a pending create without credentials even while the resolver keeps failing', async () => {
    const fixture = await fixtureWithRealAdapter();
    // A persistent failure, not a single transient one: the pending/null-ref
    // release never resolves a credential, so it must still reach stopped.
    vi.mocked(resolveByocE2BApiKey).mockRejectedValue(
      new E2BProviderError('byoc_e2b_unavailable')
    );
    await expect(fixture.control.ensureReady(fixture.input)).resolves.toMatchObject({
      physical: 'failed',
    });
    expect(fixture.posts).toHaveLength(0);
    const failed = await fixture.control.getAllocationRecord();
    if (failed.state.kind !== 'unknown') throw new Error('Expected an unknown allocation');
    expect(failed.state.target?.e2b?.submissionState).toBe('pending');
    expect(failed.state.target?.providerRef).toBeNull();
    const releasedAt = Date.now();
    await fixture.control.recordStopAttempt();
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
    // Released immediately, without waiting out the create deadline or scanning.
    expect(Date.now() - releasedAt).toBeLessThan(120_000);
    expect(fixture.lists()).toHaveLength(0);
  });

  it('does not issue a POST after key resolution exceeds the acquisition deadline', async () => {
    const fixture = await fixtureWithRealAdapter();
    const key = delayCreateKey();
    const now = Date.now();
    const input = {
      ...fixture.input,
      acquisition: { id: crypto.randomUUID(), deadlineAt: now + 1000 },
    };
    await runInDurableObject(fixture.control, async instance => {
      const pending = expect(instance.ensureReady(input)).rejects.toThrow('acquisition expired');
      await key.started;
      vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
      key.complete();
      await pending;
    });
    expect(fixture.posts).toHaveLength(0);
    const failed = await fixture.control.getAllocationRecord();
    expect(failed.state.kind === 'unknown' && failed.state.target?.e2b?.submissionState).toBe(
      'pending'
    );
    await fixture.control.recordStopAttempt();
    await runInDurableObject(fixture.control, async instance => {
      await expect(instance.ensureReady(input)).rejects.toThrow();
    });
    expect(fixture.posts).toHaveLength(0);
  });

  it('does not create after stop wins while the operation-local key is resolving', async () => {
    const fixture = await fixtureWithRealAdapter();
    const key = delayCreateKey();
    await runInDurableObject(fixture.control, async instance => {
      const pending = expect(instance.ensureReady(fixture.input)).rejects.toThrow(SandboxAcquisitionLostError);
      await key.started;
      await instance.beginStop('cancelled before provider submission');
      await instance.recordStopAttempt();
      key.complete();
      await pending;
    });
    expect(fixture.posts).toHaveLength(0);
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
  });

  it('stores the submission before the POST and destroys the exact reference when cancelled in flight', async () => {
    const fixture = await fixtureWithRealAdapter();
    fixture.enableHold();
    await runInDurableObject(fixture.control, async instance => {
      const pending = instance.ensureReady(fixture.input).catch(error => error);
      await fixture.createStarted();
      const held = await instance.getAllocationRecord();
      expect(canonicalState(held)).toBe('creating');
      if (held.state.kind !== 'creating') throw new Error('Expected a creating allocation');
      // The exact physical id is not known yet, but the at-most-once submission
      // bit and its deadline are already durable before the POST.
      expect(held.state.target.e2b?.submissionState).toBe('submitted');
      expect(held.state.target.providerRef).toBeNull();
      await instance.beginStop('cancelled before provider result');
      const cancelled = await instance.getAllocationRecord();
      expect(cancelled.state.kind).toBe('creating');
      if (cancelled.state.kind !== 'creating') throw new Error('Expected a creating allocation');
      expect(cancelled.state.stopIntent?.reason).toBe('cancelled before provider result');
      fixture.releaseCreate();
      // This ordering is not required to surface `SandboxAcquisitionLostError`;
      // the proof is no launch and exact-id cleanup.
      await pending;
    });
    expect(fixture.posts).toHaveLength(1);
    expect(launchE2BWrapper).not.toHaveBeenCalled();
    expect(fixture.deleted).toEqual(['admission1']);
    expect((await fixture.control.getAllocationRecord()).state.kind).toBe('stopped');
  });

  it('lets a fresh acquisition wait while A is held and creates once after A cleanup', async () => {
    const fixture = await fixtureWithRealAdapter();
    fixture.enableHold();
    const acquisitionB = { id: crypto.randomUUID(), deadlineAt: Date.now() + 120_000 };
    const inputB = { ...fixture.input, acquisition: acquisitionB };
    let intentA = '';
    await runInDurableObject(fixture.control, async (instance, state) => {
      const pendingA = instance.ensureReady(fixture.input);
      await fixture.createStarted();
      const held = await instance.getAllocationRecord();
      if (held.state.kind === 'creating') intentA = held.state.createIntent.intentId;
      await instance.beginStop('cancel A while held');
      const pendingB = instance.ensureReady(inputB);
      await expect(pendingB).resolves.toBeDefined();
      const receiptsWhileHeld = (await state.storage.get<Receipt[]>(ACQUISITION_RECEIPTS_KEY)) ?? [];
      expect(receiptsWhileHeld.some(receipt => receipt.id === acquisitionB.id)).toBe(false);
      expect(fixture.posts).toHaveLength(1);
      fixture.releaseCreate();
      await expect(pendingA).rejects.toThrow();
      const receipts = (await state.storage.get<Receipt[]>(ACQUISITION_RECEIPTS_KEY)) ?? [];
      expect(receipts.find(receipt => receipt.id === acquisitionB.id)).toBeUndefined();
    });
    expect((await fixture.control.getAllocationRecord()).state.kind).toBe('stopped');
    expect(fixture.deleted).toEqual(['admission1']);
    // The same B acquisition now creates exactly once against a new intent.
    await expect(fixture.control.ensureReady(inputB)).resolves.toMatchObject({
      physical: 'running',
    });
    expect(fixture.posts).toHaveLength(2);
    const created = await fixture.control.getAllocationRecord();
    expect(created.state.kind).toBe('allocated');
    if (created.state.kind !== 'allocated') throw new Error('Expected an allocated record');
    expect(created.state.createIntent.intentId).not.toBe(intentA);
    await runInDurableObject(fixture.control, async (_instance, state) => {
      const receipts = (await state.storage.get<Receipt[]>(ACQUISITION_RECEIPTS_KEY)) ?? [];
      expect(receipts.find(receipt => receipt.id === acquisitionB.id)?.allocation.id).not.toBe(
        intentA
      );
    });
  });

  it("lets generation A's finally run without admitting generation B's expired POST", async () => {
    const fixture = await fixtureWithRealAdapter();
    const keys = delayCreateKeys(2);
    const acquisitionA = { id: crypto.randomUUID(), deadlineAt: Date.now() + 60_000 };
    const inputA = { ...fixture.input, acquisition: acquisitionA };
    let pendingA: Promise<unknown> = Promise.resolve();
    await runInDurableObject(fixture.control, async instance => {
      pendingA = instance.ensureReady(inputA);
      await keys.started(0);
      await instance.beginStop('cancel A');
      await expect(instance.getAllocationRecord()).resolves.toMatchObject({
        state: { kind: 'stopped' },
      });
      const pendingB = instance.ensureReady(fixture.input);
      await keys.started(1);
      keys.complete(0);
      await expect(pendingA).rejects.toThrow();
      vi.spyOn(Date, 'now').mockReturnValue(fixture.input.acquisition.deadlineAt + 1);
      keys.complete(1);
      await expect(pendingB).rejects.toThrow();
    });
    expect(fixture.posts).toHaveLength(0);
    const record = await fixture.control.getAllocationRecord();
    if (record.state.kind !== 'unknown') throw new Error('Expected an unknown allocation');
    expect(record.state.target?.e2b?.submissionState).toBe('pending');
  });

  it("does not let a cancelled generation's late submission poison its healthy successor", async () => {
    const fixture = await fixtureWithRealAdapter();
    const keys = delayCreateKeys(2);
    const acquisitionA = { id: crypto.randomUUID(), deadlineAt: Date.now() + 60_000 };
    const inputA = { ...fixture.input, acquisition: acquisitionA };
    let pendingA: Promise<unknown> = Promise.resolve();
    await runInDurableObject(fixture.control, async instance => {
      pendingA = instance.ensureReady(inputA).catch(error => error);
      await keys.started(0);
      await instance.beginStop('cancel A');
      await expect(instance.getAllocationRecord()).resolves.toMatchObject({
        state: { kind: 'stopped' },
      });
      // B creates and becomes healthy while A's key is still held. A finishing
      // after B is the ordering the forward-only test does not exercise.
      const pendingB = instance.ensureReady(fixture.input);
      await keys.started(1);
      keys.complete(1);
      await expect(pendingB).resolves.toMatchObject({ physical: 'running' });
      // A's stale key resolves after B is healthy. Its rejected submission must
      // not write the policy-mismatch failure onto B's record.
      keys.complete(0);
      await pendingA;
    });
    expect(fixture.posts).toHaveLength(1);
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'allocated' },
    });
    const status = await fixture.control.getStatus();
    expect(status.physical).toBe('running');
    expect(status.failureReason).toBeUndefined();
  });

  it('leaves the submission pending and never POSTs when the canonical put fails on the real transport', async () => {
    const fixture = await fixtureWithRealAdapter();
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
    // The real adapter resolves credentials and invokes the submission callback
    // before the POST, so a rolled-back submission leaves the POST count at 0.
    expect(fixture.posts).toHaveLength(0);
    const record = await fixture.control.getAllocationRecord();
    if (record.state.kind !== 'unknown') throw new Error('Expected an unknown allocation');
    expect(record.state.target?.e2b?.submissionState).toBe('pending');
    expect(record.state.target?.providerRef).toBeNull();
  });
});
