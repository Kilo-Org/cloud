import { sha256Hex } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle/migrations';
import type { Env } from '../env';
import { DataRateLimit } from '../data-rate-limit';
import { toHex } from '../hex';
import { isOverloaded, overloaded } from '../overload';
import {
  LIMITS,
  batchJsonWithinBudget,
  batchRequestSchema,
  blobRefSchema,
  cursorSchema,
  fail,
  hashSchema,
  isBoundedJson,
  ok,
  principalSchema,
  registerRequestSchema,
  sessionIDSchema,
  utf8Bytes,
  type BlobAck,
  type ErrorCode,
  type Receipt,
  type Result,
  type SessionState,
  type Tenant,
} from '../protocol';
import * as batches from './session-sync/batch';
import { getTenantStub } from './SessionSyncTenantDO';
import { getRelayStub } from './SessionRelayDO';
import * as blob from './session-sync/blob';
import * as erase from './session-sync/erase';
import * as page from './session-sync/page';
import * as session from './session-sync/session';
import { leaseBytes } from './session-sync/lease';
import { diagnostic, metricsEnabled, phase, syncPhase, type DiagnosticOperation } from '../metrics';

const PURGE_RETRY_MS = 60_000;
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
class LeaseRequired extends Error {
  constructor(readonly bytes: number) {
    super('A larger tenant lease is required');
  }
}

const target = { principal: principalSchema, sessionID: sessionIDSchema };
const stateInput = z.strictObject(target);
const registerInput = z.strictObject({ ...target, request: registerRequestSchema });
const batchInput = z.strictObject({ ...target, body: z.string() });
const pageInput = z.strictObject({
  ...target,
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.pageItems),
  revision: z.number().int().min(0).optional(),
});
const blobInput = z.strictObject({ ...target, blob: blobRefSchema });
const attemptInput = z.strictObject({ ...target, blob: blobRefSchema, attempt: z.uuid() });
const locateInput = z.strictObject({ ...target, hash: hashSchema });

function parse<T>(schema: z.ZodType<T>, input: unknown): Result<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return fail('invalid_request', z.prettifyError(parsed.error).slice(0, 2000));
}

/** Parses and validates the exact batch body that the digest covers. */
function parseBatch(body: string) {
  if (!batchJsonWithinBudget(body)) {
    return fail('json_budget_exceeded', 'The batch exceeds the JSON depth or node budget', {
      depth: LIMITS.jsonBatchDepth,
      nodes: LIMITS.jsonBatchNodes,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return fail('invalid_request', 'The body is not valid JSON');
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'changes' in value &&
    Array.isArray(value.changes)
  ) {
    const changes: unknown[] = value.changes;
    for (const change of changes) {
      const budget = { nodes: 0, exceeded: false };
      if (
        change !== null &&
        typeof change === 'object' &&
        'value' in change &&
        !isBoundedJson(change.value, 0, budget) &&
        budget.exceeded
      ) {
        return fail(
          'json_budget_exceeded',
          'An inline value exceeds the JSON depth or node budget',
          {
            depth: LIMITS.jsonDepth,
            nodes: LIMITS.jsonValueNodes,
          }
        );
      }
    }
  }
  return parse(batchRequestSchema, value);
}

/**
 * One native session of one tenant. SQLite holds the producer binding, current
 * entities, receipts, and blob acknowledgements; R2 holds blob bytes. Each
 * method validates its input and returns a typed result instead of throwing
 * client errors across RPC.
 */
export class SessionSyncDO extends DurableObject<Env> {
  private db: session.Db;
  private quotaGate: Promise<void> = Promise.resolve();
  private admissionQueueDepth = 0;
  private pendingBatchBytes = 0;
  private pendingBatches = 0;
  private purgeRetryAt = 0;
  private relayUsed = false;
  private relayPurged = false;
  private relayPurgeRetryAt = 0;
  private leaseReconcilePending = false;
  private pendingRegistration:
    | { tenant: Tenant; sessionID: string; creatorID?: string }
    | undefined;
  private dataRateLimit = new DataRateLimit();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() =>
      phase(env, 'syncInitialize', 'initialize', async () => {
        await migrate(this.db, migrations);
        this.purgeRetryAt = (await ctx.storage.get<number>('purgeRetryAt')) ?? 0;
        this.relayUsed = (await ctx.storage.get<boolean>('relayUsed')) ?? false;
        this.relayPurged = (await ctx.storage.get<boolean>('relayPurged')) ?? false;
        this.relayPurgeRetryAt = (await ctx.storage.get<number>('relayPurgeRetryAt')) ?? 0;
        this.leaseReconcilePending =
          (await ctx.storage.get<boolean>('leaseReconcilePending')) ?? false;
        this.pendingRegistration = await ctx.storage.get('pendingRegistration');
        await this.scheduleSweep();
      })
    );
  }

  /** Runs `fn` in one storage transaction; a `SyncFailure` rolls it back. */
  private tx<T>(fn: () => T): Result<T> {
    try {
      return ok(this.ctx.storage.transactionSync(fn));
    } catch (error) {
      if (error instanceof session.SyncFailure) return { ok: false, error: error.error };
      throw error;
    }
  }

  /** Serializes admission changes without blocking reads during tenant RPCs. */
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.quotaGate;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.quotaGate = promise;
    this.admissionQueueDepth++;
    const queuedAt = metricsEnabled(this.env) ? performance.now() : 0;
    await prior;
    diagnostic(this.env, {
      operation: 'tenantAdmission',
      stage: 'queue_wait',
      durationMs: queuedAt ? performance.now() - queuedAt : 0,
      queueDepth: this.admissionQueueDepth,
      retainedBytes: this.pendingBatchBytes,
    });
    try {
      return await fn();
    } finally {
      this.admissionQueueDepth--;
      resolve();
    }
  }

  private async tenantCall<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await phase(this.env, 'tenantAdmission', 'tenant_rpc', fn);
    } catch (error) {
      if (isOverloaded(error)) return overloaded();
      console.error('session-sync tenant admission failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
      return fail('tenant_unavailable', 'Tenant admission is temporarily unavailable', {
        retryAt: Date.now() + PURGE_RETRY_MS,
      });
    }
  }

  private async markLeaseReconcile(): Promise<void> {
    await this.ctx.storage.put('leaseReconcilePending', true);
    this.leaseReconcilePending = true;
    await this.scheduleSweep();
  }

  private async clearLeaseReconcile(): Promise<void> {
    await this.ctx.storage.delete('leaseReconcilePending');
    this.leaseReconcilePending = false;
  }

  /** Rolls back an over-lease mutation before obtaining capacity outside SQLite. */
  private async leased<T>(
    principal: z.infer<typeof principalSchema>,
    sessionID: string,
    operation: DiagnosticOperation,
    fn: () => T
  ): Promise<Result<T>> {
    return this.serial(async () => {
      let reapplying = false;
      for (;;) {
        const started = metricsEnabled(this.env) ? performance.now() : 0;
        try {
          const result = this.tx(() => {
            const value = fn();
            const meta = session.load(this.db);
            if (meta && meta.blob_bytes + meta.inline_bytes > meta.tenant_lease) {
              throw new LeaseRequired(meta.blob_bytes + meta.inline_bytes);
            }
            return value;
          });
          diagnostic(this.env, {
            operation,
            stage: reapplying ? 'lease_reapply' : 'sql_transaction',
            tenant: principal.tenant.type,
            durationMs: started ? performance.now() - started : 0,
            outcome: result.ok ? 'ok' : result.error.code,
            cause: result.ok ? 'none' : 'typed_result',
          });
          return result;
        } catch (error) {
          diagnostic(this.env, {
            operation,
            stage: 'sql_transaction',
            tenant: principal.tenant.type,
            durationMs: started ? performance.now() - started : 0,
            outcome: error instanceof LeaseRequired ? 'lease_required' : 'error',
            cause: error instanceof LeaseRequired ? 'none' : undefined,
            error: error instanceof LeaseRequired ? undefined : error,
          });
          if (!(error instanceof LeaseRequired)) throw error;
          reapplying = true;
          const bytes = leaseBytes(error.bytes);
          await this.markLeaseReconcile();
          const lease = await phase(
            this.env,
            operation,
            'lease_reserve',
            () =>
              this.tenantCall(() =>
                getTenantStub(this.env, principal.tenant).reserve({
                  tenant: principal.tenant,
                  sessionID,
                  bytes,
                })
              ),
            principal.tenant.type
          );
          if (!lease.ok) return lease;
          session.update(this.db, { tenant_lease: lease.value.bytes });
          await this.clearLeaseReconcile();
        }
      }
    });
  }

  private async reconcileLease(): Promise<Result<null>> {
    return this.serial(async () => {
      const meta = session.load(this.db);
      if (this.pendingRegistration) {
        if (!meta) {
          const abandoned = this.pendingRegistration;
          const released = await this.tenantCall(() =>
            getTenantStub(this.env, abandoned.tenant).release({
              tenant: abandoned.tenant,
              sessionID: abandoned.sessionID,
              bytes: 0,
            })
          );
          if (!released.ok) return released;
          if (abandoned.creatorID) {
            const forgotten = await this.tenantCall(() =>
              getTenantStub(this.env, {
                type: 'user',
                id: abandoned.creatorID ?? '',
              }).forgetCreatedSession({
                tenant: abandoned.tenant,
                sessionID: abandoned.sessionID,
                bytes: 0,
              })
            );
            if (!forgotten.ok) return forgotten;
          }
        }
        // A successful registration may have adopted the reservation before
        // its intent was cleared. Never release an admission with a session row.
        await this.ctx.storage.delete('pendingRegistration');
        this.pendingRegistration = undefined;
      }
      if (!meta) return ok(null);
      const tenant = { type: meta.tenant_type, id: meta.tenant_id } as Tenant;
      const input = { tenant, sessionID: meta.session_id, bytes: 0 };
      if (meta.deleted_at !== null && (meta.tenant_lease >= 0 || this.leaseReconcilePending)) {
        const released = await this.tenantCall(() =>
          getTenantStub(this.env, tenant).release(input)
        );
        if (!released.ok) return released;
        const forgotten = await this.tenantCall(() =>
          getTenantStub(this.env, { type: 'user', id: meta.creator_id }).forgetCreatedSession(input)
        );
        if (!forgotten.ok) return forgotten;
        session.update(this.db, { tenant_lease: -1 });
        await this.clearLeaseReconcile();
      } else if (
        this.leaseReconcilePending ||
        meta.tenant_lease - meta.blob_bytes - meta.inline_bytes >= 2 * LIMITS.tenantLeaseBytes
      ) {
        const bytes = leaseBytes(meta.blob_bytes + meta.inline_bytes);
        // Fence writes before capacity can be released by a tenant RPC whose
        // successful response may be lost. Persist the intent so an eviction
        // cannot strand the tenant's old, larger reservation either.
        await this.markLeaseReconcile();
        session.update(this.db, { tenant_lease: Math.min(meta.tenant_lease, bytes) });
        const shrunk = await this.tenantCall(() =>
          getTenantStub(this.env, tenant).reserve({ ...input, bytes })
        );
        if (!shrunk.ok) return shrunk;
        session.update(this.db, { tenant_lease: bytes });
        await this.clearLeaseReconcile();
      }
      return ok(null);
    });
  }

  async register(input: unknown): Promise<Result<{ created: boolean; state: SessionState }>> {
    const parsed = parse(registerInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, request } = parsed.value;
    return this.serial(async () => {
      const existing = session.load(this.db);
      const prior = existing
        ? this.tx(() =>
            session.register(this.db, principal, sessionID, request.sourceID, Date.now())
          )
        : null;
      if (prior && !prior.ok) return prior;
      if (!existing) {
        const pending = { tenant: principal.tenant, sessionID, creatorID: principal.userID };
        await this.ctx.storage.put('pendingRegistration', pending);
        this.pendingRegistration = pending;
        await this.scheduleSweep();
      }
      const indexed = await this.tenantCall(() =>
        getTenantStub(this.env, { type: 'user', id: principal.userID }).trackCreatedSession({
          principal,
          sessionID,
        })
      );
      if (!indexed.ok) return indexed;
      if (existing && prior?.ok) {
        const registered = prior;
        const bytes = Math.max(
          existing.tenant_lease,
          leaseBytes(existing.blob_bytes + existing.inline_bytes)
        );
        await this.markLeaseReconcile();
        const admitted = await this.tenantCall(() =>
          getTenantStub(this.env, principal.tenant).reserve({
            tenant: principal.tenant,
            sessionID,
            bytes,
          })
        );
        if (!admitted.ok) return admitted;
        session.update(this.db, { tenant_lease: bytes });
        await this.clearLeaseReconcile();
        return registered;
      }
      const admitted = await this.tenantCall(() =>
        getTenantStub(this.env, principal.tenant).reserve({
          tenant: principal.tenant,
          sessionID,
          bytes: 0,
        })
      );
      if (!admitted.ok) return admitted;
      const registered = this.tx(() =>
        session.register(this.db, principal, sessionID, request.sourceID, Date.now())
      );
      if (registered.ok) {
        await this.ctx.storage.delete('pendingRegistration');
        this.pendingRegistration = undefined;
        await this.scheduleSweep();
      }
      return registered;
    });
  }

  /** Live tickets can only be minted for a non-deleted, owner-authorized session. */
  async authorizeLive(input: unknown): Promise<Result<{ role: 'owner' }>> {
    const parsed = parse(stateInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID } = parsed.value;
    return this.serial(async () => {
      const authorized = this.tx(() => {
        session.live(this.db, principal, sessionID);
        return { role: 'owner' as const };
      });
      if (!authorized.ok || this.relayUsed) return authorized;
      // Share the deletion gate while persisting activation: a successful ticket
      // authorization must never race past a tombstone without a durable purge intent.
      await this.ctx.storage.put('relayUsed', true);
      this.relayUsed = true;
      return authorized;
    });
  }

  async getState(input: unknown): Promise<Result<SessionState>> {
    const parsed = parse(stateInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID } = parsed.value;
    const admitted = await phase(
      this.env,
      'getState',
      'rate_credit',
      () => this.dataRateLimit.admit(this.env.USER_DATA_BLOCK_LIMITER, principal.userID),
      principal.tenant.type
    );
    if (!admitted.ok) return admitted;
    return syncPhase(
      this.env,
      'getState',
      'sql_transaction',
      () => this.tx(() => session.toState(this.db, session.visible(this.db, principal, sessionID))),
      principal.tenant.type
    );
  }

  /** Applies the batch in `body`, the exact UTF-8 request text. */
  async applyBatch(input: unknown): Promise<Result<Receipt>> {
    const parsed = parse(batchInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, body } = parsed.value;
    if (body.length > LIMITS.batchBytes || utf8Bytes(body) > LIMITS.batchBytes) {
      return fail('request_too_large', `The body exceeds ${LIMITS.batchBytes} bytes`);
    }
    // Reserve conservative UTF-16 storage before the first await, including the
    // active write. Count also caps tiny/empty calls and their pending promises.
    const retainedBytes = body.length * 2;
    if (
      this.pendingBatchBytes + retainedBytes > LIMITS.batchQueueBytes ||
      this.pendingBatches >= LIMITS.batchQueueRequests
    ) {
      diagnostic(this.env, {
        operation: 'applyBatch',
        stage: 'queue_admission',
        tenant: principal.tenant.type,
        outcome: 'service_overloaded',
        cause: 'application_queue',
        queueDepth: this.pendingBatches,
        retainedBytes: this.pendingBatchBytes,
      });
      return overloaded();
    }
    this.pendingBatchBytes += retainedBytes;
    this.pendingBatches++;
    const work:
      | {
          pruneMs: number;
          pruneAttempts: number;
          pruneError?: unknown;
          validationMs: number;
          validationAttempts: number;
          validationCode?: ErrorCode;
        }
      | undefined = metricsEnabled(this.env)
      ? { pruneMs: 0, pruneAttempts: 0, validationMs: 0, validationAttempts: 0 }
      : undefined;
    try {
      const admitted = await phase(
        this.env,
        'applyBatch',
        'rate_credit',
        () => this.dataRateLimit.admit(this.env.USER_DATA_BLOCK_LIMITER, principal.userID),
        principal.tenant.type
      );
      if (!admitted.ok) return admitted;
      // Hash before the transaction: checks and writes below run synchronously.
      const digest = await phase(
        this.env,
        'applyBatch',
        'hash',
        () => sha256Hex(body),
        principal.tenant.type
      );
      const applied = await this.leased(principal, sessionID, 'applyBatch', () => {
        // Queued writes never retain parsed trees across tenant RPC I/O.
        const validationStarted = work ? performance.now() : 0;
        const batch = parseBatch(body);
        if (work) {
          work.validationMs += performance.now() - validationStarted;
          work.validationAttempts++;
          if (!batch.ok) work.validationCode = batch.error.code;
        }
        if (!batch.ok) throw new session.SyncFailure(batch.error);
        return batches.apply(this.db, principal, sessionID, batch.value, digest, Date.now(), work);
      });
      if (applied.ok)
        await phase(
          this.env,
          'applyBatch',
          'schedule',
          () => this.scheduleSweep(),
          principal.tenant.type
        );
      return applied;
    } finally {
      if (work) {
        if (work.validationAttempts > 0)
          diagnostic(this.env, {
            operation: 'applyBatch',
            stage: 'validate',
            tenant: principal.tenant.type,
            durationMs: work.validationMs,
            outcome: work.validationCode ?? 'ok',
            cause: work.validationCode ? 'typed_result' : 'none',
          });
        if (work.pruneAttempts > 0)
          diagnostic(this.env, {
            operation: 'applyBatch',
            stage: 'receipt_prune',
            tenant: principal.tenant.type,
            durationMs: work.pruneMs,
            error: work.pruneError,
          });
      }
      this.pendingBatchBytes -= retainedBytes;
      this.pendingBatches--;
    }
  }

  async readEntities(input: unknown): Promise<Result<ReadableStream<Uint8Array>>> {
    const parsed = parse(pageInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, ...query } = parsed.value;
    const admitted = await phase(
      this.env,
      'readEntities',
      'rate_credit',
      () => this.dataRateLimit.admit(this.env.USER_DATA_BLOCK_LIMITER, principal.userID),
      principal.tenant.type
    );
    if (!admitted.ok) return admitted;
    return syncPhase(
      this.env,
      'readEntities',
      'sql_transaction',
      () => this.tx(() => page.read(this.db, principal, sessionID, query)),
      principal.tenant.type
    );
  }

  async beginBlob(input: unknown): Promise<Result<blob.Begin>> {
    const parsed = parse(blobInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, blob: ref } = parsed.value;
    const begun = await this.leased(principal, sessionID, 'beginBlob', () =>
      blob.begin(this.db, principal, sessionID, ref, Date.now())
    );
    if (
      !begun.ok &&
      begun.error.code === 'upload_in_progress' &&
      this.purgeRetryAt > Number(begun.error.details?.retryAt ?? 0)
    ) {
      begun.error.details = { ...begun.error.details, retryAt: this.purgeRetryAt };
    }
    if (begun.ok || begun.error.code === 'upload_in_progress') {
      await this.scheduleSweep();
    }
    return begun;
  }

  async abortBlob(input: unknown): Promise<Result<null>> {
    const parsed = parse(attemptInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, blob: ref, attempt } = parsed.value;
    const aborted = this.tx(() => {
      blob.abort(this.db, principal, sessionID, ref.hash, attempt);
      return null;
    });
    if (aborted.ok) await this.scheduleSweep();
    return aborted;
  }

  /**
   * Verifies this attempt's object before acknowledging it. The reservation is
   * checked again after R2 I/O, so cleanup or deletion can fence the commit.
   * A rejected old attempt can delete only its own generation-specific object.
   */
  async commitBlob(input: unknown): Promise<Result<BlobAck>> {
    const parsed = parse(attemptInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, blob: ref, attempt } = parsed.value;
    const located = this.tx(() => blob.target(this.db, principal, sessionID, ref.hash, attempt));
    if (!located.ok) return located;
    const { key, deleted } = located.value;
    const bucket = this.env.SESSION_SYNC_R2;
    let r2Ms = 0;
    if (deleted) {
      const started = performance.now();
      await bucket.delete(key);
      return {
        ...fail('session_deleted', 'The session was deleted from the cloud'),
        r2Ms: performance.now() - started,
      };
    }

    const started = performance.now();
    const object = await bucket.head(key);
    r2Ms += performance.now() - started;
    const checksum = object?.checksums.sha256;
    if (!object || object.size !== ref.bytes || (checksum && toHex(checksum) !== ref.hash)) {
      const aborted = this.tx(() => blob.abort(this.db, principal, sessionID, ref.hash, attempt));
      if (aborted.ok) await this.scheduleSweep();
      return {
        ...fail('blob_missing', 'The uploaded object is missing or does not match its hash', {
          hash: ref.hash,
        }),
        r2Ms,
      };
    }
    const committed = this.tx(() =>
      blob.commit(this.db, principal, sessionID, ref, attempt, Date.now())
    );
    if (committed.ok) await this.scheduleSweep();
    if (
      !committed.ok &&
      (committed.error.code === 'session_deleted' || committed.error.code === 'upload_timeout')
    ) {
      const started = performance.now();
      await bucket.delete(key);
      r2Ms += performance.now() - started;
    }
    return { ...committed, r2Ms };
  }

  async locateBlob(input: unknown): Promise<Result<{ key: string; bytes: number }>> {
    const parsed = parse(locateInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, hash } = parsed.value;
    const admitted = await this.dataRateLimit.admit(
      this.env.USER_DATA_BLOCK_LIMITER,
      principal.userID
    );
    if (!admitted.ok) return admitted;
    return this.tx(() => blob.locate(this.db, principal, sessionID, hash));
  }

  /**
   * Tombstones before cleanup and schedules the alarm before any R2 I/O.
   * Unfinished attempts retain their cleanup deadline through deletion.
   */
  async deleteSession(input: unknown): Promise<Result<SessionState>> {
    const parsed = parse(stateInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID } = parsed.value;
    const erased = await this.serial(async () =>
      this.tx(() => erase.tombstone(this.db, principal, sessionID, Date.now()))
    );
    if (!erased.ok) return erased;
    let r2Ms = 0;
    try {
      await this.scheduleSweep();
      const purged = await this.purgeRelay();
      if (!purged.ok) return purged;
      const reconciled = await this.reconcileLease();
      if (!reconciled.ok) return reconciled;
    } finally {
      r2Ms = await this.cleanup();
    }
    return { ...ok(erased.value.state), r2Ms };
  }

  /** Internal erasure must never delete another member's session in a shared tenant. */
  async eraseForUser(input: unknown): Promise<Result<null>> {
    const parsed = parse(stateInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID } = parsed.value;
    const erased = await this.serial(async () => {
      const meta = session.load(this.db);
      if (!meta) {
        return this.tenantCall(() =>
          getTenantStub(this.env, principal.tenant).release({
            tenant: principal.tenant,
            sessionID,
            bytes: 0,
          })
        );
      }
      if (meta.creator_id !== principal.userID) return ok(null);
      const result = this.tx(() => erase.tombstone(this.db, principal, sessionID, Date.now()));
      return result.ok ? ok(null) : result;
    });
    if (!erased.ok) return erased;
    await this.scheduleSweep();
    try {
      const purged = await this.purgeRelay();
      if (!purged.ok) return purged;
      const reconciled = await this.reconcileLease();
      if (!reconciled.ok) return reconciled;
    } finally {
      await this.cleanup();
    }
    return ok(null);
  }

  override async alarm(): Promise<void> {
    try {
      await this.serial(async () => {
        const meta = session.load(this.db);
        if (meta && meta.deleted_at === null && Date.now() >= this.retentionDeadline(meta)) {
          const tenant = { type: meta.tenant_type, id: meta.tenant_id };
          const erased = this.tx(() =>
            erase.tombstone(
              this.db,
              { userID: meta.creator_id, tenant },
              meta.session_id,
              Date.now()
            )
          );
          if (!erased.ok) throw new Error(erased.error.message);
        }
      });
      const purged = await this.purgeRelay();
      await this.cleanup();
      if (!purged.ok) return;
      const reconciled = await this.reconcileLease();
      if (!reconciled.ok) await this.ctx.storage.setAlarm(Date.now() + PURGE_RETRY_MS);
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_RETRY_MS);
      throw error;
    }
  }

  /** A used relay's sync tombstone is its purge intent; persist acknowledgement after cleanup. */
  private async purgeRelay(): Promise<Result<null>> {
    return this.serial(async () => {
      const meta = session.load(this.db);
      if (!meta || meta.deleted_at === null || !this.relayUsed || this.relayPurged) return ok(null);
      if (Date.now() >= this.relayPurgeRetryAt) {
        try {
          await getRelayStub(
            this.env,
            { type: meta.tenant_type, id: meta.tenant_id },
            meta.session_id
          ).purge();
          await this.ctx.storage.put({ relayPurged: true, relayPurgeRetryAt: 0 });
          this.relayPurged = true;
          this.relayPurgeRetryAt = 0;
          return ok(null);
        } catch (error) {
          console.error('session-sync relay purge failed', {
            error: error instanceof Error ? error.name : typeof error,
          });
          this.relayPurgeRetryAt = Date.now() + PURGE_RETRY_MS;
          await this.ctx.storage.put('relayPurgeRetryAt', this.relayPurgeRetryAt);
        }
      }
      await this.scheduleSweep();
      return fail('tenant_unavailable', 'Live relay cleanup is temporarily unavailable', {
        retryAt: this.relayPurgeRetryAt,
      });
    });
  }

  /** Claims at most one bounded page before yielding, then finalizes those exact attempts. */
  private async cleanup(): Promise<number> {
    if (Date.now() < this.purgeRetryAt) {
      await this.scheduleSweep();
      return 0;
    }
    const meta = session.load(this.db);
    if (!meta) return 0;
    const claimed = this.tx(() => blob.claim(this.db, meta, Date.now()));
    if (!claimed.ok) throw new Error(claimed.error.message);
    let r2Ms = 0;
    if (claimed.value.length > 0) {
      const started = performance.now();
      try {
        await this.env.SESSION_SYNC_R2.delete(claimed.value.map(item => item.key));
        r2Ms = performance.now() - started;
      } catch (error) {
        this.logPurgeFailure(error);
        this.purgeRetryAt = Date.now() + PURGE_RETRY_MS;
        await this.ctx.storage.put('purgeRetryAt', this.purgeRetryAt);
        await this.ctx.storage.setAlarm(this.purgeRetryAt);
        return performance.now() - started;
      }
      if (this.purgeRetryAt !== 0) {
        this.purgeRetryAt = 0;
        await this.ctx.storage.delete('purgeRetryAt');
      }
      const finished = this.tx(() => blob.finish(this.db, claimed.value, Date.now()));
      if (!finished.ok) throw new Error(finished.error.message);
    }
    await this.scheduleSweep();
    return r2Ms;
  }

  private retentionDeadline(meta: session.Meta): number {
    return (meta.last_write_at || meta.updated_at) + RETENTION_MS;
  }

  private async scheduleSweep(): Promise<void> {
    const meta = session.load(this.db);
    const leaseDue =
      this.pendingRegistration ||
      (meta &&
        (this.leaseReconcilePending ||
          (meta.deleted_at !== null && meta.tenant_lease >= 0) ||
          meta.tenant_lease - meta.blob_bytes - meta.inline_bytes >= 2 * LIMITS.tenantLeaseBytes))
        ? Date.now() + PURGE_RETRY_MS
        : null;
    const nextBlobSweep = blob.nextSweep(this.db);
    const blobDue = nextBlobSweep === null ? null : Math.max(nextBlobSweep, this.purgeRetryAt);
    const relayDue =
      meta && meta.deleted_at !== null && this.relayUsed && !this.relayPurged
        ? Math.max(Date.now() + 1, this.relayPurgeRetryAt)
        : null;
    const retentionDue = meta && meta.deleted_at === null ? this.retentionDeadline(meta) : null;
    const deadlines = [blobDue, leaseDue, retentionDue, relayDue].filter(value => value !== null);
    if (deadlines.length === 0) return;
    const due = Math.min(...deadlines);
    const current = await this.ctx.storage.getAlarm();
    const scheduled = Math.max(Date.now() + 1, due);
    if (current === null || current <= Date.now() || current > scheduled) {
      await this.ctx.storage.setAlarm(scheduled);
    }
  }

  private logPurgeFailure(error: unknown): void {
    console.error('session-sync purge failed', {
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}

export function getSessionSyncDOStub(
  env: Pick<Env, 'SESSION_SYNC_DO'>,
  params: { tenant: Tenant; sessionID: string }
) {
  const name = JSON.stringify([params.tenant.type, params.tenant.id, params.sessionID]);
  return env.SESSION_SYNC_DO.get(env.SESSION_SYNC_DO.idFromName(name));
}
