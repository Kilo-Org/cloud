import { sha256Hex } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle/migrations';
import type { Env } from '../env';
import { toHex } from '../hex';
import {
  LIMITS,
  batchRequestSchema,
  blobRefSchema,
  cursorSchema,
  fail,
  hashSchema,
  ok,
  principalSchema,
  registerRequestSchema,
  sessionIDSchema,
  utf8Bytes,
  type BlobAck,
  type Receipt,
  type Result,
  type SessionState,
  type Tenant,
} from '../protocol';
import * as batches from './session-sync/batch';
import { getTenantStub } from './SessionSyncTenantDO';
import * as blob from './session-sync/blob';
import * as erase from './session-sync/erase';
import * as page from './session-sync/page';
import * as session from './session-sync/session';

const PURGE_RETRY_MS = 60_000;
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
  if (utf8Bytes(body) > LIMITS.batchBytes) {
    return fail('request_too_large', `The body exceeds ${LIMITS.batchBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return fail('invalid_request', 'The body is not valid JSON');
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
  private purgeRetryAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      this.purgeRetryAt = (await ctx.storage.get<number>('purgeRetryAt')) ?? 0;
      await this.scheduleSweep();
    });
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
    await prior;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  private async tenantCall<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await fn();
    } catch (error) {
      console.error('session-sync tenant admission failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
      return fail('tenant_unavailable', 'Tenant admission is temporarily unavailable', {
        retryAt: Date.now() + PURGE_RETRY_MS,
      });
    }
  }

  /** Rolls back an over-lease mutation before obtaining capacity outside SQLite. */
  private async leased<T>(
    principal: z.infer<typeof principalSchema>,
    sessionID: string,
    fn: () => T
  ): Promise<Result<T>> {
    return this.serial(async () => {
      for (;;) {
        try {
          return this.tx(() => {
            const value = fn();
            const meta = session.load(this.db);
            if (meta && meta.blob_bytes + meta.inline_bytes > meta.tenant_lease) {
              throw new LeaseRequired(meta.blob_bytes + meta.inline_bytes);
            }
            return value;
          });
        } catch (error) {
          if (!(error instanceof LeaseRequired)) throw error;
          const bytes = Math.min(
            LIMITS.sessionBlobBytes + LIMITS.sessionInlineBytes,
            Math.ceil(error.bytes / LIMITS.tenantLeaseBytes) * LIMITS.tenantLeaseBytes
          );
          const lease = await this.tenantCall(() =>
            getTenantStub(this.env, principal.tenant).reserve({
              tenant: principal.tenant,
              sessionID,
              bytes,
            })
          );
          if (!lease.ok) return lease;
          session.update(this.db, { tenant_lease: lease.value.bytes });
        }
      }
    });
  }

  private async reconcileLease(): Promise<Result<null>> {
    return this.serial(async () => {
      const meta = session.load(this.db);
      if (!meta) return ok(null);
      const tenant = { type: meta.tenant_type, id: meta.tenant_id } as Tenant;
      const input = { tenant, sessionID: meta.session_id, bytes: 0 };
      if (meta.deleted_at !== null && meta.tenant_lease >= 0) {
        const released = await this.tenantCall(() =>
          getTenantStub(this.env, tenant).release(input)
        );
        if (!released.ok) return released;
        session.update(this.db, { tenant_lease: -1 });
      } else if (
        meta.tenant_lease - meta.blob_bytes - meta.inline_bytes >=
        2 * LIMITS.tenantLeaseBytes
      ) {
        const bytes =
          Math.ceil((meta.blob_bytes + meta.inline_bytes) / LIMITS.tenantLeaseBytes) *
          LIMITS.tenantLeaseBytes;
        const shrunk = await this.tenantCall(() =>
          getTenantStub(this.env, tenant).reserve({ ...input, bytes })
        );
        if (!shrunk.ok) return shrunk;
        session.update(this.db, { tenant_lease: bytes });
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
      if (existing) {
        const registered = this.tx(() =>
          session.register(this.db, principal, sessionID, request.sourceID, Date.now())
        );
        if (!registered.ok) return registered;
        const bytes = Math.max(
          existing.tenant_lease,
          Math.ceil((existing.blob_bytes + existing.inline_bytes) / LIMITS.tenantLeaseBytes) *
            LIMITS.tenantLeaseBytes
        );
        const admitted = await this.tenantCall(() =>
          getTenantStub(this.env, principal.tenant).reserve({
            tenant: principal.tenant,
            sessionID,
            bytes,
          })
        );
        if (!admitted.ok) return admitted;
        session.update(this.db, { tenant_lease: bytes });
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
      return this.tx(() =>
        session.register(this.db, principal, sessionID, request.sourceID, Date.now())
      );
    });
  }

  async getState(input: unknown): Promise<Result<SessionState>> {
    const parsed = parse(stateInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID } = parsed.value;
    return this.tx(() => session.toState(this.db, session.visible(this.db, principal, sessionID)));
  }

  /** Applies the batch in `body`, the exact UTF-8 request text. */
  async applyBatch(input: unknown): Promise<Result<Receipt>> {
    const parsed = parse(batchInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, body } = parsed.value;
    const batch = parseBatch(body);
    if (!batch.ok) return batch;
    // Hash before the transaction: every check and write below runs synchronously.
    const digest = await sha256Hex(body);
    const applied = await this.leased(principal, sessionID, () =>
      batches.apply(this.db, principal, sessionID, batch.value, digest, Date.now())
    );
    if (applied.ok) await this.scheduleSweep();
    return applied;
  }

  async readEntities(input: unknown): Promise<Result<string>> {
    const parsed = parse(pageInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, ...query } = parsed.value;
    return this.tx(() => JSON.stringify(page.read(this.db, principal, sessionID, query)));
  }

  async beginBlob(input: unknown): Promise<Result<blob.Begin>> {
    const parsed = parse(blobInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, blob: ref } = parsed.value;
    const begun = await this.leased(principal, sessionID, () =>
      blob.begin(this.db, principal, sessionID, ref, Date.now())
    );
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
      const reconciled = await this.reconcileLease();
      if (!reconciled.ok) return reconciled;
    } finally {
      r2Ms = await this.cleanup();
    }
    return { ...ok(erased.value.state), r2Ms };
  }

  override async alarm(): Promise<void> {
    try {
      await this.cleanup();
      const reconciled = await this.reconcileLease();
      if (!reconciled.ok) await this.ctx.storage.setAlarm(Date.now() + PURGE_RETRY_MS);
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_RETRY_MS);
      throw error;
    }
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

  private async scheduleSweep(): Promise<void> {
    const meta = session.load(this.db);
    const leaseDue =
      meta &&
      ((meta.deleted_at !== null && meta.tenant_lease >= 0) ||
        meta.tenant_lease - meta.blob_bytes - meta.inline_bytes >= 2 * LIMITS.tenantLeaseBytes)
        ? Date.now() + PURGE_RETRY_MS
        : null;
    const blobDue = blob.nextSweep(this.db);
    const due =
      blobDue === null ? leaseDue : leaseDue === null ? blobDue : Math.min(blobDue, leaseDue);
    if (due === null) return;
    const current = await this.ctx.storage.getAlarm();
    const scheduled = Math.max(Date.now() + 1, due, this.purgeRetryAt);
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
