import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, isNotNull, min } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../drizzle/migrations';
import { pendingUsageMutations, rejectedStartAdmissions } from './db/sqlite-schema';
import {
  failoverMutationSchema,
  serializeFailoverPayload,
  startAdmissionSchema,
  type DurableStartAdmissionResult,
  type ExistingStartAdmissionResult,
  type FailoverBacklog,
  type FailoverEnqueueResult,
  type FailoverMutation,
  type FailoverMutationStatus,
  type StartAdmission,
} from './failover-contract';

const INITIAL_DRAIN_DELAY_MS = 30_000;

export class FailoverBufferDO extends DurableObject<Cloudflare.Env> {
  private readonly db: DrizzleSqliteDODatabase;

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env);
    this.db = drizzle(state.storage, { logger: false });
    void state.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  getMutationStatus(input: FailoverMutation): FailoverMutationStatus {
    const mutation = failoverMutationSchema.parse(input);
    const existing = this.db
      .select({
        operation: pendingUsageMutations.operation,
        intervalId: pendingUsageMutations.interval_id,
        payload: pendingUsageMutations.payload,
      })
      .from(pendingUsageMutations)
      .where(eq(pendingUsageMutations.idempotency_key, mutation.idempotencyKey))
      .get();
    if (!existing) return 'absent';
    return existing.operation === mutation.operation &&
      existing.intervalId === mutation.intervalId &&
      existing.payload === serializeFailoverPayload(mutation.payload)
      ? 'match'
      : 'conflict';
  }

  getStartAdmission(input: FailoverMutation): ExistingStartAdmissionResult {
    const mutation = failoverMutationSchema.parse(input);
    const mutationStatus = this.getMutationStatus(mutation);
    if (mutationStatus === 'match') return { status: 'accepted', dedup: true };
    if (mutationStatus === 'conflict') return { status: 'conflict' };
    const payload = serializeFailoverPayload(mutation.payload);
    const rejected = this.db
      .select({
        intervalId: rejectedStartAdmissions.interval_id,
        payload: rejectedStartAdmissions.payload,
        code: rejectedStartAdmissions.error_code,
        message: rejectedStartAdmissions.error_message,
      })
      .from(rejectedStartAdmissions)
      .where(eq(rejectedStartAdmissions.idempotency_key, mutation.idempotencyKey))
      .get();
    if (!rejected) return { status: 'absent' };
    if (rejected.intervalId !== mutation.intervalId || rejected.payload !== payload) {
      return { status: 'conflict' };
    }
    return { status: 'rejected', code: rejected.code, message: rejected.message };
  }

  async admitStart(
    input: FailoverMutation,
    admissionInput: StartAdmission
  ): Promise<DurableStartAdmissionResult> {
    const mutation = failoverMutationSchema.parse(input);
    if (mutation.operation !== 'start')
      throw new Error('Start admission requires a start mutation');
    const admission = startAdmissionSchema.parse(admissionInput);
    const payload = serializeFailoverPayload(mutation.payload);
    const existing = this.getStartAdmission(mutation);
    if (existing.status !== 'absent') return existing;

    if (!admission.accepted) {
      this.db
        .insert(rejectedStartAdmissions)
        .values({
          idempotency_key: mutation.idempotencyKey,
          interval_id: mutation.intervalId,
          payload,
          error_code: admission.code,
          error_message: admission.message,
          decided_at_ms: mutation.receivedAtMs,
        })
        .run();
      return { status: 'rejected', code: admission.code, message: admission.message };
    }

    const result = await this.enqueue(mutation);
    if (result.conflict) return { status: 'conflict' };
    return { status: 'accepted', dedup: result.dedup };
  }

  async enqueue(input: FailoverMutation): Promise<FailoverEnqueueResult> {
    const mutation = failoverMutationSchema.parse(input);
    const payload = serializeFailoverPayload(mutation.payload);
    if (mutation.contextFingerprint) {
      const existingContext = this.db
        .select({ contextFingerprint: pendingUsageMutations.context_fingerprint })
        .from(pendingUsageMutations)
        .where(
          and(
            eq(pendingUsageMutations.interval_id, mutation.intervalId),
            isNotNull(pendingUsageMutations.context_fingerprint)
          )
        )
        .limit(1)
        .get();
      if (
        existingContext?.contextFingerprint &&
        existingContext.contextFingerprint !== mutation.contextFingerprint
      ) {
        return { dedup: false, conflict: true };
      }
    }
    const inserted = this.db
      .insert(pendingUsageMutations)
      .values({
        idempotency_key: mutation.idempotencyKey,
        operation: mutation.operation,
        interval_id: mutation.intervalId,
        context_fingerprint: mutation.contextFingerprint,
        payload,
        received_at_ms: mutation.receivedAtMs,
        next_attempt_at_ms: mutation.receivedAtMs + INITIAL_DRAIN_DELAY_MS,
      })
      .onConflictDoNothing({ target: pendingUsageMutations.idempotency_key })
      .returning({ id: pendingUsageMutations.id })
      .get();

    if (inserted === undefined) {
      const existing = this.db
        .select({
          operation: pendingUsageMutations.operation,
          intervalId: pendingUsageMutations.interval_id,
          payload: pendingUsageMutations.payload,
        })
        .from(pendingUsageMutations)
        .where(eq(pendingUsageMutations.idempotency_key, mutation.idempotencyKey))
        .get();
      if (
        !existing ||
        existing.operation !== mutation.operation ||
        existing.intervalId !== mutation.intervalId ||
        existing.payload !== payload
      ) {
        return { dedup: false, conflict: true };
      }
    }

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + INITIAL_DRAIN_DELAY_MS);
    }
    return { dedup: inserted === undefined };
  }

  async getBacklog(): Promise<FailoverBacklog> {
    const row = this.db
      .select({
        count: count(),
        oldestReceivedAtMs: min(pendingUsageMutations.received_at_ms),
      })
      .from(pendingUsageMutations)
      .get();
    return {
      count: row?.count ?? 0,
      oldestReceivedAtMs: row?.oldestReceivedAtMs ?? undefined,
    };
  }

  async alarm(): Promise<void> {
    const backlog = await this.getBacklog();
    console.warn(
      JSON.stringify({
        message: 'Container usage failover drain is pending Phase 1',
        event: 'failover_drain_deferred',
        ...backlog,
      })
    );
  }
}
