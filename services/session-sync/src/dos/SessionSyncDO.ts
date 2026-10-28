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
import * as blob from './session-sync/blob';
import * as erase from './session-sync/erase';
import * as page from './session-sync/page';
import * as session from './session-sync/session';

const PURGE_RETRY_MS = 60_000;

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
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

  async register(input: unknown): Promise<Result<{ created: boolean; state: SessionState }>> {
    const parsed = parse(registerInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, request } = parsed.value;
    return this.tx(() =>
      session.register(this.db, principal, sessionID, request.sourceID, Date.now())
    );
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
    return this.tx(() =>
      batches.apply(this.db, principal, sessionID, batch.value, digest, Date.now())
    );
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
    const begun = this.tx(() => blob.begin(this.db, principal, sessionID, ref, Date.now()));
    if (begun.ok && begun.value.status === 'upload') await this.scheduleSweep();
    return begun;
  }

  async abortBlob(input: unknown): Promise<Result<null>> {
    const parsed = parse(attemptInput, input);
    if (!parsed.ok) return parsed;
    const { principal, sessionID, blob: ref, attempt } = parsed.value;
    return this.tx(() => {
      blob.abort(this.db, principal, sessionID, ref.hash, attempt);
      return null;
    });
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
    if (deleted) {
      await bucket.delete(key);
      return fail('session_deleted', 'The session was deleted from the cloud');
    }

    const object = await bucket.head(key);
    const checksum = object?.checksums.sha256;
    if (!object || object.size !== ref.bytes || (checksum && toHex(checksum) !== ref.hash)) {
      this.tx(() => blob.abort(this.db, principal, sessionID, ref.hash, attempt));
      return fail('blob_missing', 'The uploaded object is missing or does not match its hash', {
        hash: ref.hash,
      });
    }
    const committed = this.tx(() =>
      blob.commit(this.db, principal, sessionID, ref, attempt, Date.now())
    );
    if (
      !committed.ok &&
      (committed.error.code === 'session_deleted' || committed.error.code === 'upload_timeout')
    ) {
      await bucket.delete(key);
    }
    return committed;
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
    const erased = this.tx(() => erase.tombstone(this.db, principal, sessionID, Date.now()));
    if (!erased.ok) return erased;
    await this.scheduleSweep();
    await this.cleanup();
    return ok(erased.value.state);
  }

  override async alarm(): Promise<void> {
    await this.cleanup();
  }

  /** Claims at most one bounded page before yielding, then finalizes those exact attempts. */
  private async cleanup(): Promise<void> {
    const meta = session.load(this.db);
    if (!meta) return;
    const claimed = this.tx(() => blob.claim(this.db, meta, Date.now()));
    if (!claimed.ok) throw new Error(claimed.error.message);
    if (claimed.value.length > 0) {
      try {
        await this.env.SESSION_SYNC_R2.delete(claimed.value.map(item => item.key));
      } catch (error) {
        this.logPurgeFailure(error);
        await this.ctx.storage.setAlarm(Date.now() + PURGE_RETRY_MS);
        return;
      }
      const finished = this.tx(() => blob.finish(this.db, claimed.value, Date.now()));
      if (!finished.ok) throw new Error(finished.error.message);
    }
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    const due = blob.nextSweep(this.db);
    if (due === null) return;
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
