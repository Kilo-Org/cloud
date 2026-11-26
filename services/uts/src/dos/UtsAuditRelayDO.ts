import { encodeAuditBatch } from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { identityStoreOutbox } from '../audit/outbox';
import {
  AuditRowTooLargeError,
  auditStreamName,
  relayShard,
  WatermarkMovedError,
  type RelayRunResult,
} from '../audit/relay';
import { IdentityStoreError, withIdentityStore } from '../db/client';
import { readConfig, type Env, type UtsConfig } from '../env';
import { identityStoreBinding } from '../grants/binding';
import { auditShardOfObjectId } from './stubs';

/** A run that found nothing, or sent everything it found, runs again after this (design 8.1). */
export const RELAY_INTERVAL_MS = 5_000;
/** After a retryable failure: 5 s doubling per failed run, capped here. */
export const RELAY_MAX_BACKOFF_MS = 60_000;

type Phase =
  | { status: 'relaying'; shard: number; stream: string; failedRuns: number }
  | { status: 'refused'; reason: string };

/** What a run's failure means for the next run. */
type Failure =
  | { kind: 'retryable'; reason: string }
  | { kind: 'superseded' }
  | { kind: 'permanent'; reason: string };

function classify(error: unknown): Failure {
  if (error instanceof WatermarkMovedError) return { kind: 'superseded' };
  if (error instanceof AuditRowTooLargeError) return { kind: 'permanent', reason: error.name };
  if (error instanceof IdentityStoreError) {
    const reason = error.message;
    return error.failure === 'retryable'
      ? { kind: 'retryable', reason }
      : { kind: 'permanent', reason };
  }
  // A queue send that threw: the queue may or may not hold the message, and a resend is deduped.
  return { kind: 'retryable', reason: error instanceof Error ? error.name : 'unknown' };
}

/**
 * The relay for one audit shard, named `<environment>:audit-relay:<0-7>`, in the `eu`
 * jurisdiction like every UTS object. Its alarm is the relay loop: a run every 5 seconds, at once
 * again after a run that stopped at its read budget, and with backoff after a failure. One object
 * owns each shard; the watermark's compare-and-set keeps a shard correct even if two runs overlap
 * across a deploy. It stores nothing: the watermark lives in the identity store. The cron
 * (`src/scheduled.ts`) calls `ensureStarted` every minute, which arms a missing alarm.
 */
export class UtsAuditRelayDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  readonly #phase: Phase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    const id = auditShardOfObjectId(this.#config, ctx.id);
    if (id.status === 'refused') {
      console.error(JSON.stringify({ event: 'uts.audit_relay.refused', reason: id.reason }));
      this.#phase = id;
    } else {
      this.#phase = {
        status: 'relaying',
        shard: id.index,
        stream: auditStreamName(this.#config.environment, id.index),
        failedRuns: 0,
      };
    }
  }

  /** Arms the relay loop unless it runs already. `false` for a refused object. */
  async ensureStarted(): Promise<boolean> {
    if (this.#phase.status === 'refused') return false;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  override async alarm(): Promise<void> {
    const phase = this.#phase;
    if (phase.status === 'refused') return;
    const binding = identityStoreBinding(this.env);
    // The cron starts no relay without a bound identity store, so this only follows an unbind.
    if (binding.kind === 'unprovisioned') return;

    let delay: number;
    try {
      const result = await this.#run(phase, binding.connectionString);
      phase.failedRuns = 0;
      delay = result.status === 'more' ? 0 : RELAY_INTERVAL_MS;
      if (result.sent > 0) {
        console.log(
          JSON.stringify({
            event: 'uts.audit_relay.sent',
            stream: phase.stream,
            rows: result.sent,
            status: result.status,
          })
        );
      }
    } catch (error) {
      const failure = classify(error);
      if (failure.kind === 'superseded') {
        console.warn(JSON.stringify({ event: 'uts.audit_relay.superseded', stream: phase.stream }));
        delay = RELAY_INTERVAL_MS;
      } else {
        phase.failedRuns += 1;
        delay =
          failure.kind === 'permanent'
            ? RELAY_MAX_BACKOFF_MS
            : Math.min(RELAY_INTERVAL_MS * 2 ** (phase.failedRuns - 1), RELAY_MAX_BACKOFF_MS);
        console.error(
          JSON.stringify({
            event: 'uts.audit_relay.failed',
            stream: phase.stream,
            failure: failure.kind,
            reason: failure.reason,
            failedRuns: phase.failedRuns,
            retryInMs: delay,
          })
        );
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async #run(
    phase: Extract<Phase, { status: 'relaying' }>,
    connectionString: string
  ): Promise<RelayRunResult> {
    const queue = this.env.AUDIT_QUEUE;
    return await withIdentityStore(connectionString, this.ctx, store =>
      relayShard({
        outbox: identityStoreOutbox(store),
        shard: phase.shard,
        stream: phase.stream,
        send: async batch => {
          await queue.send(await encodeAuditBatch(batch), { contentType: 'bytes' });
        },
      })
    );
  }
}
