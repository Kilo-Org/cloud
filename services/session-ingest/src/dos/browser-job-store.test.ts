import { describe, expect, it } from 'vitest';
import {
  BROWSER_APPROVAL_TIMEOUT_MS,
  BROWSER_CLOCK_SKEW_MS,
  BROWSER_EXECUTION_TIMEOUT_MS,
  BROWSER_LEASE_MS,
  BROWSER_MAX_JOBS,
  BROWSER_MAX_PROVIDERS,
  BROWSER_MAX_QUEUED,
  BROWSER_QUEUE_TIMEOUT_MS,
  BROWSER_RETENTION_MS,
  createBrowserJobStore,
  type BrowserStoreSocket,
} from './browser-job-store';
import {
  browserProviderInboundMessageSchema,
  browserResultSchema,
  type BrowserJobSnapshot,
  type BrowserProviderOutboundMessage,
  type BrowserRequest,
  type BrowserResult,
} from '../types/user-connection-protocol';

const NOW = Date.UTC(2026, 7, 28);
const OWNER = { parentSessionId: 'ses_parent', parentProof: 'a'.repeat(64) };
const TAB = {
  tabId: 42,
  title: 'Approved tab',
  url: 'https://example.com/',
  effectiveMode: 'safe' as const,
};
type Invoke = Extract<BrowserRequest, { operation: 'invoke' }>;
type Register = Extract<BrowserProviderOutboundMessage, { type: 'provider_register' }>;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function invocation(n: number, createdAt = NOW): string {
  return `b1.${createdAt}.${n.toString(16).padStart(64, '0')}`;
}

function registration(n = 1, changes: Partial<Register> = {}): Register {
  return {
    type: 'provider_register',
    requestId: uuid(n),
    providerId: `bp_${uuid(n)}`,
    providerProof: n.toString(16).padStart(64, 'f'),
    generation: 0,
    label: `Profile ${n}`,
    enabled: true,
    ...changes,
  };
}

function request(n = 1, changes: Partial<Invoke> = {}): Invoke {
  return {
    type: 'browser_request',
    operation: 'invoke',
    requestId: uuid(n + 100),
    owner: OWNER,
    providerId: registration().providerId,
    invocationId: invocation(n),
    goal: `Observe page ${n}`,
    ...changes,
  };
}

function socket(role: 'cli' | 'web', connectionId: string = role, kiloUserId = 'user_1') {
  let attachment: Record<string, unknown> = { role, connectionId, kiloUserId, sessions: [] };
  return {
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment(value: unknown) {
      attachment = structuredClone(value as Record<string, unknown>);
    },
  } satisfies BrowserStoreSocket;
}

/** Serial transactions clone reads/writes, commit together, and discard failed writes. */
function transactionalStorage() {
  let committed = new Map<string, unknown>();
  let serial: Promise<unknown> = Promise.resolve();
  let failWrite: string | undefined;
  let failCommit = false;
  let rejectReads = false;
  let pause:
    | {
        arrived: ReturnType<typeof Promise.withResolvers<void>>;
        resume: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let replay = false;

  const storage: Pick<DurableObjectStorage, 'transaction'> = {
    transaction<T>(run: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const next = serial.then(async () => {
        async function attempt(commit: boolean): Promise<T> {
          const working = new Map(committed);
          const tx = {
            async get<V>(key: string): Promise<V | undefined> {
              if (rejectReads) throw new Error('Storage reads are unavailable');
              return structuredClone(working.get(key)) as V | undefined;
            },
            async put(key: string, value: unknown) {
              if (failWrite && key.startsWith(failWrite)) {
                failWrite = undefined;
                throw new Error('Injected write failure');
              }
              working.set(key, structuredClone(value));
            },
            async delete(key: string) {
              return working.delete(key);
            },
            async list<V>(
              options: { prefix?: string; limit?: number } = {}
            ): Promise<Map<string, V>> {
              if (rejectReads) throw new Error('Storage reads are unavailable');
              return new Map(
                [...working]
                  .filter(([key]) => key.startsWith(options.prefix ?? ''))
                  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                  .slice(0, options.limit)
                  .map(([key, value]) => [key, structuredClone(value) as V])
              );
            },
          };
          const value = await run(tx as DurableObjectTransaction);
          if (commit && pause) {
            const held = pause;
            pause = undefined;
            held.arrived.resolve();
            await held.resume.promise;
          }
          if (failCommit) {
            failCommit = false;
            throw new Error('Injected commit failure');
          }
          if (commit) committed = working;
          return value;
        }
        if (replay) {
          replay = false;
          await attempt(false);
        }
        return attempt(true);
      });
      serial = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };

  return {
    storage,
    snapshot: () =>
      structuredClone([...committed].sort(([left], [right]) => left.localeCompare(right))),
    entries: (prefix: string) =>
      structuredClone([...committed].filter(([key]) => key.startsWith(prefix))),
    get: (key: string) => structuredClone(committed.get(key)),
    seed(key: string, value: unknown) {
      committed.set(key, structuredClone(value));
    },
    failWrite(prefix: string) {
      failWrite = prefix;
    },
    failCommit() {
      failCommit = true;
    },
    rejectReads() {
      rejectReads = true;
    },
    replayTransaction() {
      replay = true;
    },
    holdCommit() {
      const held = {
        arrived: Promise.withResolvers<void>(),
        resume: Promise.withResolvers<void>(),
      };
      pause = held;
      return { arrived: held.arrived.promise, release: () => held.resume.resolve() };
    },
  };
}

async function setup() {
  const fake = transactionalStorage();
  const store = createBrowserJobStore(fake.storage);
  const cli = socket('cli');
  const panel = socket('web');
  const grant = (await store.registerProvider(panel, registration(), NOW)).value;
  return { fake, store, cli, panel, grant };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

function binding(job: BrowserJobSnapshot) {
  return {
    providerId: job.providerId,
    browserTaskId: job.browserTaskId,
    jobId: job.jobId,
    invocationId: job.invocationId,
    generation: job.generation,
  };
}

function ownedLookup(
  job: BrowserJobSnapshot,
  operation: 'status' | 'cancel' = 'status',
  owner = OWNER
): BrowserRequest {
  return {
    type: 'browser_request',
    requestId: uuid(999),
    operation,
    owner,
    browserTaskId: job.browserTaskId,
    jobId: job.jobId,
  };
}

function recovery(id: string, owner = OWNER): BrowserRequest {
  return {
    type: 'browser_request',
    requestId: uuid(998),
    operation: 'recover',
    owner,
    invocationId: id,
  };
}

async function status(f: Fixture, job: BrowserJobSnapshot, now = NOW) {
  return (await f.store.lookup(f.cli, ownedLookup(job), now)).value;
}

async function admit(f: Fixture, n = 1, changes: Partial<Invoke> = {}) {
  return (await f.store.invoke(f.cli, request(n, changes), NOW)).value.job;
}

async function dispatch(f: Fixture, providerId = registration().providerId, now = NOW) {
  const { value } = await f.store.dispatch(providerId, now);
  if (!value) throw new Error('Expected a committed dispatch');
  return value.message.job;
}

async function approve(
  f: Fixture,
  job: BrowserJobSnapshot,
  now = NOW,
  tab: NonNullable<BrowserJobSnapshot['approvedTab']> = TAB
) {
  await f.store.updateProvider(
    f.panel,
    {
      type: 'provider_approval',
      ...binding(job),
      approval: { decision: 'approved', tab },
    },
    now
  );
  const running = await status(f, job, now);
  if (!running) throw new Error('Expected a running job');
  return running;
}

async function running(f: Fixture, changes: Partial<Invoke> = {}) {
  await admit(f, 1, changes);
  return approve(f, await dispatch(f));
}

async function nearLimitRunning(f: Fixture, createdAt = NOW) {
  await admit(f, 1, { goal: '\u0000'.repeat(16_384), invocationId: invocation(1, createdAt) });
  const job = await dispatch(f);
  const expiresAt = Date.parse(job.expiresAt);
  const tab = { ...TAB, url: `https://example.com/?${'\u0000'.repeat(5_000)}` };
  const stored = f.fake.get(`browser/job/${job.jobId}`) as { snapshot: BrowserJobSnapshot };
  const approved = {
    ...stored,
    snapshot: {
      ...job,
      status: 'running',
      approvedTab: tab,
      deadlines: {
        ...job.deadlines,
        execution: new Date(Math.min(expiresAt, NOW + BROWSER_EXECUTION_TIMEOUT_MS)).toISOString(),
        lease: new Date(Math.min(expiresAt, NOW + BROWSER_LEASE_MS)).toISOString(),
      },
    },
  };
  tab.url += 'x'.repeat(
    128 * 1024 - 1 - new TextEncoder().encode(JSON.stringify(approved)).byteLength
  );
  const active = await approve(f, job, NOW, tab);
  expect(
    new TextEncoder().encode(JSON.stringify(f.fake.get(`browser/job/${job.jobId}`))).byteLength
  ).toBe(128 * 1024 - 1);
  return active;
}

function expectBoundedRecords(f: Fixture) {
  for (const [key, record] of f.fake.entries('browser/')) {
    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength, key).toBeLessThan(
      128 * 1024
    );
  }
}

function success(
  job: BrowserJobSnapshot,
  changes: Partial<Extract<BrowserResult, { status: 'succeeded' }>> = {}
): Extract<BrowserResult, { status: 'succeeded' }> {
  return {
    providerId: job.providerId,
    browserTaskId: job.browserTaskId,
    jobId: job.jobId,
    invocationId: job.invocationId,
    status: 'succeeded',
    reason: 'completed',
    effectsUncertain: false,
    summary: 'Observed the expected page.',
    evidence: [{ text: 'The page shows the requested value.', url: TAB.url }],
    ...changes,
  };
}

function resultMessage(job: BrowserJobSnapshot, result: BrowserResult = success(job)) {
  return { type: 'provider_result' as const, ...binding(job), tab: job.approvedTab ?? TAB, result };
}

function quiesced(job: BrowserJobSnapshot) {
  return {
    type: 'provider_quiesced' as const,
    ...binding(job),
    ...(job.approvedTab === undefined ? {} : { tabId: job.approvedTab.tabId }),
  };
}

async function heartbeat(
  f: Fixture,
  at: number,
  providerId = f.grant.providerId,
  generation = f.grant.generation,
  panel = f.panel
) {
  return f.store.updateProvider(
    panel,
    { type: 'provider_heartbeat', providerId, generation, requestId: uuid(997) },
    at
  );
}

async function keepLease(f: Fixture, until: number) {
  for (let at = NOW + 10_000; at < until; at += 10_000) await heartbeat(f, at);
}

describe('browser job ownership and durable admission', () => {
  it('commits isolated conversations, references, dedupe, and FIFO without touching legacy records', async () => {
    const f = await setup();
    f.fake.seed('pendingCommand/legacy', { state: 'pending', expiresAt: NOW });
    f.fake.seed('rename:legacy', { title: 'Unchanged' });
    const first = await admit(f);
    const second = await admit(f, 2);
    expect(second.browserTaskId).not.toBe(first.browserTaskId);
    expect((await f.store.lookup(f.cli, recovery(first.invocationId), NOW)).value).toEqual(first);
    expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 2, fences: 0 });
    expect(f.fake.get(`browser/provider/${first.providerId}`)).toMatchObject({
      queue: [first.jobId, second.jobId],
      references: 2,
    });
    expect(f.fake.entries('browser/invocation/')).toHaveLength(2);
    expect(f.fake.entries('browser/conversation/')).toHaveLength(2);
    await f.store.expire(NOW + BROWSER_RETENTION_MS);
    await f.store.cleanup(NOW + BROWSER_RETENTION_MS);
    expect(f.fake.get('pendingCommand/legacy')).toEqual({ state: 'pending', expiresAt: NOW });
    expect(f.fake.get('rename:legacy')).toEqual({ title: 'Unchanged' });
    expect(f.fake.entries('browser/owner/')).toEqual([]);
    expect(f.fake.entries('browser/capability/')).toEqual([]);
    expect(f.fake.entries('browser/conversation/')).toEqual([]);
  });

  it.each([
    [
      'another proof for the retained parent',
      { parentSessionId: OWNER.parentSessionId, parentProof: 'b'.repeat(64) },
    ],
    [
      'the copied capability in a fork',
      { parentSessionId: 'ses_fork', parentProof: OWNER.parentProof },
    ],
    [
      'a foreign parent with its own capability',
      { parentSessionId: 'ses_other', parentProof: 'b'.repeat(64) },
    ],
  ])('denies owned lookup and continuation for %s', async (_name, owner) => {
    const f = await setup();
    const job = await admit(f);
    const before = f.fake.snapshot();
    for (const input of [
      ownedLookup(job, 'status', owner),
      ownedLookup(job, 'cancel', owner),
      recovery(job.invocationId, owner),
    ]) {
      await expect(f.store.lookup(f.cli, input, NOW)).rejects.toMatchObject({
        code: 'owner_mismatch',
      });
    }
    await expect(
      f.store.invoke(f.cli, request(2, { owner, browserTaskId: job.browserTaskId }), NOW)
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('refuses a copied capability when a fork tries to bind a fresh conversation', async () => {
    const f = await setup();
    await admit(f);
    await expect(
      f.store.invoke(f.cli, request(2, { owner: { ...OWNER, parentSessionId: 'ses_fork' } }), NOW)
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(f.fake.entries('browser/job/')).toHaveLength(1);
    expect(f.fake.entries('browser/owner/')).toHaveLength(1);
  });

  it.each(['status', 'cancel', 'recover', 'invoke', 'register'] as const)(
    'denies another authenticated user on %s',
    async operation => {
      const f = await setup();
      const job = await admit(f);
      const other = socket(operation === 'register' ? 'web' : 'cli', 'same-client-id', 'user_2');
      const before = f.fake.snapshot();
      const action =
        operation === 'register'
          ? f.store.registerProvider(other, registration(), NOW)
          : operation === 'invoke'
            ? f.store.invoke(other, request(), NOW)
            : f.store.lookup(
                other,
                operation === 'recover' ? recovery(job.invocationId) : ownedLookup(job, operation),
                NOW
              );
      await expect(action).rejects.toMatchObject({ code: 'owner_mismatch' });
      expect(f.fake.snapshot()).toEqual(before);
    }
  );

  it('binds delivery to the proven socket attachment, not a colliding connectionId or heartbeat claim', async () => {
    const f = await setup();
    const job = await admit(f);
    const firstAttachment = f.cli.deserializeAttachment();
    const impostor = socket('cli');
    impostor.serializeAttachment({
      ...impostor.deserializeAttachment(),
      sessions: [{ id: OWNER.parentSessionId }],
    });
    await expect(
      f.store.lookup(
        impostor,
        recovery(job.invocationId, { ...OWNER, parentProof: 'b'.repeat(64) }),
        NOW
      )
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    const changed = await f.store.dispatch(job.providerId, NOW);
    expect(changed.effects.updates[0]?.delivery.socketId).toBe(firstAttachment.browserSocketId);
    expect(changed.effects.updates[0]?.delivery.socketId).not.toBe(
      impostor.deserializeAttachment().browserSocketId
    );
    expect(changed.effects.updates[0]?.delivery.connectionId).toBe('cli');
    expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 1, fences: 1 });
  });

  it('rebinds only delivery after proof on a new socket and never persists raw proofs', async () => {
    const f = await setup();
    const job = await running(f);
    const oldDispatch = (f.fake.get(`browser/job/${job.jobId}`) as { dispatch: unknown }).dispatch;
    const replacement = socket('cli', 'reconnected');
    const restarted = createBrowserJobStore(f.fake.storage);
    const recovered = await restarted.lookup(replacement, recovery(job.invocationId), NOW + 1);
    expect(recovered.value).toEqual(job);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ dispatch: oldDispatch });
    expect(f.fake.get(`browser/invocation/${job.invocationId}`)).toMatchObject({
      delivery: {
        socketId: replacement.deserializeAttachment().browserSocketId,
        connectionId: 'reconnected',
      },
    });
    expect((await restarted.dispatch(job.providerId, NOW + 1)).value).toBeNull();
    const serialized = JSON.stringify(f.fake.snapshot());
    expect(serialized).not.toContain(OWNER.parentProof);
    expect(serialized).not.toContain(registration().providerProof);
    expect(JSON.stringify(recovered)).not.toContain('digest');
  });

  it.each(['queued', 'awaiting_approval', 'running', 'succeeded'] as const)(
    'returns the exact durable duplicate in %s without renewing time or dispatch',
    async state => {
      const f = await setup();
      let job = await admit(f);
      if (state !== 'queued') job = await dispatch(f);
      if (state === 'running' || state === 'succeeded') job = await approve(f, job);
      if (state === 'succeeded') {
        await f.store.updateProvider(f.panel, resultMessage(job), NOW);
        job = (await status(f, job))!;
      }
      await f.store.lookup(
        f.cli,
        { ...recovery(job.invocationId), requestId: request().requestId },
        NOW
      );
      const snapshot = f.fake.snapshot();
      const duplicate = await createBrowserJobStore(f.fake.storage).invoke(
        f.cli,
        request(),
        NOW + 1
      );
      expect(duplicate.value).toEqual({ job, duplicate: true });
      expect(f.fake.snapshot()).toEqual(snapshot);
      expect(f.fake.entries('browser/job/')).toHaveLength(1);
    }
  );

  it.each(['goal', 'provider', 'conversation'] as const)(
    'rejects a duplicate with a changed %s without changing any record',
    async field => {
      const f = await setup();
      const job = await admit(f);
      const before = f.fake.snapshot();
      const changes: Partial<Invoke> =
        field === 'goal'
          ? { goal: 'A different action' }
          : field === 'provider'
            ? { providerId: registration(2).providerId }
            : { browserTaskId: job.browserTaskId };
      await expect(f.store.invoke(f.cli, request(1, changes), NOW + 1)).rejects.toMatchObject({
        code: 'invocation_conflict',
      });
      expect(f.fake.snapshot()).toEqual(before);
    }
  );

  it('admits one concurrent invocation, returns all exact duplicates, and rejects conflicting contenders', async () => {
    const f = await setup();
    const admitted = await Promise.all(
      Array.from({ length: 12 }, () => f.store.invoke(f.cli, request(), NOW))
    );
    expect(new Set(admitted.map(result => result.value.job.jobId)).size).toBe(1);
    expect(admitted.filter(result => !result.value.duplicate)).toHaveLength(1);
    const before = f.fake.snapshot();
    const conflicts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, n) =>
        f.store.invoke(f.cli, request(1, { goal: `conflict ${n}` }), NOW)
      )
    );
    expect(
      conflicts.every(
        result => result.status === 'rejected' && result.reason.code === 'invocation_conflict'
      )
    ).toBe(true);
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('allows one outstanding continuation and keeps the stable conversation after terminal settlement', async () => {
    const f = await setup();
    const first = await admit(f);
    await expect(
      f.store.invoke(f.cli, request(2, { browserTaskId: first.browserTaskId }), NOW)
    ).rejects.toMatchObject({ code: 'conversation_busy' });
    await f.store.lookup(f.cli, ownedLookup(first, 'cancel'), NOW);
    const second = await admit(f, 2, { browserTaskId: first.browserTaskId });
    expect(second.browserTaskId).toBe(first.browserTaskId);
    expect(second.jobId).not.toBe(first.jobId);
    expect(await status(f, first)).toMatchObject({ status: 'cancelled' });
    const latest = await f.store.lookup(f.cli, { ...ownedLookup(first), jobId: undefined }, NOW);
    expect(latest.value?.jobId).toBe(second.jobId);
    expect(f.fake.entries('browser/conversation/')).toHaveLength(1);
    expect(f.fake.get(`browser/conversation/${first.browserTaskId}`)).toMatchObject({
      references: 2,
      outstandingJobId: second.jobId,
    });
  });

  it('rejects a job selected from another conversation, including one owned by the same parent', async () => {
    const f = await setup();
    const first = await admit(f);
    const second = await admit(f, 2);
    const before = f.fake.snapshot();
    await expect(
      f.store.lookup(f.cli, { ...ownedLookup(first), jobId: second.jobId }, NOW)
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('returns authoritative not-found without allocating or renewing an invocation', async () => {
    const f = await setup();
    const before = f.fake.snapshot();
    expect((await f.store.lookup(f.cli, recovery(invocation(500)), NOW)).value).toBeNull();
    expect(f.fake.snapshot()).toEqual(before);
  });

  it.each([
    'browser/invocation/',
    'browser/owner/',
    'browser/capability/',
    'browser/conversation/',
    'browser/meta',
  ])('rolls back the complete admission when %s cannot commit', async prefix => {
    const f = await setup();
    const before = f.fake.snapshot();
    f.fake.failWrite(prefix);
    await expect(f.store.invoke(f.cli, request(), NOW)).rejects.toThrow('Injected write failure');
    expect(f.fake.snapshot()).toEqual(before);
    const accepted = await f.store.invoke(f.cli, request(), NOW);
    expect(accepted.value.duplicate).toBe(false);
    expect(f.fake.get(`browser/provider/${accepted.value.job.providerId}`)).toMatchObject({
      references: 1,
      queue: [accepted.value.job.jobId],
    });
  });

  it('keeps one committed conversation and one effect when storage retries a transaction callback', async () => {
    const f = await setup();
    f.fake.replayTransaction();
    const job = await admit(f);
    expect(f.fake.entries('browser/job/')).toHaveLength(1);
    expect(f.fake.entries('browser/conversation/')).toHaveLength(1);
    f.fake.replayTransaction();
    const sent = await f.store.dispatch(job.providerId, NOW);
    expect(sent.effects.updates).toHaveLength(1);
    expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 1, fences: 1 });
    expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
  });
});

describe('browser job conversation intent', () => {
  it.each(['new', 'continue'] as const)(
    'persists %s intent across reload and duplicate delivery without redispatch',
    async mode => {
      const f = await setup();
      let input = request();
      if (mode === 'continue') {
        const first = await running(f);
        await f.store.updateProvider(f.panel, resultMessage(first), NOW);
        await f.store.updateProvider(f.panel, quiesced(first), NOW);
        input = request(2, { browserTaskId: first.browserTaskId });
      }
      const job = (await f.store.invoke(f.cli, input, NOW)).value.job;
      const jobKey = `browser/job/${job.jobId}`;
      const stored = f.fake.get(jobKey);
      expect(stored).toMatchObject({ conversationMode: mode });

      const restarted = createBrowserJobStore(f.fake.storage);
      const reconnected = socket('cli', 'reconnected');
      const duplicate = await restarted.invoke(
        reconnected,
        { ...input, requestId: uuid(301) },
        NOW + 1
      );
      expect(duplicate.value).toEqual({ job, duplicate: true });
      await expect(
        restarted.invoke(
          reconnected,
          { ...input, browserTaskId: mode === 'new' ? job.browserTaskId : undefined },
          NOW + 1
        )
      ).rejects.toMatchObject({ code: 'invocation_conflict' });
      expect(f.fake.get(jobKey)).toEqual(stored);

      const attempts = await Promise.all(
        Array.from({ length: 4 }, () => restarted.dispatch(job.providerId, NOW + 2))
      );
      const messages = attempts.flatMap(attempt => (attempt.value ? [attempt.value.message] : []));
      expect(messages).toMatchObject([
        {
          type: 'provider_job',
          conversationMode: mode,
          job: { jobId: job.jobId, status: 'awaiting_approval' },
        },
      ]);
      expect(browserProviderInboundMessageSchema.parse(messages[0])).toEqual(messages[0]);
      expect(f.fake.get(jobKey)).toMatchObject({ conversationMode: mode });
      expect((await restarted.invoke(reconnected, input, NOW + 3)).value).toEqual({
        job: messages[0]?.job,
        duplicate: true,
      });
      expect(
        (await createBrowserJobStore(f.fake.storage).dispatch(job.providerId, NOW + 3)).value
      ).toBeNull();
    }
  );

  it('keeps continuation intent after earlier conversation jobs expire', async () => {
    const f = await setup();
    const first = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.updateProvider(f.panel, resultMessage(first), NOW);
    await f.store.updateProvider(f.panel, quiesced(first), NOW);
    const continuation = await admit(f, 2, { browserTaskId: first.browserTaskId });
    await f.store.expire(NOW + 1_000);
    expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
    expect(f.fake.get(`browser/conversation/${first.browserTaskId}`)).toMatchObject({
      references: 1,
      latestJobId: continuation.jobId,
    });
    const dispatched = await createBrowserJobStore(f.fake.storage).dispatch(
      continuation.providerId,
      NOW + 1_001
    );
    expect(dispatched.value?.message).toMatchObject({
      conversationMode: 'continue',
      job: { jobId: continuation.jobId, browserTaskId: first.browserTaskId },
    });
  });

  it('rejects an unknown continuation instead of admitting a new conversation', async () => {
    const f = await setup();
    const before = f.fake.snapshot();
    await expect(
      f.store.invoke(f.cli, request(1, { browserTaskId: `bt_${uuid(901)}` }), NOW)
    ).rejects.toMatchObject({ code: 'invocation_expired', retryable: false });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('settles legacy queued intent as a recoverable result without execution authority', async () => {
    const f = await setup();
    const job = await admit(f);
    const jobKey = `browser/job/${job.jobId}`;
    const legacy = f.fake.get(jobKey) as Record<string, unknown>;
    delete legacy.conversationMode;
    f.fake.seed(jobKey, legacy);
    const providerKey = `browser/provider/${job.providerId}`;
    const provider = f.fake.get(providerKey) as Record<string, unknown>;
    const owner = f.fake.get('browser/owner/ses_parent');
    const restarted = createBrowserJobStore(f.fake.storage);
    const reconnected = socket('cli', 'reconnected');
    expect((await restarted.invoke(reconnected, request(), NOW + 1)).value).toEqual({
      job,
      duplicate: true,
    });
    expect(f.fake.get(jobKey)).toEqual(legacy);

    const rejected = await restarted.dispatch(job.providerId, NOW + 2);
    expect(rejected.value).toBeNull();
    expect(rejected.effects).toMatchObject({
      cancellations: [],
      updates: [
        {
          job: {
            jobId: job.jobId,
            status: 'failed',
            result: {
              reason: 'invalid_request',
              effectsUncertain: false,
              summary: 'The browser task has no recorded conversation intent. It did not start.',
              evidence: [],
            },
          },
        },
      ],
    });
    expect(f.fake.get(jobKey)).not.toHaveProperty('dispatch');
    expect(f.fake.get(jobKey)).not.toHaveProperty('conversationMode');
    expect(f.fake.get(providerKey)).toEqual({ ...provider, queue: [] });
    expect(f.fake.get('browser/owner/ses_parent')).toEqual(owner);
    expect(f.fake.get(`browser/conversation/${job.browserTaskId}`)).not.toHaveProperty(
      'outstandingJobId'
    );
    const settled = rejected.effects.updates[0]?.job;
    expect(
      (await restarted.lookup(reconnected, recovery(job.invocationId), NOW + 3)).value
    ).toEqual(settled);
    expect((await restarted.invoke(reconnected, request(), NOW + 3)).value).toEqual({
      job: settled,
      duplicate: true,
    });
    expect((await restarted.dispatch(job.providerId, NOW + 3)).value).toBeNull();
    expect(await restarted.pendingCancellations()).toEqual([]);
    expectBoundedRecords(f);
    expect((await restarted.cleanup(NOW + BROWSER_RETENTION_MS - 1)).value).toBe(0);
    await restarted.expire(NOW + BROWSER_RETENTION_MS);
    expect((await restarted.cleanup(NOW + BROWSER_RETENTION_MS)).value).toBe(1);
    expect(f.fake.entries('browser/owner/')).toEqual([]);
    expect(f.fake.entries('browser/provider/')).toEqual([]);
  });

  it('skips an ambiguous legacy queue head and dispatches only the next proven intent', async () => {
    const f = await setup();
    const legacyJob = await admit(f);
    const next = await admit(f, 2);
    const legacyKey = `browser/job/${legacyJob.jobId}`;
    const legacy = f.fake.get(legacyKey) as Record<string, unknown>;
    delete legacy.conversationMode;
    f.fake.seed(legacyKey, legacy);
    const dispatched = await createBrowserJobStore(f.fake.storage).dispatch(next.providerId, NOW);
    expect(dispatched.value?.message).toMatchObject({
      conversationMode: 'new',
      job: { jobId: next.jobId },
    });
    expect(dispatched.effects.updates.map(update => update.job)).toMatchObject([
      { jobId: legacyJob.jobId, status: 'failed' },
      { jobId: next.jobId, status: 'awaiting_approval' },
    ]);
    expect(dispatched.effects.cancellations).toEqual([]);
    expect(f.fake.get(legacyKey)).not.toHaveProperty('dispatch');
    expect(f.fake.get(`browser/provider/${next.providerId}`)).toMatchObject({
      queue: [],
      fence: { jobId: next.jobId, requiresRecovery: false },
    });
    expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 2, fences: 1 });
  });

  it.each(['awaiting_approval', 'running'] as const)(
    'recovers legacy %s work without inventing intent or dispatching again',
    async state => {
      const f = await setup();
      await admit(f);
      let job = await dispatch(f);
      if (state === 'running') job = await approve(f, job);
      const jobKey = `browser/job/${job.jobId}`;
      const legacy = f.fake.get(jobKey) as Record<string, unknown>;
      delete legacy.conversationMode;
      f.fake.seed(jobKey, legacy);
      const restarted = createBrowserJobStore(f.fake.storage);
      expect((await restarted.lookup(f.cli, recovery(job.invocationId), NOW)).value).toEqual(job);
      expect((await restarted.invoke(f.cli, request(), NOW)).value).toEqual({
        job,
        duplicate: true,
      });
      expect((await restarted.dispatch(job.providerId, NOW)).value).toBeNull();
      expect(f.fake.get(jobKey)).toEqual(legacy);
    }
  );
});

describe('browser job provider fencing and transitions', () => {
  it.each(['different proof', 'copied profile proof'] as const)(
    'rejects provider registration with a %s',
    async variant => {
      const f = await setup();
      const before = f.fake.snapshot();
      const message =
        variant === 'different proof'
          ? registration(1, { providerProof: 'f'.repeat(64) })
          : registration(2, { providerProof: registration().providerProof });
      await expect(f.store.registerProvider(socket('web'), message, NOW)).rejects.toMatchObject({
        code: 'owner_mismatch',
      });
      expect(f.fake.snapshot()).toEqual(before);
    }
  );

  it('allocates monotonic generations across restarts and reclaimed provider bindings', async () => {
    const f = await setup();
    const second = (await f.store.registerProvider(f.panel, registration(), NOW)).value;
    await f.store.disconnectProvider(f.panel, NOW);
    expect(f.fake.entries('browser/provider/')).toEqual([]);
    const third = (
      await createBrowserJobStore(f.fake.storage).registerProvider(
        socket('web'),
        registration(1, { generation: second.generation }),
        NOW
      )
    ).value;
    expect(second.generation).toBeGreaterThan(f.grant.generation);
    expect(third.generation).toBeGreaterThan(second.generation);
  });

  it('terminalizes old queued work instead of adopting it into a new generation', async () => {
    const f = await setup();
    const job = await admit(f);
    const registered = await f.store.registerProvider(
      socket('web', 'new-panel'),
      registration(),
      NOW + 1
    );
    expect(registered.value.generation).toBeGreaterThan(job.generation);
    expect(await status(f, job)).toMatchObject({
      status: 'interrupted',
      result: { reason: 'provider_unavailable' },
    });
    expect((await f.store.dispatch(job.providerId, NOW + 1)).value).toBeNull();
    expect(f.fake.entries('browser/job/')).toHaveLength(1);
  });

  it('holds the dispatch result until its complete intent commits and never returns it again after restart', async () => {
    const f = await setup();
    const job = await admit(f);
    const held = f.fake.holdCommit();
    let returned = false;
    const pending = f.store.dispatch(job.providerId, NOW).then(result => {
      returned = true;
      return result;
    });
    await held.arrived;
    expect(returned).toBe(false);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      snapshot: { status: 'queued' },
    });
    held.release();
    const sent = await pending;
    expect(sent.value?.message.job.status).toBe('awaiting_approval');
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      dispatch: { at: NOW, routing: { socketId: f.panel.deserializeAttachment().browserSocketId } },
      snapshot: { status: 'awaiting_approval' },
    });
    const restarted = createBrowserJobStore(f.fake.storage);
    expect((await restarted.dispatch(job.providerId, NOW + 1)).value).toBeNull();
    expect((await restarted.lookup(f.cli, recovery(job.invocationId), NOW + 1)).value).toEqual(
      sent.value?.message.job
    );
  });

  it('leaves a failed dispatch commit queued and returns no executable effect', async () => {
    const f = await setup();
    const job = await admit(f);
    const before = f.fake.snapshot();
    f.fake.failCommit();
    await expect(f.store.dispatch(job.providerId, NOW)).rejects.toThrow('Injected commit failure');
    expect(f.fake.snapshot()).toEqual(before);
    expect((await dispatch(f)).jobId).toBe(job.jobId);
  });

  it('serializes dispatch and advances FIFO only after legacy concrete-tab quiescence', async () => {
    const f = await setup();
    const accepted: BrowserJobSnapshot[] = [];
    await Promise.all(
      [1, 2, 3].map(async n => {
        accepted.push(await admit(f, n));
      })
    );
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => f.store.dispatch(f.grant.providerId, NOW))
    );
    expect(attempts.filter(result => result.value !== null)).toHaveLength(1);
    const first = attempts.find(result => result.value)?.value?.message.job;
    expect(first?.jobId).toBe(accepted[0]?.jobId);
    if (!first) throw new Error('Missing queue head');
    await f.store.lookup(f.cli, ownedLookup(first, 'cancel'), NOW);
    expect((await f.store.dispatch(first.providerId, NOW)).value).toBeNull();
    await f.store.updateProvider(f.panel, { ...quiesced(first), tabId: TAB.tabId }, NOW);
    const second = await dispatch(f);
    expect(second.jobId).toBe(accepted[1]?.jobId);
    await expect(f.store.updateProvider(f.panel, quiesced(first), NOW)).rejects.toMatchObject({
      code: 'owner_mismatch',
    });
    expect((await f.store.dispatch(second.providerId, NOW)).value).toBeNull();
    expect(await status(f, second)).toEqual(second);
  });

  it.each([
    ['approval denial', 'failed', 'approval_denied'],
    ['owner cancellation', 'cancelled', 'cancelled'],
    ['provider cancellation', 'cancelled', 'cancelled'],
  ] as const)(
    'advances only the owned FIFO queue after no-tab quiescence following %s',
    async (event, terminalStatus, reason) => {
      const f = await setup();
      await admit(f);
      const first = await dispatch(f);
      const second = await admit(f, 2);
      const third = await admit(f, 3);
      const otherPanel = socket('web', 'other-panel');
      await f.store.registerProvider(otherPanel, registration(2), NOW);
      const other = await admit(f, 4, { providerId: registration(2).providerId });
      await dispatch(f, other.providerId);
      const otherProvider = f.fake.get(`browser/provider/${other.providerId}`);

      const outcome = await (event === 'owner cancellation'
        ? f.store.lookup(f.cli, ownedLookup(first, 'cancel'), NOW)
        : f.store.updateProvider(
            f.panel,
            event === 'approval denial'
              ? {
                  type: 'provider_approval',
                  ...binding(first),
                  approval: { decision: 'denied', reason: 'approval_denied' },
                }
              : { type: 'provider_cancel', ...binding(first) },
            NOW
          ));
      const settled = outcome.effects.updates[0]?.job;
      expect(settled).toMatchObject({
        jobId: first.jobId,
        status: terminalStatus,
        result: { status: terminalStatus, reason, effectsUncertain: false },
      });
      expect(settled).not.toHaveProperty('approvedTab');
      expect(f.fake.get(`browser/provider/${first.providerId}`)).toMatchObject({
        queue: [second.jobId, third.jobId],
        fence: { jobId: first.jobId, requiresRecovery: false },
      });
      expect(f.fake.get(`browser/provider/${first.providerId}`)).not.toHaveProperty('fence.tabId');

      const restarted = createBrowserJobStore(f.fake.storage);
      expect((await restarted.dispatch(first.providerId, NOW + 1)).value).toBeNull();
      const released = await restarted.updateProvider(
        f.panel,
        { type: 'provider_quiesced', ...binding(first) },
        NOW + 1
      );
      expect(released).toEqual({
        value: { job: settled },
        effects: { updates: [], cancellations: [] },
      });
      expect(f.fake.get(`browser/provider/${first.providerId}`)).not.toHaveProperty('fence');
      expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 4, fences: 1 });
      expect(f.fake.get(`browser/provider/${other.providerId}`)).toEqual(otherProvider);
      expect(await restarted.pendingCancellations()).toEqual([]);

      const current = { ...f, store: restarted };
      const next = await dispatch(current, first.providerId, NOW + 2);
      expect(next).toMatchObject({ ...binding(second), status: 'awaiting_approval' });
      expect(next).not.toHaveProperty('approvedTab');
      expect(next.deadlines).not.toHaveProperty('execution');
      expect(await status(current, first, NOW + 2)).toEqual(settled);
      expect(await status(current, third, NOW + 2)).toEqual(third);
      expect(f.fake.get(`browser/provider/${first.providerId}`)).toMatchObject({
        queue: [third.jobId],
        fence: { jobId: second.jobId, requiresRecovery: false },
      });
      expect((await restarted.dispatch(first.providerId, NOW + 2)).value).toBeNull();
      await expect(
        restarted.updateProvider(f.panel, resultMessage(next), NOW + 2)
      ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
      expect(await approve(current, next, NOW + 2)).toMatchObject({
        jobId: second.jobId,
        status: 'running',
        approvedTab: TAB,
      });
      expect(f.fake.get(`browser/provider/${other.providerId}`)).toEqual(otherProvider);
      expectBoundedRecords(f);
    }
  );

  it.each([
    'wrong job',
    'wrong invocation',
    'wrong conversation',
    'wrong provider',
    'foreign socket with the same connectionId',
    'stale generation',
    'foreign user',
    'CLI socket',
    'nonterminal job',
  ] as const)('rejects no-tab quiescence for a %s without releasing the fence', async variant => {
    const f = await setup();
    await f.store.registerProvider(
      f.panel,
      registration(1, { generation: f.grant.generation }),
      NOW
    );
    await admit(f);
    const job = await dispatch(f);
    const queued = await admit(f, 2);
    if (variant !== 'nonterminal job') await f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW);
    const message: Extract<BrowserProviderOutboundMessage, { type: 'provider_quiesced' }> = {
      type: 'provider_quiesced',
      ...binding(job),
    };
    if (variant === 'wrong job') message.jobId = queued.jobId;
    else if (variant === 'wrong invocation') message.invocationId = queued.invocationId;
    else if (variant === 'wrong conversation') message.browserTaskId = queued.browserTaskId;
    else if (variant === 'stale generation') message.generation = f.grant.generation;
    else if (variant === 'wrong provider') {
      await f.store.registerProvider(f.panel, registration(2), NOW);
      const other = await admit(f, 3, { providerId: registration(2).providerId });
      await dispatch(f, other.providerId);
      message.providerId = other.providerId;
      message.generation = other.generation;
    }
    const sender =
      variant === 'foreign socket with the same connectionId'
        ? socket('web')
        : variant === 'foreign user'
          ? socket('web', 'web', 'user_2')
          : variant === 'CLI socket'
            ? f.cli
            : f.panel;
    const before = f.fake.snapshot();
    await expect(f.store.updateProvider(sender, message, NOW)).rejects.toMatchObject({
      code: variant === 'nonterminal job' ? 'invalid_request' : 'owner_mismatch',
      retryable: false,
    });
    expect(f.fake.snapshot()).toEqual(before);
    expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
    expect(await status(f, queued)).toEqual(queued);
  });

  it.each([0, TAB.tabId])(
    'requires exact approved tab %s for terminal quiescence before advancing FIFO',
    async tabId => {
      const f = await setup();
      await admit(f);
      const queued = await admit(f, 2);
      const job = await approve(f, await dispatch(f), NOW, { ...TAB, tabId });
      const settled = await f.store.updateProvider(f.panel, resultMessage(job), NOW);
      const message = { type: 'provider_quiesced' as const, ...binding(job) };
      const before = f.fake.snapshot();
      for (const fields of [{}, { tabId: tabId + 1 }]) {
        await expect(
          f.store.updateProvider(f.panel, { ...message, ...fields }, NOW)
        ).rejects.toMatchObject({ code: 'owner_mismatch', retryable: false });
        expect(f.fake.snapshot()).toEqual(before);
        expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
      }
      const released = await f.store.updateProvider(f.panel, { ...message, tabId }, NOW);
      expect(released.value.job).toEqual(settled.value.job);
      expect(f.fake.get(`browser/provider/${job.providerId}`)).not.toHaveProperty('fence');
      const next = await dispatch(f);
      expect(next).toMatchObject({ jobId: queued.jobId, status: 'awaiting_approval' });
      expect(next).not.toHaveProperty('approvedTab');
    }
  );

  it.each([
    [
      'foreign socket with the same connectionId',
      (f: Fixture, job: BrowserJobSnapshot) =>
        f.store.updateProvider(
          socket('web'),
          {
            type: 'provider_approval',
            ...binding(job),
            approval: { decision: 'approved', tab: TAB },
          },
          NOW
        ),
    ],
    [
      'stale generation',
      (f: Fixture, job: BrowserJobSnapshot) =>
        f.store.updateProvider(
          f.panel,
          {
            type: 'provider_approval',
            ...binding(job),
            generation: job.generation + 1,
            approval: { decision: 'approved', tab: TAB },
          },
          NOW
        ),
    ],
    [
      'foreign job',
      (f: Fixture, job: BrowserJobSnapshot) =>
        f.store.updateProvider(
          f.panel,
          {
            type: 'provider_approval',
            ...binding(job),
            invocationId: invocation(999),
            approval: { decision: 'approved', tab: TAB },
          },
          NOW
        ),
    ],
    [
      'foreign user',
      (f: Fixture, job: BrowserJobSnapshot) =>
        f.store.updateProvider(
          socket('web', 'web', 'user_2'),
          {
            type: 'provider_approval',
            ...binding(job),
            approval: { decision: 'approved', tab: TAB },
          },
          NOW
        ),
    ],
    [
      'CLI socket',
      (f: Fixture, job: BrowserJobSnapshot) =>
        f.store.updateProvider(
          f.cli,
          {
            type: 'provider_approval',
            ...binding(job),
            approval: { decision: 'approved', tab: TAB },
          },
          NOW
        ),
    ],
  ])('rejects approval from a %s without changing the queue or job', async (_name, action) => {
    const f = await setup();
    await admit(f);
    const job = await dispatch(f);
    const before = f.fake.snapshot();
    await expect(action(f, job)).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it.each([
    'approval before dispatch',
    'result before approval',
    'quiescence before terminal',
    'second approval',
    'changed approved tab',
  ] as const)('rejects the invalid transition: %s', async variant => {
    const f = await setup();
    let job = await admit(f);
    if (variant !== 'approval before dispatch') job = await dispatch(f);
    if (variant === 'second approval' || variant === 'changed approved tab')
      job = await approve(f, job);
    const message =
      variant === 'quiescence before terminal'
        ? quiesced(job)
        : variant === 'result before approval'
          ? resultMessage(job)
          : variant === 'changed approved tab'
            ? { ...resultMessage(job), tab: { ...TAB, tabId: 43 } }
            : {
                type: 'provider_approval',
                ...binding(job),
                approval: { decision: 'approved', tab: TAB },
              };
    const before = f.fake.snapshot();
    await expect(f.store.updateProvider(f.panel, message, NOW)).rejects.toMatchObject({
      code: variant === 'approval before dispatch' ? 'owner_mismatch' : 'invalid_request',
    });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('persists denied approval without starting execution or claiming success', async () => {
    const f = await setup();
    await admit(f);
    const job = await dispatch(f);
    const outcome = await f.store.updateProvider(
      f.panel,
      {
        type: 'provider_approval',
        ...binding(job),
        approval: { decision: 'denied', reason: 'approval_denied' },
      },
      NOW
    );
    expect(outcome.effects.updates[0]?.job).toMatchObject({
      status: 'failed',
      result: { reason: 'approval_denied', effectsUncertain: false },
    });
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      snapshot: { status: 'failed' },
    });
    expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
  });

  it('does not return a terminal update before the complete result commits', async () => {
    const f = await setup();
    const job = await running(f);
    const result = success(job);
    const held = f.fake.holdCommit();
    let returned = false;
    const pending = f.store
      .updateProvider(f.panel, resultMessage(job, result), NOW)
      .then(outcome => {
        returned = true;
        return outcome;
      });
    await held.arrived;
    expect(returned).toBe(false);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      snapshot: { status: 'running' },
    });
    held.release();
    const outcome = await pending;
    expect(outcome.effects.updates[0]?.job.result).toEqual(result);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: { result } });
    expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
  });

  it('rolls back a failed terminal commit and retains its execution fence', async () => {
    const f = await setup();
    const job = await running(f);
    const before = f.fake.snapshot();
    f.fake.failCommit();
    await expect(f.store.updateProvider(f.panel, resultMessage(job), NOW)).rejects.toThrow(
      'Injected commit failure'
    );
    expect(f.fake.snapshot()).toEqual(before);
    expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
    await f.store.updateProvider(f.panel, resultMessage(job), NOW);
    expect(await status(f, job)).toMatchObject({ status: 'succeeded', result: success(job) });
  });

  it.each(['result', 'cancel'] as const)(
    'keeps the first terminal settlement when %s wins before competing terminal operations',
    async winner => {
      const f = await setup();
      const job = await running(f);
      if (winner === 'result') await f.store.updateProvider(f.panel, resultMessage(job), NOW);
      else await f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW);
      const first = await status(f, job);
      await Promise.allSettled([
        f.store.updateProvider(
          f.panel,
          resultMessage(job, success(job, { summary: 'A late answer' })),
          NOW + 1
        ),
        f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW + 1),
        f.store.disconnectProvider(f.panel, NOW + 1),
      ]);
      expect(await status(f, job)).toEqual(first);
      expect((await f.store.dispatch(job.providerId, NOW + 1)).value).toBeNull();
    }
  );

  it('settles simultaneous success and cancellation once, including after a restart', async () => {
    const f = await setup();
    const job = await running(f);
    const race = await Promise.allSettled([
      f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW),
      f.store.updateProvider(f.panel, resultMessage(job), NOW),
    ]);
    const settled = await status(f, job);
    expect(['cancelled', 'succeeded']).toContain(settled?.status);
    const changes = race.flatMap(result =>
      result.status === 'fulfilled' ? result.value.effects.updates : []
    );
    expect(changes.filter(update => update.job.jobId === job.jobId)).toHaveLength(1);
    expect(
      (await createBrowserJobStore(f.fake.storage).lookup(f.cli, recovery(job.invocationId), NOW))
        .value
    ).toEqual(settled);
  });

  it('authorizes provider cancellation for a queued job without cancelling the active job', async () => {
    const f = await setup();
    const active = await running(f);
    const queued = await admit(f, 2);
    await expect(
      f.store.updateProvider(socket('web'), { type: 'provider_cancel', ...binding(queued) }, NOW)
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    await f.store.updateProvider(f.panel, { type: 'provider_cancel', ...binding(queued) }, NOW);
    expect(await status(f, queued)).toMatchObject({
      status: 'cancelled',
      result: { effectsUncertain: false },
    });
    expect(await status(f, active)).toEqual(active);
    expect((await f.store.dispatch(active.providerId, NOW)).value).toBeNull();
  });

  it('fences uncertain execution and terminalizes queued work without changing another profile', async () => {
    const f = await setup();
    const active = await running(f);
    const queued = await admit(f, 2);
    const otherPanel = socket('web', 'other-panel');
    await f.store.registerProvider(otherPanel, registration(2), NOW);
    const other = await admit(f, 3, { providerId: registration(2).providerId });
    const uncertain: BrowserResult = {
      ...success(active),
      status: 'interrupted',
      reason: 'effects_uncertain',
      effectsUncertain: true,
    };
    const outcome = await f.store.updateProvider(f.panel, resultMessage(active, uncertain), NOW);
    expect(await status(f, queued)).toMatchObject({
      status: 'interrupted',
      result: { reason: 'provider_unavailable' },
    });
    expect(outcome.effects.cancellations[0]?.message.invocationId).toBe(active.invocationId);
    expect((await f.store.dispatch(active.providerId, NOW)).value).toBeNull();
    expect((await f.store.dispatch(other.providerId, NOW)).value?.message.job.jobId).toBe(
      other.jobId
    );
    const before = f.fake.snapshot();
    await expect(
      f.store.updateProvider(f.panel, { type: 'provider_quiesced', ...binding(active) }, NOW)
    ).rejects.toMatchObject({ code: 'owner_mismatch', retryable: false });
    expect(f.fake.snapshot()).toEqual(before);
    await expect(
      f.store.registerProvider(
        socket('web'),
        registration(1, { generation: active.generation }),
        NOW
      )
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('rejects stale quiescence and recovers only the exact fenced invocation and approved tab', async () => {
    const f = await setup();
    const active = await running(f);
    await f.store.disconnectProvider(f.panel, NOW);
    const panel = socket('web', 'new');
    const recover = registration(1, {
      generation: active.generation,
      recovery: {
        invocationId: active.invocationId,
        tabId: TAB.tabId,
        tabClosed: true,
        locksDrained: true,
      },
    });
    for (const recoveryFields of [
      { invocationId: invocation(99) },
      { tabId: 99 },
      { tabClosed: false },
      { locksDrained: false },
    ]) {
      await expect(
        f.store.registerProvider(
          panel,
          { ...recover, recovery: { ...recover.recovery, ...recoveryFields } },
          NOW
        )
      ).rejects.toBeInstanceOf(Error);
    }
    expect((await f.store.dispatch(active.providerId, NOW)).value).toBeNull();
    const recovered = await f.store.registerProvider(panel, recover, NOW);
    expect(recovered.value.generation).toBeGreaterThan(active.generation);
    await expect(f.store.updateProvider(f.panel, quiesced(active), NOW)).rejects.toMatchObject({
      code: 'owner_mismatch',
    });
    expect(await status(f, active)).toMatchObject({ status: 'interrupted' });
    expect((await f.store.dispatch(active.providerId, NOW)).value).toBeNull();
    const continuation = await admit(f, 2, { browserTaskId: active.browserTaskId });
    expect((await dispatch(f)).jobId).toBe(continuation.jobId);
  });
});

describe('browser job limits and retention', () => {
  it.each([
    ['malformed', 'b1.invalid.digest', 'invalid_request'],
    ['at encoded expiry', invocation(1, NOW - BROWSER_RETENTION_MS), 'invocation_expired'],
    ['older than retention', invocation(1, NOW - BROWSER_RETENTION_MS - 1), 'invocation_expired'],
    ['beyond future clock skew', invocation(1, NOW + BROWSER_CLOCK_SKEW_MS + 1), 'invalid_request'],
  ])('rejects %s before any lookup for invoke and recover', async (_name, invocationId, code) => {
    const f = await setup();
    f.fake.rejectReads();
    await expect(f.store.invoke(f.cli, request(1, { invocationId }), NOW)).rejects.toMatchObject({
      code,
    });
    await expect(f.store.lookup(f.cli, recovery(invocationId), NOW)).rejects.toMatchObject({
      code,
    });
  });

  it('admits the future-skew boundary without creating backwards phase deadlines', async () => {
    const f = await setup();
    const job = await running(f, { invocationId: invocation(1, NOW + BROWSER_CLOCK_SKEW_MS) });
    expect(job.status).toBe('running');
    expect(Date.parse(job.deadlines.execution!)).toBe(NOW + BROWSER_EXECUTION_TIMEOUT_MS);
    expect(job.expiresAt).toBe(
      new Date(NOW + BROWSER_CLOCK_SKEW_MS + BROWSER_RETENTION_MS).toISOString()
    );
  });

  it('counts multibyte goals and escaped result serialization before changing durable state', async () => {
    const f = await setup();
    const accepted = await admit(f, 1, { goal: 'é'.repeat(8192) });
    const before = f.fake.snapshot();
    await expect(
      f.store.invoke(f.cli, request(2, { goal: `${'é'.repeat(8192)}a` }), NOW)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.fake.snapshot()).toEqual(before);
    const active = await approve(f, await dispatch(f));
    const result = success(active, { summary: '\u0000'.repeat(16_000) });
    const runningState = f.fake.snapshot();
    await expect(
      f.store.updateProvider(f.panel, resultMessage(active, result), NOW)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.fake.snapshot()).toEqual(runningState);
    expect(await status(f, accepted)).toMatchObject({ status: 'running' });
  });

  it('stores a complete 64 KiB result and rejects a one-byte overflow without truncation', async () => {
    const f = await setup();
    const job = await running(f);
    const result = success(job, {
      summary: 'x'.repeat(32768),
      evidence: [
        { text: 'x'.repeat(8192) },
        { text: 'x'.repeat(8192) },
        { text: 'x'.repeat(8192) },
        { text: '' },
      ],
    });
    const last = result.evidence[3];
    if (!last) throw new Error('Missing evidence fixture');
    last.text = 'x'.repeat(65536 - new TextEncoder().encode(JSON.stringify(result)).byteLength);
    const overflow = { ...result, summary: `${result.summary.slice(1)}é` };
    const before = f.fake.snapshot();
    await expect(
      f.store.updateProvider(f.panel, resultMessage(job, overflow), NOW)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.fake.snapshot()).toEqual(before);
    await f.store.updateProvider(f.panel, resultMessage(job, result), NOW);
    expect((await status(f, job))?.result).toEqual(result);
    expect(
      (await createBrowserJobStore(f.fake.storage).lookup(f.cli, recovery(job.invocationId), NOW))
        .value?.result
    ).toEqual(result);
  });

  it('checks the complete durable record, not only independently valid goal and result fields', async () => {
    const f = await setup();
    await admit(f, 1, { goal: '\u0000'.repeat(16_384) });
    const awaitingApproval = await dispatch(f);
    const before = f.fake.snapshot();
    await expect(
      approve(f, awaitingApproval, NOW, {
        ...TAB,
        url: `https://example.com/?${'\u0000'.repeat(8_000)}`,
      })
    ).rejects.toMatchObject({ code: 'capacity_exceeded' });
    expect(f.fake.snapshot()).toEqual(before);
    const job = await approve(f, awaitingApproval);
    const result = success(job, {
      summary: 'x'.repeat(32_768),
      evidence: [{ text: 'y'.repeat(8192) }],
    });
    expect(browserResultSchema.safeParse(result).success).toBe(true);
    await f.store.updateProvider(f.panel, resultMessage(job, result), NOW);
    expect(await status(f, job)).toMatchObject({ status: 'succeeded', result });
    expectBoundedRecords(f);
  });

  it('caps concurrent queue admission at 100 while preserving the separate active slot and every accepted job', async () => {
    const f = await setup();
    const active = await running(f);
    const outcomes = await Promise.allSettled(
      Array.from({ length: BROWSER_MAX_QUEUED + 1 }, (_, n) => admit(f, n + 2))
    );
    const accepted = outcomes.flatMap(outcome =>
      outcome.status === 'fulfilled' ? [outcome.value] : []
    );
    expect(accepted).toHaveLength(100);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(f.fake.entries('browser/job/')).toHaveLength(101);
    for (const job of [active, ...accepted])
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
        snapshot: { jobId: job.jobId },
      });
    expect((await f.store.invoke(f.cli, request(), NOW)).value).toEqual({
      job: active,
      duplicate: true,
    });
  });

  it('caps concurrent retained admission at 1000 without evicting accepted records or blocking exact retries', async () => {
    const f = await setup();
    for (let n = 2; n <= 11; n++)
      await f.store.registerProvider(socket('web', `panel-${n}`), registration(n), NOW);
    const jobs = await Promise.all(
      Array.from({ length: BROWSER_MAX_JOBS }, (_, n) =>
        admit(f, n + 1, { providerId: registration(Math.floor(n / 100) + 1).providerId })
      )
    );
    const before = f.fake.snapshot();
    await expect(admit(f, 1001, { providerId: registration(11).providerId })).rejects.toMatchObject(
      { code: 'capacity_exceeded' }
    );
    expect(f.fake.snapshot()).toEqual(before);
    expect(new Set(jobs.map(job => job.jobId)).size).toBe(1000);
    for (const job of jobs)
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
        snapshot: { jobId: job.jobId },
      });
    expect((await f.store.invoke(f.cli, request(), NOW)).value.duplicate).toBe(true);
    await f.store.expire(NOW + BROWSER_RETENTION_MS);
    expect((await f.store.cleanup(NOW + BROWSER_RETENTION_MS)).value).toBe(1000);
    expect(f.fake.entries('browser/job/')).toEqual([]);
    expect(f.fake.get('browser/meta')).toMatchObject({ jobs: 0, providers: 0 });
  }, 20_000);

  it.each(['queued', 'awaiting_approval', 'running'] as const)(
    'settles near-expiry %s work before cleanup and never loses its unresolved fence',
    async state => {
      const f = await setup();
      const encoded = invocation(1, NOW - BROWSER_RETENTION_MS + 1_000);
      let job = await admit(f, 1, { invocationId: encoded });
      if (state !== 'queued') job = await dispatch(f);
      if (state === 'running') job = await approve(f, job);
      for (const at of Object.values(job.deadlines))
        expect(Date.parse(at!)).toBeLessThanOrEqual(NOW + 1_000);
      expect((await f.store.cleanup(NOW + 1_000)).value).toBe(0);
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: { status: state } });
      const expired = await f.store.expire(NOW + 1_000);
      expect(expired.effects.updates[0]?.job).toMatchObject({
        status: 'timed_out',
        result: { reason: 'invocation_expired' },
      });
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
        snapshot: { status: 'timed_out', result: { reason: 'invocation_expired' } },
      });
      if (state !== 'queued')
        expect(expired.effects.cancellations[0]?.message.invocationId).toBe(encoded);
      expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
      expect(f.fake.get(`browser/job/${job.jobId}`)).toBeUndefined();
      const restarted = createBrowserJobStore(f.fake.storage);
      await expect(restarted.lookup(f.cli, recovery(encoded), NOW + 1_000)).rejects.toMatchObject({
        code: 'invocation_expired',
      });
      await expect(
        restarted.invoke(f.cli, request(1, { invocationId: encoded }), NOW + 1_000)
      ).rejects.toMatchObject({ code: 'invocation_expired' });
      if (state !== 'queued') {
        expect((await restarted.pendingCancellations())[0]?.message.invocationId).toBe(encoded);
        expect((await restarted.dispatch(job.providerId, NOW + 1_000)).value).toBeNull();
        expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 0, fences: 1 });
        await expect(
          restarted.registerProvider(
            socket('web'),
            registration(1, { generation: job.generation }),
            NOW + 1_000
          )
        ).rejects.toMatchObject({ code: 'provider_unavailable' });
        const recovered = await restarted.registerProvider(
          socket('web'),
          registration(1, {
            generation: job.generation,
            recovery: {
              invocationId: encoded,
              tabId: TAB.tabId,
              tabClosed: true,
              locksDrained: true,
            },
          }),
          NOW + 1_000
        );
        expect(recovered.value.generation).toBeGreaterThan(job.generation);
        expect(await restarted.pendingCancellations()).toEqual([]);
        expect(f.fake.entries('browser/owner/')).toEqual([]);
        expect(f.fake.entries('browser/capability/')).toEqual([]);
      }
    }
  );

  it('retains settled results until encoded expiry and never changes a terminal result during expiry', async () => {
    const f = await setup();
    const job = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.updateProvider(f.panel, resultMessage(job), NOW);
    const settled = await status(f, job);
    expect((await f.store.cleanup(NOW + 999)).value).toBe(0);
    await f.store.expire(NOW + 1_000);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: settled });
    expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
    expect((await f.store.dispatch(job.providerId, NOW + 1_000)).value).toBeNull();
    await f.store.updateProvider(f.panel, quiesced(job), NOW + 1_000);
    expect(f.fake.get(`browser/provider/${job.providerId}`)).toBeUndefined();
  });

  it('lets exact quiescence clear a fence after its expired job is deleted', async () => {
    const f = await setup();
    const job = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.expire(NOW + 1_000);
    await f.store.cleanup(NOW + 1_000);
    const restarted = createBrowserJobStore(f.fake.storage);
    await expect(
      restarted.updateProvider(socket('web'), quiesced(job), NOW + 1_001)
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    await restarted.updateProvider(f.panel, quiesced(job), NOW + 1_001);
    expect(await restarted.pendingCancellations()).toEqual([]);
    expect(f.fake.entries('browser/provider/')).toEqual([]);
    expect(f.fake.entries('browser/provider-proof/')).toEqual([]);
    expect(f.fake.entries('browser/owner/')).toEqual([]);
  });

  it('rejects expired continuation without creating a fresh conversation', async () => {
    const f = await setup();
    const first = await admit(f, 1, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1),
    });
    await f.store.expire(NOW + 1);
    await f.store.cleanup(NOW + 1);
    const before = f.fake.snapshot();
    await expect(
      f.store.invoke(f.cli, request(2, { browserTaskId: first.browserTaskId }), NOW + 1)
    ).rejects.toMatchObject({ code: 'invocation_expired' });
    await expect(f.store.lookup(f.cli, ownedLookup(first), NOW + 1)).rejects.toMatchObject({
      code: 'invocation_expired',
    });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('preserves a retained parent binding until both its job references and fences disappear', async () => {
    const f = await setup();
    const first = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.expire(NOW + 1_000);
    await f.store.cleanup(NOW + 1_000);
    const before = f.fake.snapshot();
    await expect(
      f.store.invoke(
        f.cli,
        request(2, { owner: { ...OWNER, parentProof: 'b'.repeat(64) } }),
        NOW + 1_000
      )
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(f.fake.snapshot()).toEqual(before);
    await f.store.updateProvider(f.panel, quiesced(first), NOW + 1_001);
    const panel = socket('web');
    await f.store.registerProvider(
      panel,
      registration(1, { generation: first.generation }),
      NOW + 1_001
    );
    const newJob = await f.store.invoke(
      f.cli,
      request(2, { owner: { ...OWNER, parentProof: 'b'.repeat(64) } }),
      NOW + 1_001
    );
    expect(newJob.value.duplicate).toBe(false);
    expect(newJob.value.job.browserTaskId).not.toBe(first.browserTaskId);
  });

  it('retains all 32 compact fences after result cleanup and refuses a 33rd provider without eviction', async () => {
    const f = await setup();
    const jobs: BrowserJobSnapshot[] = [];
    const panels: ReturnType<typeof socket>[] = [];
    for (let n = 1; n <= BROWSER_MAX_PROVIDERS; n++) {
      const panel = n === 1 ? f.panel : socket('web', `panel-${n}`);
      panels.push(panel);
      if (n > 1) await f.store.registerProvider(panel, registration(n), NOW);
      const job = await admit(f, n, {
        providerId: registration(n).providerId,
        invocationId: invocation(n, NOW - BROWSER_RETENTION_MS + 1_000),
      });
      const active = (await f.store.dispatch(job.providerId, NOW)).value?.message.job;
      if (!active) throw new Error('Missing dispatch');
      jobs.push(active);
    }
    await f.store.expire(NOW + 1_000);
    await f.store.cleanup(NOW + 1_000);
    expect(f.fake.entries('browser/job/')).toEqual([]);
    expect(await f.store.pendingCancellations()).toHaveLength(32);
    const before = f.fake.snapshot();
    await expect(
      f.store.registerProvider(socket('web'), registration(33), NOW + 1_000)
    ).rejects.toMatchObject({ code: 'capacity_exceeded' });
    expect(f.fake.snapshot()).toEqual(before);
    const first = jobs[0];
    const firstPanel = panels[0];
    if (!first || !firstPanel) throw new Error('Missing first fence');
    await f.store.updateProvider(firstPanel, quiesced(first), NOW + 1_001);
    await f.store.registerProvider(socket('web'), registration(33), NOW + 1_001);
    expect(f.fake.entries('browser/provider/')).toHaveLength(32);
    expect(await f.store.pendingCancellations()).toHaveLength(31);
  });
});

describe('browser provider historical status', () => {
  function historyRequest(
    n = 1
  ): Extract<BrowserProviderOutboundMessage, { type: 'provider_status' }> {
    const { requestId, providerId, providerProof } = registration(n);
    return { type: 'provider_status', requestId, providerId, providerProof };
  }

  it.each([
    { status: 'succeeded', reason: 'completed' },
    { status: 'failed', reason: 'runner_failed' },
    { status: 'cancelled', reason: 'cancelled' },
    { status: 'interrupted', reason: 'provider_lost' },
    { status: 'timed_out', reason: 'execution_timeout' },
  ] as const)(
    'returns the original $status result across generations after restart',
    async terminal => {
      const f = await setup();
      const job = await running(f);
      const result: BrowserResult = { ...success(job), ...terminal };
      const settled = (await f.store.updateProvider(f.panel, resultMessage(job, result), NOW)).value
        .job;
      const jobKey = `browser/job/${job.jobId}`;
      const legacy = f.fake.get(jobKey) as Record<string, unknown>;
      delete legacy.conversationMode;
      f.fake.seed(jobKey, legacy);
      await f.store.updateProvider(f.panel, quiesced(job), NOW);
      const panel = socket('web', 'new-panel');
      const grant = (await f.store.registerProvider(panel, registration(), NOW)).value;
      const current = await admit(f, 2);
      expect(grant.generation).toBeGreaterThan(job.generation);
      const execution = await heartbeat(f, NOW, grant.providerId, grant.generation, panel);
      expect(execution.value.snapshot?.jobs).toEqual([current]);
      const reader = socket('web', 'history-only');
      const attachment = reader.deserializeAttachment();
      const before = f.fake.snapshot();
      const input = { ...historyRequest(), requestId: uuid(912) };
      const page = await createBrowserJobStore(f.fake.storage).providerStatus(
        reader,
        input,
        NOW + 1
      );
      expect(page).toMatchObject({
        type: 'provider_status_result',
        requestId: input.requestId,
        providerId: job.providerId,
      });
      expect(page.jobs).toHaveLength(2);
      expect(page.jobs.find(retained => retained.jobId === job.jobId)).toEqual(settled);
      expect(page.jobs.find(retained => retained.jobId === job.jobId)?.result).toEqual(result);
      expect(page.jobs.find(retained => retained.jobId === current.jobId)).toEqual(current);
      expect(browserProviderInboundMessageSchema.safeParse(page).success).toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/digest|socketId|parentProof|providerProof/);
      expect(f.fake.snapshot()).toEqual(before);
      expect(reader.deserializeAttachment()).toEqual(attachment);
    }
  );

  it('returns fenced interruption history when reconnect registration cannot succeed', async () => {
    const f = await setup();
    const active = await running(f);
    await admit(f, 2);
    const interrupted = await f.store.disconnectProvider(f.panel, NOW);
    const restarted = createBrowserJobStore(f.fake.storage);
    const reader = socket('web', 'reconnected');
    const input = registration(1, { generation: active.generation });
    await expect(restarted.registerProvider(reader, input, NOW + 1)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    const before = f.fake.snapshot();
    const attachment = reader.deserializeAttachment();
    const page = await restarted.providerStatus(reader, historyRequest(), NOW + 1);
    expect(page.jobs).toHaveLength(2);
    expect(page.jobs).toEqual(
      expect.arrayContaining(interrupted.effects.updates.map(update => update.job))
    );
    expect(page.jobs.find(job => job.jobId === active.jobId)).toMatchObject({
      generation: active.generation,
      status: 'interrupted',
      result: { reason: 'provider_lost', effectsUncertain: true },
    });
    expect(await restarted.providerStatus(reader, historyRequest(), NOW + 2)).toEqual(page);
    expect(reader.deserializeAttachment()).toEqual(attachment);
    expect(f.fake.snapshot()).toEqual(before);
    await expect(restarted.registerProvider(reader, input, NOW + 2)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect((await restarted.dispatch(active.providerId, NOW + 2)).value).toBeNull();
    expect(f.fake.snapshot()).toEqual(before);
  });

  it.each(['queued', 'awaiting_approval', 'running'] as const)(
    'reads retained %s work without renewing or expiring execution authority',
    async state => {
      const f = await setup();
      let job = await admit(f);
      if (state !== 'queued') job = await dispatch(f);
      if (state === 'running') job = await approve(f, job);
      const execution = await heartbeat(f, NOW);
      expect(execution.value.snapshot?.jobs).toEqual([job]);
      expect(execution.value.snapshot).not.toHaveProperty('unresolvedFence');
      const reader = socket('web');
      const attachment = reader.deserializeAttachment();
      const before = f.fake.snapshot();
      const page = await f.store.providerStatus(
        reader,
        historyRequest(),
        NOW + BROWSER_EXECUTION_TIMEOUT_MS + 1
      );
      expect(page.jobs).toEqual([job]);
      if (state === 'queued') expect(page).not.toHaveProperty('unresolvedFence');
      else
        expect(page.unresolvedFence).toStrictEqual(
          state === 'running'
            ? { invocationId: job.invocationId, tabId: TAB.tabId }
            : { invocationId: job.invocationId }
        );
      expect(reader.deserializeAttachment()).toEqual(attachment);
      expect(f.fake.snapshot()).toEqual(before);
    }
  );

  it.each(['wrong proof', 'other provider', 'wrong user', 'CLI role', 'missing identity'] as const)(
    'denies fence discovery for a %s before and after job cleanup',
    async variant => {
      const f = await setup();
      await running(f);
      await f.store.registerProvider(socket('web', 'other-panel'), registration(2), NOW);
      await admit(f, 2, { providerId: registration(2).providerId });
      await dispatch(f, registration(2).providerId);
      const reader = socket(
        variant === 'CLI role' ? 'cli' : 'web',
        'web',
        variant === 'wrong user' ? 'user_2' : 'user_1'
      );
      if (variant === 'missing identity')
        reader.serializeAttachment({ role: 'web', connectionId: 'web' });
      const input = {
        ...historyRequest(),
        ...(variant === 'wrong proof' ? { providerProof: 'b'.repeat(64) } : {}),
        ...(variant === 'other provider' ? { providerId: registration(2).providerId } : {}),
      };
      const attachment = reader.deserializeAttachment();
      for (const now of [NOW, NOW + BROWSER_RETENTION_MS]) {
        if (now !== NOW) {
          await f.store.expire(now);
          expect((await f.store.cleanup(now)).value).toBe(2);
          expect(f.fake.entries('browser/job/')).toEqual([]);
        }
        const before = f.fake.snapshot();
        await expect(f.store.providerStatus(reader, input, now)).rejects.toMatchObject({
          code: variant === 'missing identity' ? 'invalid_request' : 'owner_mismatch',
          retryable: false,
        });
        expect(f.fake.snapshot()).toEqual(before);
        expect(reader.deserializeAttachment()).toEqual(attachment);
      }
    }
  );

  it.each([
    'provider user',
    'provider ID',
    'missing proof binding',
    'other proof binding',
  ] as const)('rejects an inconsistent stored %s', async variant => {
    const f = await setup();
    await admit(f);
    const providerKey = `browser/provider/${f.grant.providerId}`;
    const provider = f.fake.get(providerKey) as { digest: string };
    if (variant === 'provider user')
      f.fake.seed(providerKey, { ...provider, kiloUserId: 'user_2' });
    else if (variant === 'provider ID')
      f.fake.seed(providerKey, { ...provider, providerId: registration(2).providerId });
    else
      f.fake.seed(
        `browser/provider-proof/${provider.digest}`,
        variant === 'missing proof binding' ? undefined : registration(2).providerId
      );
    const before = f.fake.snapshot();
    await expect(
      f.store.providerStatus(socket('web'), historyRequest(), NOW)
    ).rejects.toMatchObject({
      code: 'owner_mismatch',
    });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('keeps read-only requests out of mutation methods and mutation requests out of status', async () => {
    const f = await setup();
    await running(f);
    const reader = socket('web');
    const attachment = reader.deserializeAttachment();
    const before = f.fake.snapshot();
    await expect(f.store.updateProvider(reader, historyRequest(), NOW)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(f.store.providerStatus(reader, registration(), NOW)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.fake.snapshot()).toEqual(before);
    expect(reader.deserializeAttachment()).toEqual(attachment);
  });

  it.each([{ cursor: 'invalid' }, { providerProof: undefined }, { generation: 1 }])(
    'rejects malformed history requests before storage access: %j',
    async changes => {
      const f = await setup();
      const before = f.fake.snapshot();
      f.fake.rejectReads();
      await expect(
        f.store.providerStatus(socket('web'), { ...historyRequest(), ...changes }, NOW)
      ).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(f.fake.snapshot()).toEqual(before);
    }
  );

  it('does not allocate a provider, owner, or socket binding for unknown history', async () => {
    const fake = transactionalStorage();
    const reader = socket('web');
    const attachment = reader.deserializeAttachment();
    await expect(
      createBrowserJobStore(fake.storage).providerStatus(reader, historyRequest(), NOW)
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.snapshot()).toEqual([]);
    expect(reader.deserializeAttachment()).toEqual(attachment);
  });

  it('returns an empty authorized page without allocating an owner or renewing a lease', async () => {
    const f = await setup();
    const before = f.fake.snapshot();
    expect(
      await f.store.providerStatus(socket('web'), historyRequest(), NOW + BROWSER_LEASE_MS)
    ).toEqual({
      type: 'provider_status_result',
      requestId: historyRequest().requestId,
      providerId: f.grant.providerId,
      jobs: [],
    });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('paginates across generations with the same fence without leaking another provider or skipping jobs', async () => {
    const f = await setup();
    const ids: string[] = [];
    for (let n = 1; n <= 26; n++) {
      if (n === 14) await f.store.registerProvider(f.panel, registration(), NOW);
      ids.push((await admit(f, n)).jobId);
    }
    const active = await approve(f, await dispatch(f));
    await f.store.registerProvider(socket('web', 'other-panel'), registration(2), NOW);
    await admit(f, 27, { providerId: registration(2).providerId });
    const other = await dispatch(f, registration(2).providerId);
    const before = f.fake.snapshot();
    const reader = socket('web', 'history-only');
    const first = await f.store.providerStatus(reader, historyRequest(), NOW);
    expect(first.jobs).toHaveLength(25);
    expect(first.nextCursor).toBeDefined();
    const last = await f.store.providerStatus(
      reader,
      { ...historyRequest(), cursor: first.nextCursor },
      NOW
    );
    expect(last.jobs).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect([...first.jobs, ...last.jobs].map(job => job.jobId)).toEqual(ids.sort());
    const empty = await f.store.providerStatus(
      reader,
      { ...historyRequest(), cursor: ids.at(-1) },
      NOW
    );
    expect(empty.jobs).toEqual([]);
    expect(empty.nextCursor).toBeUndefined();
    for (const page of [first, last, empty]) {
      expect(page.unresolvedFence).toStrictEqual({
        invocationId: active.invocationId,
        tabId: TAB.tabId,
      });
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(128 * 1024);
    }
    expect(await f.store.providerStatus(reader, historyRequest(2), NOW)).toStrictEqual({
      type: 'provider_status_result',
      requestId: historyRequest(2).requestId,
      providerId: other.providerId,
      jobs: [other],
      unresolvedFence: { invocationId: other.invocationId },
    });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('counts the retained fence in near-limit history pages without truncating results', async () => {
    const f = await setup();
    const jobs: BrowserJobSnapshot[] = [];
    for (let n = 1; n <= 4; n++) {
      await admit(f, n);
      const job = await approve(f, await dispatch(f));
      const result = success(job, {
        summary: 'é'.repeat(16_384),
        evidence: [{ text: '\u0000'.repeat(4096) }, { text: '' }],
      });
      const snapshot = { ...job, status: result.status, result };
      const pageWithoutFence = {
        type: 'provider_status_result',
        requestId: historyRequest().requestId,
        providerId: job.providerId,
        jobs: [snapshot, snapshot],
        nextCursor: job.jobId,
      };
      const padding = result.evidence[1];
      if (!padding) throw new Error('Missing evidence fixture');
      // Two results fit without the fence, but the compact identity exceeds the remaining 100 bytes.
      padding.text = 'x'.repeat(
        Math.floor(
          (128 * 1024 -
            100 -
            new TextEncoder().encode(JSON.stringify(pageWithoutFence)).byteLength) /
            2
        )
      );
      const settled = (await f.store.updateProvider(f.panel, resultMessage(job, result), NOW)).value
        .job;
      if (!settled) throw new Error('Missing retained result');
      jobs.push(settled);
      if (n < 4) await f.store.updateProvider(f.panel, quiesced(job), NOW);
    }
    const before = f.fake.snapshot();
    const collected: BrowserJobSnapshot[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 4; n++) {
      const page = await f.store.providerStatus(
        socket('web'),
        { ...historyRequest(), cursor },
        NOW
      );
      expect(page.jobs).toHaveLength(1);
      expect(page.unresolvedFence).toStrictEqual({ invocationId: invocation(4), tabId: TAB.tabId });
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(128 * 1024);
      expect(browserProviderInboundMessageSchema.safeParse(page).success).toBe(true);
      collected.push(...page.jobs);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(collected.map(job => job.jobId)).toEqual(jobs.map(job => job.jobId).sort());
    expect(collected).toEqual(expect.arrayContaining(jobs));
    expect(f.fake.snapshot()).toEqual(before);
  });

  it.each([undefined, 0, TAB.tabId])(
    'retains only the compact fence with tab %s through job expiry and cleanup',
    async tabId => {
      const f = await setup();
      await admit(f, 1, { invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000) });
      let job = await dispatch(f);
      if (tabId !== undefined) {
        job = await approve(f, job, NOW, { ...TAB, tabId });
        await f.store.updateProvider(f.panel, resultMessage(job), NOW);
      }
      const fence =
        tabId === undefined
          ? { invocationId: job.invocationId }
          : { invocationId: job.invocationId, tabId };
      const reader = socket('web');
      const attachment = reader.deserializeAttachment();
      const before = f.fake.snapshot();
      const retained = await f.store.providerStatus(reader, historyRequest(), NOW + 999);
      expect(retained.jobs).toMatchObject([
        tabId === undefined ? job : { ...job, status: 'succeeded', result: success(job) },
      ]);
      expect(retained.unresolvedFence).toStrictEqual(fence);
      const expired = await f.store.providerStatus(reader, historyRequest(), NOW + 1_000);
      expect(expired).toStrictEqual({
        type: 'provider_status_result',
        requestId: historyRequest().requestId,
        providerId: job.providerId,
        jobs: [],
        unresolvedFence: fence,
      });
      expect(f.fake.snapshot()).toEqual(before);
      await f.store.expire(NOW + 1_000);
      expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
      expect(f.fake.entries('browser/job/')).toEqual([]);
      expect(f.fake.entries('browser/invocation/')).toEqual([]);
      const cleaned = f.fake.snapshot();
      const restarted = createBrowserJobStore(f.fake.storage);
      expect(await restarted.providerStatus(reader, historyRequest(), NOW + 1_001)).toStrictEqual(
        expired
      );
      expect(f.fake.snapshot()).toEqual(cleaned);
      expect(reader.deserializeAttachment()).toEqual(attachment);
    }
  );

  it.each([
    ['pre-approval', undefined],
    ['approved tab zero', 0],
    ['approved tab', TAB.tabId],
  ] as const)(
    'recovers an expired %s fence only with its discovered identity and explicit safety proof',
    async (_state, tabId) => {
      const f = await setup();
      await admit(f, 1, {
        invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
      });
      let active = await dispatch(f);
      if (tabId !== undefined) {
        active = await approve(f, active, NOW, { ...TAB, tabId });
        await f.store.updateProvider(f.panel, resultMessage(active), NOW);
      }
      const queued = await admit(f, 2);
      await f.store.expire(NOW + 1_000);
      expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
      expect(f.fake.get(`browser/job/${active.jobId}`)).toBeUndefined();
      expect(f.fake.get(`browser/invocation/${active.invocationId}`)).toBeUndefined();
      const restarted = createBrowserJobStore(f.fake.storage);
      const reader = socket('web', 'reconnected');
      const attachment = reader.deserializeAttachment();
      const before = f.fake.snapshot();
      const cancellations = await restarted.pendingCancellations();
      const page = await restarted.providerStatus(reader, historyRequest(), NOW + 1_001);
      expect(page.unresolvedFence).toStrictEqual(
        tabId === undefined
          ? { invocationId: active.invocationId }
          : { invocationId: active.invocationId, tabId }
      );
      expect(page.jobs).toMatchObject([
        { jobId: queued.jobId, status: 'interrupted', result: { reason: 'provider_unavailable' } },
      ]);
      expect(f.fake.snapshot()).toEqual(before);
      expect(reader.deserializeAttachment()).toEqual(attachment);
      expect(await restarted.pendingCancellations()).toEqual(cancellations);
      expect((await restarted.deadlines()).lease).toBeNull();
      expect((await restarted.dispatch(active.providerId, NOW + 1_001)).value).toBeNull();
      await expect(
        restarted.updateProvider(reader, quiesced(active), NOW + 1_001)
      ).rejects.toMatchObject({ code: 'owner_mismatch' });
      await expect(
        restarted.registerProvider(reader, registration(), NOW + 1_001)
      ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });

      const fence = page.unresolvedFence;
      if (!fence) throw new Error('Missing recovery identity');
      const safetyProof = { ...fence, tabClosed: true, locksDrained: true } as const;
      for (const [recoveryFields, code] of [
        [{ ...safetyProof, invocationId: invocation(99) }, 'provider_unavailable'],
        [{ ...safetyProof, invocationId: undefined }, 'invalid_request'],
        [{ ...safetyProof, tabClosed: undefined }, 'invalid_request'],
        [{ ...safetyProof, locksDrained: undefined }, 'invalid_request'],
        [{ ...safetyProof, tabClosed: false }, 'invalid_request'],
        [{ ...safetyProof, locksDrained: false }, 'invalid_request'],
      ] as const) {
        await expect(
          restarted.registerProvider(
            reader,
            { ...registration(), recovery: recoveryFields },
            NOW + 1_001
          )
        ).rejects.toMatchObject({ code, retryable: code === 'provider_unavailable' });
        expect(f.fake.snapshot()).toEqual(before);
      }
      if (fence.tabId !== undefined) {
        for (const suppliedTabId of [undefined, fence.tabId + 1]) {
          await expect(
            restarted.registerProvider(
              reader,
              registration(1, { recovery: { ...safetyProof, tabId: suppliedTabId } }),
              NOW + 1_001
            )
          ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
          expect(f.fake.snapshot()).toEqual(before);
        }
      }
      for (const variant of ['wrong proof', 'wrong user'] as const) {
        await expect(
          restarted.registerProvider(
            variant === 'wrong user' ? socket('web', 'reconnected', 'user_2') : reader,
            registration(1, {
              recovery: safetyProof,
              ...(variant === 'wrong proof' ? { providerProof: 'b'.repeat(64) } : {}),
            }),
            NOW + 1_001
          )
        ).rejects.toMatchObject({ code: 'owner_mismatch', retryable: false });
        expect(f.fake.snapshot()).toEqual(before);
      }
      const recovered = await restarted.registerProvider(
        reader,
        registration(1, { recovery: safetyProof }),
        NOW + 1_001
      );
      expect(recovered.value.generation).toBeGreaterThan(active.generation);
      expect(await restarted.pendingCancellations()).toEqual([]);
      expect(await restarted.dispatch(active.providerId, NOW + 1_001)).toEqual({
        value: null,
        effects: { updates: [], cancellations: [] },
      });
      expect(f.fake.get(`browser/job/${queued.jobId}`)).toMatchObject({
        snapshot: { status: 'interrupted' },
      });
      expect(f.fake.get(`browser/job/${queued.jobId}`)).not.toHaveProperty('dispatch');
      const recoveredPage = await restarted.providerStatus(reader, historyRequest(), NOW + 1_001);
      expect(recoveredPage.jobs).toEqual(page.jobs);
      expect(recoveredPage).not.toHaveProperty('unresolvedFence');
      for (const input of [recovery(active.invocationId), ownedLookup(active)]) {
        await expect(restarted.lookup(f.cli, input, NOW + 1_001)).rejects.toMatchObject({
          code: 'invocation_expired',
          retryable: false,
        });
      }
      await expect(
        restarted.invoke(f.cli, request(1, { invocationId: active.invocationId }), NOW + 1_001)
      ).rejects.toMatchObject({ code: 'invocation_expired', retryable: false });
      await expect(
        restarted.updateProvider(
          reader,
          {
            type: 'provider_approval',
            ...binding(active),
            approval: { decision: 'approved', tab: TAB },
          },
          NOW + 1_001
        )
      ).rejects.toMatchObject({ code: 'owner_mismatch', retryable: false });
      expect(f.fake.get(`browser/job/${active.jobId}`)).toBeUndefined();
      expect(f.fake.get(`browser/invocation/${active.invocationId}`)).toBeUndefined();

      const next = (await restarted.invoke(f.cli, request(3), NOW + 1_002)).value.job;
      const current = { ...f, store: restarted, panel: reader };
      const awaitingApproval = await dispatch(current, next.providerId, NOW + 1_002);
      expect(awaitingApproval).toMatchObject({
        jobId: next.jobId,
        generation: recovered.value.generation,
        status: 'awaiting_approval',
      });
      expect(awaitingApproval).not.toHaveProperty('approvedTab');
      await expect(
        restarted.updateProvider(reader, resultMessage(awaitingApproval), NOW + 1_002)
      ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
      expect(await approve(current, awaitingApproval, NOW + 1_002)).toMatchObject({
        status: 'running',
        approvedTab: TAB,
      });
    }
  );

  it('fails closed when a retained job belongs to another provider', async () => {
    const f = await setup();
    const job = await admit(f);
    const jobKey = `browser/job/${job.jobId}`;
    const stored = f.fake.get(jobKey) as Record<string, unknown>;
    f.fake.seed(jobKey, {
      ...stored,
      snapshot: { ...job, providerId: registration(2).providerId },
    });
    const before = f.fake.snapshot();
    await expect(
      f.store.providerStatus(socket('web'), historyRequest(), NOW)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.fake.snapshot()).toEqual(before);
  });
});

describe('browser job deadlines and read-only recovery', () => {
  it('returns empty deadlines and empty discovery without allocating a provider or job', async () => {
    const fake = transactionalStorage();
    const store = createBrowserJobStore(fake.storage);
    expect(await store.deadlines()).toEqual({
      queue: null,
      approval: null,
      execution: null,
      lease: null,
      retention: null,
      next: null,
    });
    expect(
      await store.listProviders(
        socket('cli'),
        { type: 'browser_request', operation: 'list', requestId: uuid(1) },
        NOW
      )
    ).toEqual({ providers: [] });
    expect(fake.snapshot()).toEqual([]);
  });

  it('returns the earliest queue, approval, execution, lease, and retention deadlines across profiles', async () => {
    const f = await setup();
    const queued = await admit(f);
    const approvalPanel = socket('web', 'approval');
    const executionPanel = socket('web', 'execution');
    await f.store.registerProvider(approvalPanel, registration(2), NOW);
    await f.store.registerProvider(executionPanel, registration(3), NOW);
    const approval = await admit(f, 2, { providerId: registration(2).providerId });
    const execution = await admit(f, 3, { providerId: registration(3).providerId });
    await f.store.dispatch(approval.providerId, NOW + 1_000);
    await f.store.dispatch(execution.providerId, NOW + 2_000);
    await f.store.updateProvider(
      executionPanel,
      {
        type: 'provider_approval',
        ...binding(execution),
        approval: { decision: 'approved', tab: TAB },
      },
      NOW + 3_000
    );
    expect(await f.store.deadlines()).toEqual({
      queue: Date.parse(queued.deadlines.queue),
      approval: NOW + 1_000 + BROWSER_APPROVAL_TIMEOUT_MS,
      execution: NOW + 3_000 + BROWSER_EXECUTION_TIMEOUT_MS,
      lease: NOW + BROWSER_LEASE_MS,
      retention: NOW + BROWSER_RETENTION_MS,
      next: NOW + BROWSER_LEASE_MS,
    });
  });

  it.each(['queue', 'approval', 'execution', 'lease'] as const)(
    'settles the %s deadline with its distinct terminal reason',
    async phase => {
      const f = await setup();
      let job = await admit(f);
      if (phase !== 'queue') job = await dispatch(f);
      if (phase === 'execution' || phase === 'lease') job = await approve(f, job);
      const duration =
        phase === 'queue'
          ? BROWSER_QUEUE_TIMEOUT_MS
          : phase === 'approval'
            ? BROWSER_APPROVAL_TIMEOUT_MS
            : phase === 'execution'
              ? BROWSER_EXECUTION_TIMEOUT_MS
              : BROWSER_LEASE_MS;
      if (phase !== 'lease') await keepLease(f, NOW + duration);
      const outcome = await f.store.expire(NOW + duration);
      expect(
        outcome.effects.updates.find(update => update.job.jobId === job.jobId)?.job
      ).toMatchObject({
        status: phase === 'lease' ? 'interrupted' : 'timed_out',
        result: { reason: phase === 'lease' ? 'lease_expired' : `${phase}_timeout` },
      });
      expect(f.fake.entries('browser/job/')).toHaveLength(1);
      expect((await f.store.cleanup(NOW + duration)).value).toBe(0);
    }
  );

  it('never renews execution or retention during provider heartbeats or owner recovery', async () => {
    const f = await setup();
    const job = await running(f);
    const before = (f.fake.get(`browser/job/${job.jobId}`) as { dispatch: unknown }).dispatch;
    await heartbeat(f, NOW + 5_000);
    const afterHeartbeat = await status(f, job, NOW + 5_000);
    expect(afterHeartbeat?.deadlines.lease).toBe(
      new Date(NOW + 5_000 + BROWSER_LEASE_MS).toISOString()
    );
    expect(afterHeartbeat?.deadlines.execution).toBe(job.deadlines.execution);
    const recovered = await createBrowserJobStore(f.fake.storage).lookup(
      socket('cli', 'new-cli'),
      recovery(job.invocationId),
      NOW + 10_000
    );
    expect(recovered.value).toEqual(afterHeartbeat);
    expect(recovered.value?.createdAt).toBe(job.createdAt);
    expect(recovered.value?.expiresAt).toBe(job.expiresAt);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ dispatch: before });
  });

  it('rejects a late success at encoded expiry even if the alarm races the provider result', async () => {
    const f = await setup();
    const job = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    const outcomes = await Promise.all([
      f.store.updateProvider(f.panel, resultMessage(job), NOW + 1_000),
      f.store.expire(NOW + 1_000),
    ]);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      snapshot: { status: 'timed_out', result: { reason: 'invocation_expired' } },
    });
    expect(
      outcomes
        .flatMap(outcome => outcome.effects.updates)
        .filter(update => update.job.jobId === job.jobId)
    ).toHaveLength(1);
    expect(await f.store.pendingCancellations()).toHaveLength(1);
  });

  it('does not let an expired lease heartbeat revive a provider or dispatch its queue', async () => {
    const f = await setup();
    const active = await running(f);
    const queued = await admit(f, 2);
    await heartbeat(f, NOW + BROWSER_LEASE_MS);
    expect(await status(f, active, NOW + BROWSER_LEASE_MS)).toMatchObject({
      status: 'interrupted',
      result: { reason: 'lease_expired' },
    });
    expect(await status(f, queued, NOW + BROWSER_LEASE_MS)).toMatchObject({
      status: 'interrupted',
      result: { reason: 'provider_unavailable' },
    });
    expect((await f.store.dispatch(active.providerId, NOW + BROWSER_LEASE_MS)).value).toBeNull();
    expect((await f.store.deadlines()).lease).toBeNull();
  });

  it('paginates discovery without exposing proof or socket authority', async () => {
    const f = await setup();
    for (let n = 2; n <= 26; n++)
      await f.store.registerProvider(socket('web', `panel-${n}`), registration(n), NOW);
    const input: BrowserRequest = {
      type: 'browser_request',
      operation: 'list',
      requestId: uuid(123),
    };
    const first = await f.store.listProviders(f.cli, input, NOW);
    const last = await f.store.listProviders(f.cli, { ...input, cursor: first.nextCursor }, NOW);
    expect(first.providers).toHaveLength(25);
    expect(last.providers).toHaveLength(1);
    expect(
      new Set([...first.providers, ...last.providers].map(provider => provider.providerId)).size
    ).toBe(26);
    expect(JSON.stringify(first)).not.toMatch(/digest|socketId|parentProof|providerProof/);
  });

  it('bounds provider snapshot pages by complete serialized bytes and retains every result', async () => {
    const f = await setup();
    const jobs: BrowserJobSnapshot[] = [];
    for (let n = 1; n <= 4; n++) {
      await admit(f, n);
      const job = await approve(f, await dispatch(f));
      await f.store.updateProvider(
        f.panel,
        resultMessage(
          job,
          success(job, { summary: 'x'.repeat(32768), evidence: [{ text: 'y'.repeat(8192) }] })
        ),
        NOW
      );
      await f.store.updateProvider(f.panel, quiesced(job), NOW);
      jobs.push(job);
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const outcome = await f.store.updateProvider(
        f.panel,
        {
          type: 'provider_heartbeat',
          providerId: f.grant.providerId,
          generation: f.grant.generation,
          requestId: uuid(997),
          cursor,
        },
        NOW
      );
      const snapshot = outcome.value.snapshot;
      if (!snapshot) throw new Error('Missing provider snapshot');
      expect(browserProviderInboundMessageSchema.safeParse(snapshot).success).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(
        128 * 1024
      );
      collected.push(...snapshot.jobs.map(job => job.jobId));
      cursor = snapshot.nextCursor;
    } while (cursor);
    expect(new Set(collected)).toEqual(new Set(jobs.map(job => job.jobId)));
    expect(f.fake.entries('browser/job/')).toHaveLength(4);
  });

  it('fails closed on malformed persisted records without altering legacy or browser state', async () => {
    const f = await setup();
    const job = await admit(f);
    f.fake.seed(`browser/job/${job.jobId}`, { snapshot: { ...job, status: 'succeeded' } });
    const before = f.fake.snapshot();
    await expect(f.store.lookup(f.cli, recovery(job.invocationId), NOW)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.fake.snapshot()).toEqual(before);
  });
});

describe('browser job boundary regressions', () => {
  it('paginates mixed-case provider IDs in storage order without repeating or skipping a provider', async () => {
    const f = await setup();
    const ids: string[] = [f.grant.providerId];
    for (let n = 2; n <= 32; n++) {
      const message = registration(n, {
        providerId: `bp_${n % 2 === 0 ? 'A0000000' : 'a0000000'}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
      });
      await f.store.registerProvider(socket('web', `panel-${n}`), message, NOW);
      ids.push(message.providerId);
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await f.store.listProviders(
        f.cli,
        {
          type: 'browser_request',
          operation: 'list',
          requestId: uuid(123),
          cursor,
        },
        NOW
      );
      collected.push(...result.providers.map(provider => provider.providerId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(collected).toEqual(ids.sort());
  });

  it('rejects a prior generation heartbeat even when it comes from the same proven socket', async () => {
    const f = await setup();
    const current = (
      await f.store.registerProvider(
        f.panel,
        registration(1, { generation: f.grant.generation }),
        NOW
      )
    ).value;
    const before = f.fake.snapshot();
    await expect(heartbeat(f, NOW + 5_000)).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(f.fake.snapshot()).toEqual(before);
    const renewed = await heartbeat(f, NOW + 5_000, current.providerId, current.generation);
    expect(renewed.value.leaseExpiresAt).toBe(current.leaseExpiresAt + 5_000);
  });

  it('expires a retained execution lease after its cancelled result has already been cleaned', async () => {
    const f = await setup();
    await admit(f, 1, { invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000) });
    const job = await dispatch(f);
    const cancelled = await f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW);
    expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
    expect((await f.store.deadlines()).next).toBe(NOW + 1_000);
    await createBrowserJobStore(f.fake.storage).expire(NOW + 1_000);
    expect((await f.store.deadlines()).next).toBeNull();
    expect(await f.store.pendingCancellations()).toEqual(cancelled.effects.cancellations);
    expect((await f.store.dispatch(job.providerId, NOW + 1_000)).value).toBeNull();
  });

  it.each(['parent', 'capability'] as const)(
    'binds a contested %s to only one concurrent admission',
    async contested => {
      const f = await setup();
      const contender =
        contested === 'parent'
          ? { ...OWNER, parentProof: 'b'.repeat(64) }
          : { ...OWNER, parentSessionId: 'ses_fork' };
      const outcomes = await Promise.allSettled([
        f.store.invoke(f.cli, request(), NOW),
        f.store.invoke(socket('cli'), request(2, { owner: contender }), NOW),
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toMatchObject([
        { reason: { code: 'owner_mismatch' } },
      ]);
      expect(f.fake.entries('browser/job/')).toHaveLength(1);
      expect(f.fake.entries('browser/owner/')).toHaveLength(1);
      expect(f.fake.entries('browser/capability/')).toHaveLength(1);
    }
  );

  it.each(['succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out'] as const)(
    'retains the complete first %s result against later results and cancellation',
    async terminalStatus => {
      const f = await setup();
      const job = await running(f);
      const result: BrowserResult =
        terminalStatus === 'succeeded'
          ? success(job)
          : {
              ...success(job),
              status: terminalStatus,
              reason:
                terminalStatus === 'cancelled'
                  ? 'cancelled'
                  : terminalStatus === 'interrupted'
                    ? 'provider_lost'
                    : terminalStatus === 'timed_out'
                      ? 'execution_timeout'
                      : 'runner_failed',
            };
      await f.store.updateProvider(f.panel, resultMessage(job, result), NOW);
      await Promise.all([
        f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW),
        f.store.updateProvider(f.panel, resultMessage(job), NOW),
      ]);
      expect((await status(f, job))?.result).toEqual(result);
      expect((await f.store.dispatch(job.providerId, NOW)).value).toBeNull();
    }
  );

  it('requires durable cancellation intent before cleaning a terminal job with unresolved execution', async () => {
    const f = await setup();
    const job = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.updateProvider(f.panel, resultMessage(job), NOW);
    expect((await f.store.cleanup(NOW + 1_000)).value).toBe(0);
    const expired = await f.store.expire(NOW + 1_000);
    expect(expired.effects.cancellations).toMatchObject([
      { message: { invocationId: job.invocationId, reason: 'invocation_expired' } },
    ]);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      snapshot: { result: success(job) },
    });
    expect((await f.store.cleanup(NOW + 1_000)).value).toBe(1);
    expect(await createBrowserJobStore(f.fake.storage).pendingCancellations()).toEqual(
      expired.effects.cancellations
    );
  });

  it('rejects an expired continuation even when retention cleanup has not run', async () => {
    const f = await setup();
    const job = await admit(f, 1, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW);
    const before = f.fake.snapshot();
    await expect(
      f.store.invoke(f.cli, request(2, { browserTaskId: job.browserTaskId }), NOW + 1_000)
    ).rejects.toMatchObject({ code: 'invocation_expired' });
    expect(f.fake.snapshot()).toEqual(before);
  });

  it('clamps the execution lease grant and alarm deadline to near invocation expiry', async () => {
    const f = await setup();
    const job = await running(f, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    const renewed = await heartbeat(f, NOW + 500);
    expect(renewed.value.leaseExpiresAt).toBe(NOW + 1_000);
    expect(await f.store.deadlines()).toMatchObject({ lease: NOW + 1_000, next: NOW + 1_000 });
    expect((await status(f, job, NOW + 500))?.deadlines.execution).toBe(job.expiresAt);
  });

  it('recovers a maximum-sized retained record on a socket with longer delivery routing', async () => {
    const f = await setup();
    const job = await running(f, { goal: '\u0000'.repeat(16_384) });
    const result = success(job, { summary: '' });
    const stored = f.fake.get(`browser/job/${job.jobId}`) as Record<string, unknown>;
    delete stored.conversationMode;
    const complete = { ...stored, snapshot: { ...job, status: 'succeeded', result } };
    result.summary = 'x'.repeat(
      128 * 1024 - 1 - new TextEncoder().encode(JSON.stringify(complete)).byteLength
    );
    await f.store.updateProvider(f.panel, resultMessage(job, result), NOW);
    // Retained records from before compaction can still fill the whole byte budget.
    f.fake.seed(`browser/job/${job.jobId}`, complete);
    const retained = f.fake.get(`browser/job/${job.jobId}`);
    expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBe(128 * 1024 - 1);
    const recovered = await createBrowserJobStore(f.fake.storage).lookup(
      socket('cli', 'r'.repeat(128)),
      recovery(job.invocationId),
      NOW + 1
    );
    expect(recovered.value?.result).toEqual(result);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toEqual(retained);
  });

  it('omits expired provider results before cleanup without deleting their records during heartbeat', async () => {
    const f = await setup();
    const job = await admit(f, 1, {
      invocationId: invocation(1, NOW - BROWSER_RETENTION_MS + 1_000),
    });
    await f.store.lookup(f.cli, ownedLookup(job, 'cancel'), NOW);
    const page = await heartbeat(f, NOW + 1_000);
    expect(page.value.snapshot?.jobs).toEqual([]);
    expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({
      snapshot: { status: 'cancelled' },
    });
  });
});

describe('browser job settlement capacity', () => {
  it.each([
    ['owner cancellation', 'cancelled', 'cancelled'],
    ['provider cancellation', 'cancelled', 'cancelled'],
    ['execution timeout', 'timed_out', 'execution_timeout'],
    ['lease timeout', 'interrupted', 'lease_expired'],
    ['disconnect', 'interrupted', 'provider_lost'],
    ['encoded expiry', 'timed_out', 'invocation_expired'],
  ] as const)(
    'settles a near-limit running record after %s',
    async (event, terminalStatus, reason) => {
      const f = await setup();
      const createdAt = event === 'encoded expiry' ? NOW - BROWSER_RETENTION_MS + 1_000 : NOW;
      const job = await nearLimitRunning(f, createdAt);
      const expiresAt = Date.parse(job.expiresAt);
      const at =
        event === 'execution timeout'
          ? NOW + BROWSER_EXECUTION_TIMEOUT_MS
          : event === 'lease timeout'
            ? NOW + BROWSER_LEASE_MS
            : event === 'encoded expiry'
              ? expiresAt
              : NOW;
      expectBoundedRecords(f);
      if (event === 'execution timeout') await keepLease(f, at);
      const outcome = await (event === 'owner cancellation'
        ? f.store.lookup(f.cli, ownedLookup(job, 'cancel'), at)
        : event === 'provider cancellation'
          ? f.store.updateProvider(f.panel, { type: 'provider_cancel', ...binding(job) }, at)
          : event === 'disconnect'
            ? f.store.disconnectProvider(f.panel, at)
            : f.store.expire(at));
      const settled = outcome.effects.updates.find(update => update.job.jobId === job.jobId)?.job;
      expect(settled).toMatchObject({
        status: terminalStatus,
        approvedTab: job.approvedTab,
        payloadFingerprint: job.payloadFingerprint,
        result: { status: terminalStatus, reason, effectsUncertain: true },
      });
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: settled });
      expectBoundedRecords(f);

      const restarted = createBrowserJobStore(f.fake.storage);
      if (at < expiresAt) {
        expect(
          (
            await restarted.lookup(
              socket('cli', '\u0000'.repeat(128)),
              recovery(job.invocationId),
              at
            )
          ).value
        ).toEqual(settled);
        const input = request(1, { goal: '\u0000'.repeat(16_384), invocationId: job.invocationId });
        expect((await restarted.invoke(f.cli, input, at)).value).toEqual({
          duplicate: true,
          job: settled,
        });
        await expect(
          restarted.invoke(f.cli, { ...input, goal: 'A changed goal' }, at)
        ).rejects.toMatchObject({ code: 'invocation_conflict' });
        expect((await restarted.lookup(f.cli, ownedLookup(job, 'cancel'), at)).value).toEqual(
          settled
        );
        expect((await restarted.cleanup(expiresAt - 1)).value).toBe(0);
      }
      await restarted.expire(expiresAt);
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: settled });
      expect((await restarted.cleanup(expiresAt)).value).toBe(1);
      expect(f.fake.entries('browser/job/')).toEqual([]);
      expect(f.fake.entries('browser/invocation/')).toEqual([]);
      expect(f.fake.get('browser/owner/ses_parent')).toMatchObject({ references: 0, fences: 1 });
      expect(await restarted.pendingCancellations()).toMatchObject([
        { message: { invocationId: job.invocationId, reason } },
      ]);
      expect((await restarted.dispatch(job.providerId, expiresAt)).value).toBeNull();
      expectBoundedRecords(f);
      await restarted.updateProvider(f.panel, quiesced(job), expiresAt);
      expect(await restarted.pendingCancellations()).toEqual([]);
      expect(f.fake.entries('browser/owner/')).toEqual([]);
      expect(f.fake.entries('browser/provider/')).toEqual([]);
    }
  );

  it.each(['near-limit running record', 'maximum approved tab'] as const)(
    'retains a maximum valid result for a %s through recovery and expiry',
    async variant => {
      const f = await setup();
      const createdAt = NOW - BROWSER_RETENTION_MS + 1_000;
      let job: BrowserJobSnapshot;
      if (variant === 'near-limit running record') {
        job = await nearLimitRunning(f, createdAt);
      } else {
        await admit(f, 1, {
          goal: '\u0000'.repeat(10_000),
          invocationId: invocation(1, createdAt),
        });
        const prefix = 'https://example.com/?';
        job = await approve(f, await dispatch(f), NOW, {
          tabId: Number.MAX_SAFE_INTEGER,
          title: '\u0000'.repeat(1024),
          url: `${prefix}${'\u0000'.repeat(8192 - prefix.length)}`,
          effectiveMode: 'dangerous',
        });
      }
      expectBoundedRecords(f);
      const result = success(job, {
        summary: 'x'.repeat(32_768),
        evidence: [
          { text: 'x'.repeat(8192) },
          { text: 'x'.repeat(8192) },
          { text: 'x'.repeat(8192) },
          { text: '' },
        ],
      });
      const last = result.evidence[3];
      if (!last) throw new Error('Missing evidence fixture');
      last.text = 'x'.repeat(65_536 - new TextEncoder().encode(JSON.stringify(result)).byteLength);
      const before = f.fake.snapshot();
      await expect(
        f.store.updateProvider(
          f.panel,
          resultMessage(job, { ...result, summary: `${result.summary.slice(1)}é` }),
          NOW
        )
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(f.fake.snapshot()).toEqual(before);
      const settled = (await f.store.updateProvider(f.panel, resultMessage(job, result), NOW)).value
        .job;
      expect(settled?.result).toEqual(result);
      expect(new TextEncoder().encode(JSON.stringify(settled?.result)).byteLength).toBe(65_536);
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: settled });
      expectBoundedRecords(f);
      const restarted = createBrowserJobStore(f.fake.storage);
      expect((await restarted.lookup(f.cli, recovery(job.invocationId), NOW + 1)).value).toEqual(
        settled
      );
      expect((await restarted.lookup(f.cli, ownedLookup(job, 'cancel'), NOW + 1)).value).toEqual(
        settled
      );
      await restarted.updateProvider(f.panel, resultMessage(job), NOW + 1);
      expect(await status(f, job, NOW + 1)).toEqual(settled);
      await restarted.expire(NOW + 1_000);
      expect(f.fake.get(`browser/job/${job.jobId}`)).toMatchObject({ snapshot: settled });
      expect((await restarted.cleanup(NOW + 1_000)).value).toBe(1);
      expect(await restarted.pendingCancellations()).toMatchObject([
        { message: { invocationId: job.invocationId, reason: 'invocation_expired' } },
      ]);
      expect((await restarted.dispatch(job.providerId, NOW + 1_000)).value).toBeNull();
      expectBoundedRecords(f);
      await restarted.updateProvider(f.panel, quiesced(job), NOW + 1_000);
      expect(await restarted.pendingCancellations()).toEqual([]);
    }
  );

  it.each(['queued', 'awaiting_approval', 'running'] as const)(
    'rejects a missing goal in retained %s work without changing durable state',
    async state => {
      const f = await setup();
      let job = await admit(f);
      if (state !== 'queued') job = await dispatch(f);
      if (state === 'running') job = await approve(f, job);
      const stored = f.fake.get(`browser/job/${job.jobId}`) as Record<string, unknown>;
      delete stored.goal;
      f.fake.seed(`browser/job/${job.jobId}`, stored);
      const before = f.fake.snapshot();
      await expect(f.store.lookup(f.cli, recovery(job.invocationId), NOW)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(f.fake.snapshot()).toEqual(before);
    }
  );
});
