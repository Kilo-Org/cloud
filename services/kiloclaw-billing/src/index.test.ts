import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    ctx: ExecutionContext;
    env: unknown;
    constructor(ctx: ExecutionContext, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('./lifecycle.js', () => ({
  runSweep: vi.fn(),
  processTrialInactivityStopCandidate: vi.fn(),
}));

vi.mock('./bootstrap.js', () => ({
  bootstrapProvisionSubscription: vi.fn(),
}));

import { handler, KiloClawBillingService } from './index.js';
import { bootstrapProvisionSubscription } from './bootstrap.js';
import { processTrialInactivityStopCandidate, runSweep } from './lifecycle.js';
import type { BillingQueueMessage, BillingWorkerEnv } from './types.js';

let loggedValues: unknown[] = [];

function findLogRecord(message: string): Record<string, unknown> | undefined {
  return loggedValues.find(
    (value: unknown) =>
      typeof value === 'object' && value !== null && 'message' in value && value.message === message
  ) as Record<string, unknown> | undefined;
}

type QueueMessage = {
  body: unknown;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

function createEnv(): {
  env: BillingWorkerEnv;
  lifecycleSend: ReturnType<typeof vi.fn>;
  trialInactivitySend: ReturnType<typeof vi.fn>;
} {
  const lifecycleSend = vi.fn(async () => undefined);
  const trialInactivitySend = vi.fn(async () => undefined);
  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgres://test' },
      LIFECYCLE_QUEUE: {
        send: lifecycleSend,
      } as unknown as BillingWorkerEnv['LIFECYCLE_QUEUE'],
      TRIAL_INACTIVITY_QUEUE: {
        send: trialInactivitySend,
        sendBatch: vi.fn(),
      } as unknown as BillingWorkerEnv['TRIAL_INACTIVITY_QUEUE'],
      KILOCLAW: {
        fetch: vi.fn(),
      },
      KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
      STRIPE_KILOCLAW_COMMIT_PRICE_ID: 'price_commit',
      STRIPE_KILOCLAW_STANDARD_PRICE_ID: 'price_standard',
      STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID: 'price_standard_intro',
      INTERNAL_API_SECRET: 'next-internal-api-secret',
      KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
      TRIAL_INACTIVITY_STOP_ENABLED: 'false',
      TRIAL_INACTIVITY_STOP_DRY_RUN: 'true',
    },
    lifecycleSend,
    trialInactivitySend,
  };
}

function createBatch(message: QueueMessage): MessageBatch<BillingQueueMessage> {
  return {
    queue: 'kiloclaw-billing-lifecycle',
    messages: [message as unknown as Message<BillingQueueMessage>],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<BillingQueueMessage>;
}

describe('kiloclaw billing worker handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loggedValues = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
    const emptySummary = {
      credit_renewals: 0,
      credit_renewals_canceled: 0,
      credit_renewals_past_due: 0,
      credit_renewals_auto_top_up: 0,
      credit_renewals_skipped_duplicate: 0,
      interrupted_auto_resume_requests: 0,
      trial_inactivity_candidates: 0,
      trial_inactivity_batches: 0,
      trial_inactivity_batch_fallbacks: 0,
      trial_inactivity_stop_messages_enqueued: 0,
      trial_inactivity_stops: 0,
      trial_inactivity_dry_run_candidates: 0,
      trial_warnings: 0,
      earlybird_warnings: 0,
      sweep1_trial_expiry: 0,
      sweep2_subscription_expiry: 0,
      destruction_warnings: 0,
      sweep3_instance_destruction: 0,
      sweep4_past_due_cleanup: 0,
      sweep5_intro_schedules_repaired: 0,
      complementary_inference_ended_emails: 0,
      emails_sent: 0,
      emails_skipped: 0,
      errors: 0,
    };
    vi.mocked(runSweep).mockResolvedValue(emptySummary);
    vi.mocked(processTrialInactivityStopCandidate).mockResolvedValue(emptySummary);
  });

  it('enqueues the first lifecycle sweep on the hourly cron', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();

    await handler.scheduled?.(
      { cron: '0 * * * *' } as ScheduledController,
      env,
      {} as ExecutionContext
    );

    expect(lifecycleSend).toHaveBeenCalledTimes(1);
    expect(lifecycleSend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'lifecycle', sweep: 'credit_renewal' })
    );
    expect(trialInactivitySend).not.toHaveBeenCalled();
  });

  it('enqueues the daily trial inactivity run on the daily cron when enabled', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();
    env.TRIAL_INACTIVITY_STOP_ENABLED = 'true';

    await handler.scheduled?.(
      { cron: '0 8 * * *' } as ScheduledController,
      env,
      {} as ExecutionContext
    );

    expect(trialInactivitySend).toHaveBeenCalledTimes(1);
    expect(trialInactivitySend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'trial_inactivity_stop', sweep: 'trial_inactivity_stop' })
    );
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(findLogRecord('Enqueued daily trial inactivity kickoff')).toMatchObject({
      event: 'run_started',
      outcome: 'started',
      dryRun: true,
    });
  });

  it('logs and skips the daily trial inactivity cron when disabled', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();

    await handler.scheduled?.(
      { cron: '0 8 * * *' } as ScheduledController,
      env,
      {} as ExecutionContext
    );

    expect(trialInactivitySend).not.toHaveBeenCalled();
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(
      findLogRecord('Skipping daily trial inactivity kickoff because feature is disabled')
    ).toMatchObject({
      event: 'run_skipped',
      outcome: 'discarded',
      cron: '0 8 * * *',
    });
  });

  it('acks invalid queue messages', async () => {
    const { env } = createEnv();
    const message = {
      body: { kind: 'lifecycle', runId: 'not-a-uuid', sweep: 'credit_renewal' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it('chains the next sweep after a successful queue run', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '11111111-1111-4111-8111-111111111111';
    const message = {
      body: { kind: 'lifecycle', runId, sweep: 'credit_renewal' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).toHaveBeenCalledWith(
      env,
      { kind: 'lifecycle', runId, sweep: 'credit_renewal' },
      1
    );
    expect(lifecycleSend).toHaveBeenLastCalledWith({
      kind: 'lifecycle',
      runId,
      sweep: 'interrupted_auto_resume',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries queue messages when sweep execution throws', async () => {
    const { env } = createEnv();
    vi.mocked(runSweep).mockRejectedValueOnce(new Error('boom'));
    const message = {
      body: {
        kind: 'lifecycle',
        runId: '11111111-1111-4111-8111-111111111111',
        sweep: 'credit_renewal',
      },
      attempts: 2,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('does not enqueue a next sweep after the final sweep', async () => {
    const { env, lifecycleSend } = createEnv();
    const message = {
      body: {
        kind: 'lifecycle',
        runId: '11111111-1111-4111-8111-111111111111',
        sweep: 'complementary_inference_ended',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    const record = findLogRecord('Completed billing lifecycle run');

    expect(record).toMatchObject({
      event: 'run_completed',
      outcome: 'completed',
    });

    const tags = record?.tags;
    expect(tags).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'worker',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        billingSweep: 'complementary_inference_ended',
        billingAttempt: 1,
      })
    );
  });

  it('does not enqueue a follow-up message after a trial inactivity coordinator run', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();
    const message = {
      body: {
        kind: 'trial_inactivity_stop',
        runId: '22222222-2222-4222-8222-222222222222',
        sweep: 'trial_inactivity_stop',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).toHaveBeenCalledWith(
      env,
      {
        kind: 'trial_inactivity_stop',
        runId: '22222222-2222-4222-8222-222222222222',
        sweep: 'trial_inactivity_stop',
      },
      1
    );
    expect(processTrialInactivityStopCandidate).not.toHaveBeenCalled();
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(trialInactivitySend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(findLogRecord('Completed daily trial inactivity run')).toMatchObject({
      event: 'run_completed',
      outcome: 'completed',
    });
  });

  it('processes trial inactivity stop candidate messages without chaining follow-up work', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();
    const message = {
      body: {
        kind: 'trial_inactivity_stop_candidate',
        runId: '33333333-3333-4333-8333-333333333333',
        sweep: 'trial_inactivity_stop_candidate',
        subscriptionId: '44444444-4444-4444-8444-444444444444',
        userId: 'user-1',
        instanceId: '55555555-5555-4555-8555-555555555555',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processTrialInactivityStopCandidate).toHaveBeenCalledWith(
      env,
      {
        kind: 'trial_inactivity_stop_candidate',
        runId: '33333333-3333-4333-8333-333333333333',
        sweep: 'trial_inactivity_stop_candidate',
        subscriptionId: '44444444-4444-4444-8444-444444444444',
        userId: 'user-1',
        instanceId: '55555555-5555-4555-8555-555555555555',
      },
      1
    );
    expect(runSweep).not.toHaveBeenCalled();
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(trialInactivitySend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(findLogRecord('Completed trial inactivity stop candidate')).toMatchObject({
      event: 'run_completed',
      outcome: 'completed',
      subscriptionId: '44444444-4444-4444-8444-444444444444',
      userId: 'user-1',
      instanceId: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('bootstrapProvisionSubscription RPC delegates to bootstrap module and returns subscriptionId', async () => {
    vi.mocked(bootstrapProvisionSubscription).mockResolvedValueOnce({
      id: 'sub-bootstrap',
    } as Awaited<ReturnType<typeof bootstrapProvisionSubscription>>);
    const { env } = createEnv();
    const service = new KiloClawBillingService({} as ExecutionContext, env);

    const result = await service.bootstrapProvisionSubscription({
      userId: 'user-1',
      instanceId: '11111111-1111-4111-8111-111111111111',
      orgId: null,
    });

    expect(result).toEqual({ subscriptionId: 'sub-bootstrap' });
    expect(bootstrapProvisionSubscription).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        userId: 'user-1',
        instanceId: '11111111-1111-4111-8111-111111111111',
        orgId: null,
      })
    );
  });

  it('bootstrapProvisionSubscription RPC rejects invalid input with Zod error', async () => {
    const { env } = createEnv();
    const service = new KiloClawBillingService({} as ExecutionContext, env);

    await expect(
      service.bootstrapProvisionSubscription({
        userId: '',
        instanceId: 'not-a-uuid',
        orgId: null,
      })
    ).rejects.toThrow();
    expect(bootstrapProvisionSubscription).not.toHaveBeenCalled();
  });

  it('logs a terminal run failure before DLQ on the last retry', async () => {
    const { env } = createEnv();
    vi.mocked(runSweep).mockRejectedValueOnce(new Error('boom'));
    const message = {
      body: {
        kind: 'lifecycle',
        runId: '11111111-1111-4111-8111-111111111111',
        sweep: 'credit_renewal',
      },
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);
    const record = findLogRecord('Billing lifecycle run failed before DLQ');

    expect(record).toMatchObject({
      event: 'run_failed',
      outcome: 'failed',
      willGoToDlq: true,
    });

    const tags = record?.tags;
    expect(tags).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'worker',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        billingSweep: 'credit_renewal',
        billingAttempt: 3,
      })
    );
  });
});
