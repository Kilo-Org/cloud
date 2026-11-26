import { encodeAuditBatch } from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { identityStoreOutbox } from '../audit/outbox';
import { auditStreamName, relayShard, type RelayRunResult } from '../audit/relay';
import {
  classifyRelayFailure,
  nextRelayRun,
  type NextRelayRun,
  type RelayRunOutcome,
} from '../audit/relay-schedule';
import { withIdentityStore } from '../db/client';
import { readConfig, type Env, type UtsConfig } from '../env';
import { identityStoreBinding } from '../grants/binding';
import { auditShardOfObjectId } from './stubs';

/**
 * The count of failed runs in a row lives in storage, not memory: the runtime evicts an idle
 * object between alarms, and the cron's minute call wakes it again, so a count in memory would
 * restart the backoff at 5 s after every eviction. Steady state writes nothing; a failure writes
 * the count, and the first good run after failures deletes it.
 */
const FAILED_RUNS_KEY = 'failed-runs';
const FailedRunsSchema = z.number().int().nonnegative();

type Phase =
  | { status: 'relaying'; shard: number; stream: string }
  | { status: 'refused'; reason: string };

function logOutcome(stream: string, outcome: RelayRunOutcome, next: NextRelayRun): void {
  if (outcome.kind === 'ran') {
    if (outcome.result.sent === 0) return;
    console.log(
      JSON.stringify({
        event: 'uts.audit_relay.sent',
        stream,
        rows: outcome.result.sent,
        status: outcome.result.status,
      })
    );
    return;
  }
  const { failure } = outcome;
  if (failure.kind === 'superseded') {
    console.warn(JSON.stringify({ event: 'uts.audit_relay.superseded', stream }));
    return;
  }
  console.error(
    JSON.stringify({
      event: 'uts.audit_relay.failed',
      stream,
      failure: failure.kind,
      reason: failure.reason,
      failedRuns: next.failedRuns,
      retryInMs: next.delayMs,
    })
  );
}

/**
 * The relay for one audit shard, named `<environment>:audit-relay:<0-7>`, in the `eu`
 * jurisdiction like every UTS object. Its alarm is the relay loop: a run every 5 seconds, at once
 * again after a run that stopped at its read budget, and with backoff after a failure
 * (`src/audit/relay-schedule.ts`). One object owns each shard; the watermark's compare-and-set
 * keeps a shard correct even if two runs overlap across a deploy. It stores only its count of
 * failed runs in a row; the watermark lives in the identity store. The cron (`src/scheduled.ts`)
 * calls `ensureStarted` every minute, which arms a missing alarm.
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

    const failedBefore = FailedRunsSchema.parse((await this.ctx.storage.get(FAILED_RUNS_KEY)) ?? 0);
    let outcome: RelayRunOutcome;
    try {
      outcome = { kind: 'ran', result: await this.#run(phase, binding.connectionString) };
    } catch (error) {
      outcome = { kind: 'failed', failure: classifyRelayFailure(error) };
    }
    const next = nextRelayRun(outcome, failedBefore);
    if (next.failedRuns === 0 && failedBefore > 0) await this.ctx.storage.delete(FAILED_RUNS_KEY);
    if (next.failedRuns > failedBefore)
      await this.ctx.storage.put(FAILED_RUNS_KEY, next.failedRuns);
    logOutcome(phase.stream, outcome, next);
    await this.ctx.storage.setAlarm(Date.now() + next.delayMs);
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
