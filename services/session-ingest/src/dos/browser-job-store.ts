import { z } from 'zod';
import {
  BROWSER_FRAME_MAX_BYTES,
  BROWSER_GOAL_MAX_BYTES,
  BROWSER_PAGE_SIZE,
  browserFailureReasonSchema,
  browserInvocationIdSchema,
  browserJobHandleSchema,
  browserJobIdSchema,
  browserJobSnapshotSchema,
  browserProviderIdSchema,
  browserProviderInboundMessageSchema,
  browserProviderOutboundMessageSchema,
  browserRequestSchema,
  type BrowserJobHandle,
  type BrowserJobSnapshot,
  type BrowserProviderInboundMessage,
  type BrowserRequest,
  type BrowserResult,
} from '../types/user-connection-protocol';

export const BROWSER_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const BROWSER_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const BROWSER_QUEUE_TIMEOUT_MS = 10 * 60 * 1_000;
export const BROWSER_APPROVAL_TIMEOUT_MS = 2 * 60 * 1_000;
export const BROWSER_EXECUTION_TIMEOUT_MS = 10 * 60 * 1_000;
export const BROWSER_LEASE_MS = 15_000;
export const BROWSER_MAX_JOBS = 1_000;
export const BROWSER_MAX_QUEUED = 100;
export const BROWSER_MAX_PROVIDERS = 32;

// This namespace never reads or changes legacy pendingCommand/, rename:, or readyPush: records.
const PREFIX = 'browser/';
const key = {
  meta: `${PREFIX}meta`,
  owner: (parent: string) => `${PREFIX}owner/${parent}`,
  capability: (digest: string) => `${PREFIX}capability/${digest}`,
  provider: (id: string) => `${PREFIX}provider/${id}`,
  providerProof: (digest: string) => `${PREFIX}provider-proof/${digest}`,
  conversation: (id: string) => `${PREFIX}conversation/${id}`,
  invocation: (id: string) => `${PREFIX}invocation/${id}`,
  job: (id: string) => `${PREFIX}job/${id}`,
  deadline: (id: string) => `${PREFIX}deadline/${id}`,
};

type Reason = z.infer<typeof browserFailureReasonSchema>;
type Storage = Pick<DurableObjectStorage, 'transaction'>;
type Transaction = Pick<DurableObjectTransaction, 'get' | 'put' | 'delete' | 'list'>;
export type BrowserStoreSocket = Pick<WebSocket, 'deserializeAttachment' | 'serializeAttachment'>;

export class BrowserJobStoreError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: Reason) {
    super(`Browser job request rejected: ${code}`);
    this.name = 'BrowserJobStoreError';
    this.retryable = ['capacity_exceeded', 'conversation_busy', 'provider_unavailable'].includes(
      code
    );
  }
}

function fail(code: Reason): never {
  throw new BrowserJobStoreError(code);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(limit: number) {
  return z
    .string()
    .min(1)
    .max(limit)
    .refine(value => bytes(value) <= limit);
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const parentSchema = text(128).regex(/^ses_[A-Za-z0-9_-]+$/);
const routingSchema = z.strictObject({ socketId: z.uuid(), connectionId: text(128) });
const deliverySchema = routingSchema.extend({ requestId: z.uuid() });
const attachmentSchema = z
  .object({
    role: z.enum(['cli', 'web']),
    kiloUserId: text(256),
    connectionId: text(128),
    browserSocketId: z.uuid().optional(),
  })
  .passthrough();
const metaSchema = z.strictObject({
  kiloUserId: text(256),
  jobs: count.max(BROWSER_MAX_JOBS),
  providers: count.max(BROWSER_MAX_PROVIDERS),
  sequence: count,
  generation: count,
});
const ownerSchema = z.strictObject({
  kiloUserId: text(256),
  parentSessionId: parentSchema,
  digest: digestSchema,
  references: count.max(BROWSER_MAX_JOBS),
  fences: count.max(BROWSER_MAX_PROVIDERS),
});
const capabilitySchema = ownerSchema.pick({ kiloUserId: true, parentSessionId: true });
const fenceSchema = browserJobHandleSchema.extend({
  generation: count.min(1),
  parentSessionId: parentSchema,
  routing: routingSchema,
  tabId: count.optional(),
  requiresRecovery: z.boolean(),
  cancelReason: browserFailureReasonSchema.optional(),
});
const providerSchema = z.strictObject({
  kiloUserId: text(256),
  providerId: browserProviderIdSchema,
  digest: digestSchema,
  label: text(128),
  generation: count.min(1),
  references: count.max(BROWSER_MAX_JOBS),
  queue: z.array(browserJobIdSchema).max(BROWSER_MAX_QUEUED),
  registration: routingSchema.extend({ leaseExpiresAt: timestamp }).optional(),
  fence: fenceSchema.optional(),
});
const conversationSchema = z.strictObject({
  parentSessionId: parentSchema,
  providerId: browserProviderIdSchema,
  references: count.min(1).max(BROWSER_MAX_JOBS),
  latestJobId: browserJobIdSchema,
  latestInvocationId: browserInvocationIdSchema,
  outstandingJobId: browserJobIdSchema.optional(),
});
const invocationSchema = z.strictObject({
  parentSessionId: parentSchema,
  jobId: browserJobIdSchema,
  // Rebinding delivery must not enlarge a retained result that already fills its byte budget.
  delivery: deliverySchema,
});
const jobSchema = z
  .strictObject({
    snapshot: browserJobSnapshotSchema,
    parentSessionId: parentSchema,
    // Legacy records remain readable, but absence never grants new-conversation authority.
    conversationMode: z.enum(['new', 'continue']).optional(),
    goal: text(BROWSER_GOAL_MAX_BYTES).optional(),
    sequence: count.min(1),
    dispatch: z.strictObject({ at: timestamp, routing: routingSchema }).optional(),
  })
  .refine(job => job.goal !== undefined || job.snapshot.result !== undefined);
const deadlineSchema = z.strictObject({
  jobId: browserJobIdSchema,
  providerId: browserProviderIdSchema,
  generation: count.min(1),
  expiresAt: timestamp,
  phase: z
    .strictObject({ kind: z.enum(['queue', 'approval', 'execution']), at: timestamp })
    .optional(),
});

type Owner = z.infer<typeof ownerSchema>;
type Provider = z.infer<typeof providerSchema>;
type Job = z.infer<typeof jobSchema>;
type Fence = z.infer<typeof fenceSchema>;
type Peer = z.infer<typeof routingSchema> & { kiloUserId: string };
type OwnedRequest = Exclude<BrowserRequest, { operation: 'list' }>;

export type BrowserStoreEffects = {
  updates: { job: BrowserJobSnapshot; delivery: z.infer<typeof deliverySchema> }[];
  cancellations: {
    routing: z.infer<typeof routingSchema>;
    message: Extract<BrowserProviderInboundMessage, { type: 'provider_job_cancel' }>;
  }[];
};
export type BrowserStoreChange<T> = { value: T; effects: BrowserStoreEffects };
type Context = {
  tx: Transaction;
  meta: z.infer<typeof metaSchema>;
  effects: BrowserStoreEffects;
};

// Do not expose Zod issues or raw persisted inputs from proof-bearing boundaries.
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('invalid_request');
  return parsed.data;
}

function peer(socket: BrowserStoreSocket, role: 'cli' | 'web'): Peer {
  const attachment = parse(attachmentSchema, socket.deserializeAttachment());
  if (attachment.role !== role) fail('owner_mismatch');
  // Mint this nonce on the actual socket, never from a frame or connectionId.
  // Hibernation preserves it in the attachment; reconnect creates a different nonce.
  const socketId = attachment.browserSocketId ?? crypto.randomUUID();
  if (!attachment.browserSocketId) {
    socket.serializeAttachment({ ...attachment, browserSocketId: socketId });
  }
  return { socketId, connectionId: attachment.connectionId, kiloUserId: attachment.kiloUserId };
}

function routing(socket: Peer) {
  return { socketId: socket.socketId, connectionId: socket.connectionId };
}

async function hash(fields: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(fields))
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function invocationExpiry(invocationId: string, now: number): number {
  parse(browserInvocationIdSchema, invocationId);
  const createdAt = Number(invocationId.split('.')[1]);
  if (createdAt > now + BROWSER_CLOCK_SKEW_MS) fail('invalid_request');
  const expiresAt = createdAt + BROWSER_RETENTION_MS;
  if (expiresAt <= now) fail('invocation_expired');
  return expiresAt;
}

async function read<T>(tx: Transaction, storageKey: string, schema: z.ZodType<T>) {
  const stored = await tx.get<unknown>(storageKey);
  return stored === undefined ? undefined : parse(schema, stored);
}

async function required<T>(tx: Transaction, storageKey: string, schema: z.ZodType<T>): Promise<T> {
  const stored = await read(tx, storageKey, schema);
  if (stored === undefined) fail('not_found');
  return stored;
}

async function put(tx: Transaction, storageKey: string, value: object): Promise<void> {
  // Include escaped strings, framing, routing, approval, and the complete result.
  if (bytes(JSON.stringify(value)) >= BROWSER_FRAME_MAX_BYTES) fail('capacity_exceeded');
  await tx.put(storageKey, value);
}

async function list<T>(tx: Transaction, prefix: string, schema: z.ZodType<T>, limit: number) {
  const rows = await tx.list<unknown>({ prefix: `${PREFIX}${prefix}/`, limit: limit + 1 });
  if (rows.size > limit) fail('capacity_exceeded');
  return Array.from(rows.values(), value => parse(schema, value));
}

function terminal(job: BrowserJobSnapshot): boolean {
  return job.result !== undefined;
}

function handle(job: BrowserJobHandle): BrowserJobHandle {
  return {
    providerId: job.providerId,
    browserTaskId: job.browserTaskId,
    jobId: job.jobId,
    invocationId: job.invocationId,
  };
}

function matches(left: BrowserJobHandle, right: BrowserJobHandle): boolean {
  return (
    left.providerId === right.providerId &&
    left.browserTaskId === right.browserTaskId &&
    left.jobId === right.jobId &&
    left.invocationId === right.invocationId
  );
}

function deadlineAt(
  job: BrowserJobSnapshot
): { kind: 'queue' | 'approval' | 'execution'; at: number } | undefined {
  const kind =
    job.status === 'queued'
      ? 'queue'
      : job.status === 'awaiting_approval'
        ? 'approval'
        : job.status === 'running'
          ? 'execution'
          : undefined;
  if (!kind) return undefined;
  const deadline = job.deadlines[kind];
  if (!deadline) fail('invalid_request');
  return { kind, at: Date.parse(deadline) };
}

async function saveJob(tx: Transaction, job: Job): Promise<void> {
  parse(jobSchema, job);
  await put(tx, key.job(job.snapshot.jobId), job);
  await put(tx, key.deadline(job.snapshot.jobId), {
    jobId: job.snapshot.jobId,
    providerId: job.snapshot.providerId,
    generation: job.snapshot.generation,
    expiresAt: Date.parse(job.snapshot.expiresAt),
    phase: deadlineAt(job.snapshot),
  });
}

async function checkOwner(
  c: Context,
  request: OwnedRequest,
  digest: string
): Promise<Owner | undefined> {
  const { parentSessionId } = request.owner;
  const owner = await read(c.tx, key.owner(parentSessionId), ownerSchema);
  if (owner && (owner.kiloUserId !== c.meta.kiloUserId || owner.digest !== digest))
    fail('owner_mismatch');
  const binding = await read(c.tx, key.capability(digest), capabilitySchema);
  if (
    binding &&
    (binding.kiloUserId !== c.meta.kiloUserId || binding.parentSessionId !== parentSessionId)
  )
    fail('owner_mismatch');
  return owner;
}

function cancellation(fence: Fence): BrowserStoreEffects['cancellations'][number] | undefined {
  if (!fence.cancelReason) return undefined;
  return {
    routing: fence.routing,
    message: {
      type: 'provider_job_cancel',
      ...handle(fence),
      generation: fence.generation,
      reason: fence.cancelReason,
    },
  };
}

function relayResult(
  job: Job,
  status: 'cancelled' | 'interrupted' | 'timed_out' | 'failed',
  reason: Reason,
  effectsUncertain: boolean
): BrowserResult {
  const summary =
    status === 'cancelled'
      ? 'The browser task was cancelled. Already issued actions cannot be undone.'
      : status === 'timed_out'
        ? 'The browser task reached its deadline. It will not restart automatically.'
        : reason === 'approval_denied'
          ? 'Tab approval was denied. The browser task did not start.'
          : 'The browser provider became unavailable. The task will not restart automatically.';
  return { ...handle(job.snapshot), status, reason, effectsUncertain, summary, evidence: [] };
}

async function settle(
  c: Context,
  job: Job,
  result: BrowserResult,
  cancel: boolean
): Promise<BrowserJobSnapshot> {
  if (terminal(job.snapshot)) return job.snapshot;
  const provider = await required(c.tx, key.provider(job.snapshot.providerId), providerSchema);
  const conversation = await required(
    c.tx,
    key.conversation(job.snapshot.browserTaskId),
    conversationSchema
  );
  job.snapshot = { ...job.snapshot, status: result.status, result };
  // The fingerprint preserves dedupe; terminal work no longer needs its dispatch goal.
  // This leaves room for a full result and the maximum escaped approved tab.
  delete job.goal;
  provider.queue = provider.queue.filter(id => id !== job.snapshot.jobId);
  if (conversation.outstandingJobId === job.snapshot.jobId) delete conversation.outstandingJobId;
  if (cancel && provider.fence?.jobId === job.snapshot.jobId && result.reason !== 'completed') {
    provider.fence.cancelReason ??= result.reason;
    const effect = cancellation(provider.fence);
    if (effect) c.effects.cancellations.push(effect);
  }
  await saveJob(c.tx, job);
  await put(c.tx, key.provider(provider.providerId), provider);
  await put(c.tx, key.conversation(job.snapshot.browserTaskId), conversation);
  await queueUpdate(c, job);
  return job.snapshot;
}

async function saveOwner(c: Context, owner: Owner): Promise<void> {
  if (owner.references === 0 && owner.fences === 0) {
    await c.tx.delete(key.owner(owner.parentSessionId));
    await c.tx.delete(key.capability(owner.digest));
  } else {
    await put(c.tx, key.owner(owner.parentSessionId), owner);
  }
}

async function saveProvider(c: Context, provider: Provider): Promise<void> {
  if (
    provider.references === 0 &&
    !provider.registration &&
    !provider.fence &&
    provider.queue.length === 0
  ) {
    await c.tx.delete(key.provider(provider.providerId));
    await c.tx.delete(key.providerProof(provider.digest));
    c.meta.providers--;
  } else {
    await put(c.tx, key.provider(provider.providerId), provider);
  }
}

async function releaseFence(c: Context, provider: Provider): Promise<void> {
  if (!provider.fence) return;
  const owner = await required(c.tx, key.owner(provider.fence.parentSessionId), ownerSchema);
  owner.fences--;
  delete provider.fence;
  await saveOwner(c, owner);
  await saveProvider(c, provider);
}

async function interruptProvider(c: Context, providerId: string, reason: Reason): Promise<void> {
  const provider = await required(c.tx, key.provider(providerId), providerSchema);
  delete provider.registration;
  if (provider.fence) provider.fence.requiresRecovery = true;
  await put(c.tx, key.provider(providerId), provider);
  const jobs = [...(provider.fence ? [provider.fence.jobId] : []), ...provider.queue];
  for (const jobId of jobs) {
    const job = await read(c.tx, key.job(jobId), jobSchema);
    if (!job || terminal(job.snapshot)) continue;
    const active = provider.fence?.jobId === jobId;
    await settle(
      c,
      job,
      relayResult(job, 'interrupted', active ? reason : 'provider_unavailable', active),
      active
    );
  }
  // A retained fence can outlive the result and still needs a cancellation after restart.
  const updated = await required(c.tx, key.provider(providerId), providerSchema);
  if (updated.fence && !updated.fence.cancelReason) {
    updated.fence.cancelReason = reason;
    const effect = cancellation(updated.fence);
    if (effect) c.effects.cancellations.push(effect);
  }
  await saveProvider(c, updated);
}

async function expireJob(c: Context, job: Job, now: number): Promise<boolean> {
  if (terminal(job.snapshot)) return false;
  const phase = deadlineAt(job.snapshot);
  const expired = Date.parse(job.snapshot.expiresAt) <= now;
  if (!expired && (!phase || phase.at > now)) return false;
  const reason = expired
    ? 'invocation_expired'
    : phase?.kind === 'queue'
      ? 'queue_timeout'
      : phase?.kind === 'approval'
        ? 'approval_timeout'
        : 'execution_timeout';
  const dispatched = job.dispatch !== undefined;
  await settle(c, job, relayResult(job, 'timed_out', reason, dispatched), dispatched);
  if (dispatched) await interruptProvider(c, job.snapshot.providerId, reason);
  return true;
}

async function cancelJob(c: Context, job: Job, now: number): Promise<BrowserJobSnapshot> {
  await expireJob(c, job, now);
  if (terminal(job.snapshot)) return job.snapshot;
  const running = job.snapshot.status === 'running';
  await settle(
    c,
    job,
    relayResult(job, 'cancelled', 'cancelled', running),
    job.dispatch !== undefined
  );
  if (running) await interruptProvider(c, job.snapshot.providerId, 'cancelled');
  return job.snapshot;
}

function clampedDeadline(job: BrowserJobSnapshot, at: number): string {
  return new Date(Math.min(Date.parse(job.expiresAt), at)).toISOString();
}

async function providerPage<
  T extends Extract<
    BrowserProviderInboundMessage,
    { type: 'provider_snapshot' | 'provider_status_result' }
  >,
>(c: Context, frame: T, now: number, cursor?: string): Promise<T> {
  const deadlines = await list(c.tx, 'deadline', deadlineSchema, BROWSER_MAX_JOBS);
  const rows = deadlines.filter(
    row =>
      row.providerId === frame.providerId &&
      (frame.type !== 'provider_snapshot' || row.generation === frame.generation) &&
      row.expiresAt > now &&
      (!cursor || row.jobId > cursor)
  );
  for (const row of rows) {
    const job = await required(c.tx, key.job(row.jobId), jobSchema);
    const candidate = { ...frame, jobs: [...frame.jobs, job.snapshot], nextCursor: row.jobId };
    if (
      frame.jobs.length === BROWSER_PAGE_SIZE ||
      bytes(JSON.stringify(candidate)) + 64 >= BROWSER_FRAME_MAX_BYTES
    )
      break;
    frame.jobs.push(job.snapshot);
  }
  if (frame.jobs.length < rows.length) frame.nextCursor = frame.jobs.at(-1)?.jobId;
  parse(browserProviderInboundMessageSchema, frame);
  return frame;
}

async function queueUpdate(c: Context, job: Job): Promise<void> {
  const invocation = await required(
    c.tx,
    key.invocation(job.snapshot.invocationId),
    invocationSchema
  );
  if (invocation.jobId !== job.snapshot.jobId || invocation.parentSessionId !== job.parentSessionId)
    fail('invalid_request');
  c.effects.updates.push({ job: job.snapshot, delivery: invocation.delivery });
}

function executionLease(provider: Provider): number {
  if (!provider.registration) fail('provider_unavailable');
  const expiry = provider.fence
    ? Number(provider.fence.invocationId.split('.')[1]) + BROWSER_RETENTION_MS
    : Infinity;
  return Math.min(provider.registration.leaseExpiresAt, expiry);
}

/** All effects leave the transaction only after commit. The caller performs socket sends. */
export function createBrowserJobStore(storage: Storage) {
  async function transaction<T>(
    kiloUserId: string | undefined,
    run: (c: Context) => Promise<T>
  ): Promise<BrowserStoreChange<T>> {
    return storage.transaction(async tx => {
      const stored = await read(tx, key.meta, metaSchema);
      if (stored && kiloUserId && stored.kiloUserId !== kiloUserId) fail('owner_mismatch');
      const meta = stored ?? {
        kiloUserId: kiloUserId ?? 'unbound',
        jobs: 0,
        providers: 0,
        sequence: 0,
        generation: 0,
      };
      const before = JSON.stringify(meta);
      const effects: BrowserStoreEffects = { updates: [], cancellations: [] };
      const value = await run({ tx, meta, effects });
      if (JSON.stringify(meta) !== before) await put(tx, key.meta, parse(metaSchema, meta));
      return { value, effects };
    });
  }

  async function invoke(socket: BrowserStoreSocket, input: unknown, now = Date.now()) {
    const request = parse(browserRequestSchema, input);
    if (request.operation !== 'invoke') fail('invalid_request');
    // Expiry validation precedes every storage lookup, including a duplicate lookup.
    const expiresAt = invocationExpiry(request.invocationId, now);
    const identity = peer(socket, 'cli');
    const digest = await hash([request.owner.parentProof]);
    const fingerprint = await hash([
      identity.kiloUserId,
      request.owner.parentSessionId,
      digest,
      request.providerId,
      request.browserTaskId ?? '',
      request.goal,
    ]);
    return transaction(identity.kiloUserId, async c => {
      const owner = await checkOwner(c, request, digest);
      const prior = await read(c.tx, key.invocation(request.invocationId), invocationSchema);
      if (prior) {
        if (!owner || prior.parentSessionId !== owner.parentSessionId) fail('owner_mismatch');
        const job = await required(c.tx, key.job(prior.jobId), jobSchema);
        if (job.snapshot.payloadFingerprint !== fingerprint) fail('invocation_conflict');
        // A proven reconnect changes delivery only, never ownership or execution state.
        prior.delivery = { ...routing(identity), requestId: request.requestId };
        await put(c.tx, key.invocation(request.invocationId), prior);
        return { job: job.snapshot, duplicate: true };
      }
      const previousConversation = request.browserTaskId
        ? await read(c.tx, key.conversation(request.browserTaskId), conversationSchema)
        : undefined;
      if (request.browserTaskId) {
        if (!previousConversation) fail('invocation_expired');
        if (
          !owner ||
          previousConversation.parentSessionId !== owner.parentSessionId ||
          previousConversation.providerId !== request.providerId
        )
          fail('owner_mismatch');
        invocationExpiry(previousConversation.latestInvocationId, now);
        if (previousConversation.outstandingJobId) fail('conversation_busy');
      }
      const provider = await read(c.tx, key.provider(request.providerId), providerSchema);
      if (
        !provider?.registration ||
        provider.registration.leaseExpiresAt <= now ||
        provider.fence?.requiresRecovery
      )
        fail('provider_unavailable');
      if (
        c.meta.jobs >= BROWSER_MAX_JOBS ||
        provider.queue.length >= BROWSER_MAX_QUEUED ||
        c.meta.sequence === Number.MAX_SAFE_INTEGER
      )
        fail('capacity_exceeded');
      const browserTaskId: BrowserJobSnapshot['browserTaskId'] =
        request.browserTaskId ?? `bt_${crypto.randomUUID()}`;
      const jobId: BrowserJobSnapshot['jobId'] = `bj_${crypto.randomUUID()}`;
      const snapshot: BrowserJobSnapshot = {
        providerId: provider.providerId,
        browserTaskId,
        jobId,
        invocationId: request.invocationId,
        generation: provider.generation,
        payloadFingerprint: fingerprint,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        deadlines: {
          queue: new Date(Math.min(expiresAt, now + BROWSER_QUEUE_TIMEOUT_MS)).toISOString(),
        },
        status: 'queued',
      };
      const job: Job = {
        snapshot,
        parentSessionId: request.owner.parentSessionId,
        conversationMode: request.browserTaskId === undefined ? 'new' : 'continue',
        goal: request.goal,
        sequence: ++c.meta.sequence,
      };
      const boundOwner = owner ?? {
        kiloUserId: identity.kiloUserId,
        parentSessionId: request.owner.parentSessionId,
        digest,
        references: 0,
        fences: 0,
      };
      boundOwner.references++;
      const conversation = {
        parentSessionId: boundOwner.parentSessionId,
        providerId: provider.providerId,
        references: (previousConversation?.references ?? 0) + 1,
        latestJobId: jobId,
        latestInvocationId: request.invocationId,
        outstandingJobId: jobId,
      };
      provider.references++;
      provider.queue.push(jobId);
      c.meta.jobs++;
      await saveJob(c.tx, job);
      await put(c.tx, key.invocation(request.invocationId), {
        parentSessionId: boundOwner.parentSessionId,
        jobId,
        delivery: { ...routing(identity), requestId: request.requestId },
      });
      await put(c.tx, key.owner(boundOwner.parentSessionId), boundOwner);
      await put(c.tx, key.capability(digest), {
        kiloUserId: identity.kiloUserId,
        parentSessionId: boundOwner.parentSessionId,
      });
      await put(c.tx, key.provider(provider.providerId), provider);
      await put(c.tx, key.conversation(browserTaskId), conversation);
      return { job: snapshot, duplicate: false };
    });
  }

  async function lookup(socket: BrowserStoreSocket, input: unknown, now = Date.now()) {
    const request = parse(browserRequestSchema, input);
    if (
      request.operation !== 'status' &&
      request.operation !== 'recover' &&
      request.operation !== 'cancel'
    )
      fail('invalid_request');
    if (request.operation === 'recover') invocationExpiry(request.invocationId, now);
    const identity = peer(socket, 'cli');
    const digest = await hash([request.owner.parentProof]);
    return transaction(identity.kiloUserId, async c => {
      const owner = await checkOwner(c, request, digest);
      let job: Job;
      if (request.operation === 'recover') {
        const prior = await read(c.tx, key.invocation(request.invocationId), invocationSchema);
        if (!prior) return null;
        if (!owner || prior.parentSessionId !== owner.parentSessionId) fail('owner_mismatch');
        job = await required(c.tx, key.job(prior.jobId), jobSchema);
      } else {
        const conversation = await read(
          c.tx,
          key.conversation(request.browserTaskId),
          conversationSchema
        );
        if (!conversation) fail('invocation_expired');
        if (!owner || conversation.parentSessionId !== owner.parentSessionId)
          fail('owner_mismatch');
        if (!request.jobId) invocationExpiry(conversation.latestInvocationId, now);
        job = await required(c.tx, key.job(request.jobId ?? conversation.latestJobId), jobSchema);
        if (
          job.snapshot.browserTaskId !== request.browserTaskId ||
          job.parentSessionId !== owner.parentSessionId
        )
          fail('owner_mismatch');
        invocationExpiry(job.snapshot.invocationId, now);
      }
      if (
        job.parentSessionId !== request.owner.parentSessionId ||
        (request.operation === 'recover' && job.snapshot.invocationId !== request.invocationId)
      )
        fail('owner_mismatch');
      const invocation = await required(
        c.tx,
        key.invocation(job.snapshot.invocationId),
        invocationSchema
      );
      if (
        invocation.jobId !== job.snapshot.jobId ||
        invocation.parentSessionId !== job.parentSessionId
      )
        fail('owner_mismatch');
      invocation.delivery = { ...routing(identity), requestId: request.requestId };
      await put(c.tx, key.invocation(job.snapshot.invocationId), invocation);
      if (request.operation === 'cancel') return cancelJob(c, job, now);
      return job.snapshot;
    });
  }

  async function providerStatus(socket: BrowserStoreSocket, input: unknown, now = Date.now()) {
    const message = parse(browserProviderOutboundMessageSchema, input);
    if (message.type !== 'provider_status') fail('invalid_request');
    // Status authenticates the attachment without minting or binding a socket nonce.
    const identity = parse(attachmentSchema, socket.deserializeAttachment());
    if (identity.role !== 'web') fail('owner_mismatch');
    const digest = await hash([message.providerProof]);
    const result = await transaction(identity.kiloUserId, async c => {
      const provider = await required(c.tx, key.provider(message.providerId), providerSchema);
      const proofBinding = await read(c.tx, key.providerProof(digest), browserProviderIdSchema);
      if (
        provider.kiloUserId !== identity.kiloUserId ||
        provider.providerId !== message.providerId ||
        provider.digest !== digest ||
        proofBinding !== message.providerId
      )
        fail('owner_mismatch');
      const frame: Extract<BrowserProviderInboundMessage, { type: 'provider_status_result' }> = {
        type: 'provider_status_result',
        requestId: message.requestId,
        providerId: provider.providerId,
        jobs: [],
      };
      return providerPage(c, frame, now, message.cursor);
    });
    return result.value;
  }

  async function registerProvider(socket: BrowserStoreSocket, input: unknown, now = Date.now()) {
    const message = parse(browserProviderOutboundMessageSchema, input);
    if (message.type !== 'provider_register') fail('invalid_request');
    const identity = peer(socket, 'web');
    const digest = await hash([message.providerProof]);
    return transaction(identity.kiloUserId, async c => {
      let provider = await read(c.tx, key.provider(message.providerId), providerSchema);
      const proofBinding = await read(c.tx, key.providerProof(digest), browserProviderIdSchema);
      if (
        (provider && provider.digest !== digest) ||
        (proofBinding && proofBinding !== message.providerId)
      )
        fail('owner_mismatch');
      if (message.generation > c.meta.generation) fail('invalid_request');
      if (
        (!provider && c.meta.providers >= BROWSER_MAX_PROVIDERS) ||
        c.meta.generation === Number.MAX_SAFE_INTEGER
      )
        fail('capacity_exceeded');
      if (provider?.fence) {
        const recovery = message.recovery;
        if (
          !recovery ||
          recovery.invocationId !== provider.fence.invocationId ||
          (provider.fence.tabId !== undefined && recovery.tabId !== provider.fence.tabId)
        )
          fail('provider_unavailable');
        await interruptProvider(c, provider.providerId, 'provider_lost');
        provider = await required(c.tx, key.provider(provider.providerId), providerSchema);
        // Registration stays present until the new grant replaces it, so release cannot reclaim the binding.
        provider.registration = { ...routing(identity), leaseExpiresAt: now + BROWSER_LEASE_MS };
        await releaseFence(c, provider);
      } else if (message.recovery) {
        fail('invalid_request');
      }
      if (provider) {
        // A new generation never adopts queued work from an older registration.
        for (const jobId of provider.queue) {
          const job = await required(c.tx, key.job(jobId), jobSchema);
          await settle(
            c,
            job,
            relayResult(job, 'interrupted', 'provider_unavailable', false),
            false
          );
        }
        provider = await required(c.tx, key.provider(provider.providerId), providerSchema);
      } else {
        c.meta.providers++;
      }
      const generation = ++c.meta.generation;
      const registered: Provider = {
        kiloUserId: identity.kiloUserId,
        providerId: message.providerId,
        digest,
        label: message.label,
        generation,
        references: provider?.references ?? 0,
        queue: [],
        registration: { ...routing(identity), leaseExpiresAt: now + BROWSER_LEASE_MS },
      };
      await put(c.tx, key.provider(message.providerId), registered);
      await c.tx.put(key.providerProof(digest), message.providerId);
      return { providerId: message.providerId, generation, leaseExpiresAt: now + BROWSER_LEASE_MS };
    });
  }

  async function dispatch(providerId: string, now = Date.now()) {
    parse(browserProviderIdSchema, providerId);
    return transaction(undefined, async c => {
      let provider = await read(c.tx, key.provider(providerId), providerSchema);
      if (!provider?.registration || provider.fence) return null;
      if (provider.registration.leaseExpiresAt <= now) {
        await interruptProvider(c, providerId, 'lease_expired');
        return null;
      }
      while (provider.queue.length > 0) {
        const jobId = provider.queue[0];
        if (!jobId) return null;
        const job = await required(c.tx, key.job(jobId), jobSchema);
        if (job.dispatch || job.snapshot.status !== 'queued' || job.goal === undefined)
          fail('invalid_request');
        if (await expireJob(c, job, now)) {
          provider = await required(c.tx, key.provider(providerId), providerSchema);
          continue;
        }
        if (job.conversationMode === undefined) {
          await settle(
            c,
            job,
            {
              ...relayResult(job, 'failed', 'invalid_request', false),
              summary: 'The browser task has no recorded conversation intent. It did not start.',
            },
            false
          );
          provider = await required(c.tx, key.provider(providerId), providerSchema);
          continue;
        }
        const registration = provider.registration;
        if (!registration) return null;
        job.dispatch = {
          at: now,
          routing: { socketId: registration.socketId, connectionId: registration.connectionId },
        };
        job.snapshot = {
          ...job.snapshot,
          status: 'awaiting_approval',
          deadlines: {
            ...job.snapshot.deadlines,
            approval: clampedDeadline(job.snapshot, now + BROWSER_APPROVAL_TIMEOUT_MS),
          },
        };
        provider.queue.shift();
        provider.fence = {
          ...handle(job.snapshot),
          generation: provider.generation,
          parentSessionId: job.parentSessionId,
          routing: job.dispatch.routing,
          requiresRecovery: false,
        };
        const owner = await required(c.tx, key.owner(job.parentSessionId), ownerSchema);
        owner.fences++;
        await saveJob(c.tx, job);
        await put(c.tx, key.provider(providerId), provider);
        await put(c.tx, key.owner(owner.parentSessionId), owner);
        await queueUpdate(c, job);
        const message: Extract<BrowserProviderInboundMessage, { type: 'provider_job' }> = {
          type: 'provider_job',
          job: job.snapshot,
          goal: job.goal,
          ownerLabel: job.parentSessionId,
          conversationMode: job.conversationMode,
        };
        if (bytes(JSON.stringify(message)) >= BROWSER_FRAME_MAX_BYTES) fail('capacity_exceeded');
        return { routing: job.dispatch.routing, message };
      }
      return null;
    });
  }

  async function updateProvider(socket: BrowserStoreSocket, input: unknown, now = Date.now()) {
    const message = parse(browserProviderOutboundMessageSchema, input);
    if (message.type === 'provider_register' || message.type === 'provider_status')
      fail('invalid_request');
    const identity = peer(socket, 'web');
    return transaction(identity.kiloUserId, async c => {
      const provider = await required(c.tx, key.provider(message.providerId), providerSchema);
      if (provider.generation !== message.generation) fail('owner_mismatch');
      if (message.type === 'provider_quiesced') {
        const fence = provider.fence;
        if (
          !fence ||
          fence.routing.socketId !== identity.socketId ||
          !matches(fence, message) ||
          (fence.tabId !== undefined && fence.tabId !== message.tabId)
        )
          fail('owner_mismatch');
        const job = await read(c.tx, key.job(fence.jobId), jobSchema);
        if (job && !terminal(job.snapshot)) fail('invalid_request');
        await releaseFence(c, provider);
        return { job: job?.snapshot };
      }
      if (!provider.registration || provider.registration.socketId !== identity.socketId)
        fail('owner_mismatch');
      if (executionLease(provider) <= now) {
        const job = provider.fence
          ? await read(c.tx, key.job(provider.fence.jobId), jobSchema)
          : undefined;
        if (job) await expireJob(c, job, now);
        await interruptProvider(
          c,
          provider.providerId,
          job && Date.parse(job.snapshot.expiresAt) <= now ? 'invocation_expired' : 'lease_expired'
        );
        return { unavailable: true };
      }
      if (message.type === 'provider_unavailable') {
        await interruptProvider(c, provider.providerId, message.reason);
        return { unavailable: true };
      }
      if (message.type === 'provider_heartbeat') {
        provider.registration.leaseExpiresAt = now + BROWSER_LEASE_MS;
        if (provider.fence) {
          const job = await read(c.tx, key.job(provider.fence.jobId), jobSchema);
          if (job && !terminal(job.snapshot)) {
            if (await expireJob(c, job, now)) return { job: job.snapshot, unavailable: true };
            if (job.snapshot.status === 'running') {
              job.snapshot.deadlines.lease = clampedDeadline(
                job.snapshot,
                provider.registration.leaseExpiresAt
              );
              await saveJob(c.tx, job);
            }
          }
        }
        await put(c.tx, key.provider(provider.providerId), provider);
        const frame: Extract<BrowserProviderInboundMessage, { type: 'provider_snapshot' }> = {
          type: 'provider_snapshot',
          providerId: provider.providerId,
          generation: provider.generation,
          jobs: [],
        };
        return {
          leaseExpiresAt: executionLease(provider),
          snapshot: await providerPage(c, frame, now, message.cursor),
        };
      }
      const job = await required(c.tx, key.job(message.jobId), jobSchema);
      if (!matches(job.snapshot, message) || job.snapshot.generation !== message.generation)
        fail('owner_mismatch');
      if (message.type === 'provider_cancel') return { job: await cancelJob(c, job, now) };
      if (
        !provider.fence ||
        !matches(provider.fence, message) ||
        job.dispatch?.routing.socketId !== identity.socketId
      )
        fail('owner_mismatch');
      if (await expireJob(c, job, now)) return { job: job.snapshot, unavailable: true };
      if (terminal(job.snapshot)) return { job: job.snapshot };
      if (message.type === 'provider_approval') {
        if (job.snapshot.status !== 'awaiting_approval') fail('invalid_request');
        if (message.approval.decision === 'denied') {
          await settle(c, job, relayResult(job, 'failed', 'approval_denied', false), false);
        } else {
          provider.fence.tabId = message.approval.tab.tabId;
          job.snapshot = {
            ...job.snapshot,
            status: 'running',
            approvedTab: message.approval.tab,
            deadlines: {
              ...job.snapshot.deadlines,
              execution: clampedDeadline(job.snapshot, now + BROWSER_EXECUTION_TIMEOUT_MS),
              lease: clampedDeadline(job.snapshot, provider.registration.leaseExpiresAt),
            },
          };
          await saveJob(c.tx, job);
          await put(c.tx, key.provider(provider.providerId), provider);
          await queueUpdate(c, job);
        }
      } else {
        const tab = job.snapshot.approvedTab;
        if (
          job.snapshot.status !== 'running' ||
          !tab ||
          tab.tabId !== message.tab.tabId ||
          tab.title !== message.tab.title ||
          tab.url !== message.tab.url ||
          tab.effectiveMode !== message.tab.effectiveMode
        )
          fail('invalid_request');
        await settle(c, job, message.result, false);
        if (message.result.effectsUncertain)
          await interruptProvider(c, provider.providerId, 'effects_uncertain');
      }
      return { job: job.snapshot };
    });
  }

  async function disconnectProvider(socket: BrowserStoreSocket, now = Date.now()) {
    const identity = peer(socket, 'web');
    return transaction(identity.kiloUserId, async c => {
      const providers = await list(c.tx, 'provider', providerSchema, BROWSER_MAX_PROVIDERS);
      for (const provider of providers) {
        if (provider.registration?.socketId !== identity.socketId) continue;
        if (provider.fence) {
          const job = await read(c.tx, key.job(provider.fence.jobId), jobSchema);
          if (job) await expireJob(c, job, now);
        }
        await interruptProvider(c, provider.providerId, 'provider_lost');
      }
    });
  }

  async function expire(now = Date.now()) {
    return transaction(undefined, async c => {
      const deadlines = await list(c.tx, 'deadline', deadlineSchema, BROWSER_MAX_JOBS);
      for (const deadline of deadlines) {
        if (deadline.expiresAt <= now || (deadline.phase && deadline.phase.at <= now)) {
          const job = await required(c.tx, key.job(deadline.jobId), jobSchema);
          if (terminal(job.snapshot) && deadline.expiresAt <= now) {
            const provider = await required(
              c.tx,
              key.provider(job.snapshot.providerId),
              providerSchema
            );
            if (provider.fence?.jobId === job.snapshot.jobId)
              await interruptProvider(c, provider.providerId, 'invocation_expired');
          } else {
            await expireJob(c, job, now);
          }
        }
      }
      const providers = await list(c.tx, 'provider', providerSchema, BROWSER_MAX_PROVIDERS);
      for (const provider of providers) {
        if (provider.registration && executionLease(provider) <= now)
          await interruptProvider(
            c,
            provider.providerId,
            provider.registration.leaseExpiresAt <= now ? 'lease_expired' : 'invocation_expired'
          );
      }
    });
  }

  // Call after delivering expire() effects. Active expired records cannot be deleted.
  // The compact cancellation/fence survives cleanup, so a lost send can be retried safely.
  async function cleanup(now = Date.now()) {
    return transaction(undefined, async c => {
      let removed = 0;
      const deadlines = await list(c.tx, 'deadline', deadlineSchema, BROWSER_MAX_JOBS);
      for (const deadline of deadlines) {
        if (deadline.expiresAt > now) continue;
        const job = await required(c.tx, key.job(deadline.jobId), jobSchema);
        if (!terminal(job.snapshot)) continue;
        const owner = await required(c.tx, key.owner(job.parentSessionId), ownerSchema);
        const provider = await required(
          c.tx,
          key.provider(job.snapshot.providerId),
          providerSchema
        );
        if (provider.fence?.jobId === job.snapshot.jobId && !provider.fence.cancelReason) continue;
        const conversation = await required(
          c.tx,
          key.conversation(job.snapshot.browserTaskId),
          conversationSchema
        );
        owner.references--;
        provider.references--;
        conversation.references--;
        await c.tx.delete(key.job(job.snapshot.jobId));
        await c.tx.delete(key.invocation(job.snapshot.invocationId));
        await c.tx.delete(key.deadline(job.snapshot.jobId));
        if (conversation.references === 0)
          await c.tx.delete(key.conversation(job.snapshot.browserTaskId));
        else await put(c.tx, key.conversation(job.snapshot.browserTaskId), conversation);
        await saveOwner(c, owner);
        await saveProvider(c, provider);
        c.meta.jobs--;
        removed++;
      }
      return removed;
    });
  }

  async function deadlines() {
    const result = await transaction(undefined, async c => {
      const earliest: Record<
        'queue' | 'approval' | 'execution' | 'lease' | 'retention',
        number | null
      > = {
        queue: null,
        approval: null,
        execution: null,
        lease: null,
        retention: null,
      };
      function include(kind: keyof typeof earliest, at: number) {
        earliest[kind] = Math.min(earliest[kind] ?? Infinity, at);
      }
      for (const row of await list(c.tx, 'deadline', deadlineSchema, BROWSER_MAX_JOBS)) {
        include('retention', row.expiresAt);
        if (row.phase) include(row.phase.kind, row.phase.at);
      }
      for (const provider of await list(c.tx, 'provider', providerSchema, BROWSER_MAX_PROVIDERS)) {
        if (provider.registration) include('lease', executionLease(provider));
      }
      const values = Object.values(earliest).filter(value => value !== null);
      return { ...earliest, next: values.length ? Math.min(...values) : null };
    });
    return result.value;
  }

  async function pendingCancellations() {
    const result = await transaction(undefined, async c => {
      const providers = await list(c.tx, 'provider', providerSchema, BROWSER_MAX_PROVIDERS);
      return providers.flatMap(provider => {
        const effect = provider.fence && cancellation(provider.fence);
        return effect ? [effect] : [];
      });
    });
    return result.value;
  }

  async function listProviders(socket: BrowserStoreSocket, input: unknown, now = Date.now()) {
    const request = parse(browserRequestSchema, input);
    if (request.operation !== 'list') fail('invalid_request');
    const identity = peer(socket, 'cli');
    const result = await transaction(identity.kiloUserId, async c => {
      const rows = (await list(c.tx, 'provider', providerSchema, BROWSER_MAX_PROVIDERS)).filter(
        provider => !request.cursor || provider.providerId > request.cursor
      );
      const providers = rows.slice(0, BROWSER_PAGE_SIZE).map(provider => ({
        providerId: provider.providerId,
        label: provider.label,
        availability:
          !provider.registration ||
          provider.registration.leaseExpiresAt <= now ||
          provider.fence?.requiresRecovery
            ? ('unavailable' as const)
            : provider.fence
              ? ('busy' as const)
              : ('available' as const),
        queueDepth: provider.queue.length,
      }));
      return {
        providers,
        ...(rows.length > providers.length ? { nextCursor: providers.at(-1)?.providerId } : {}),
      };
    });
    return result.value;
  }

  return {
    invoke,
    lookup,
    providerStatus,
    registerProvider,
    dispatch,
    updateProvider,
    disconnectProvider,
    expire,
    cleanup,
    deadlines,
    pendingCancellations,
    listProviders,
  };
}

export type BrowserJobStore = ReturnType<typeof createBrowserJobStore>;
