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
  processCreditRenewalDiscovery: vi.fn(),
  processCreditRenewalItem: vi.fn(),
  processOrganizationTrialExpiryPage: vi.fn(),
  processTrialExpiryPage: vi.fn(),
  recordCreditRenewalTerminalFailure: vi.fn(),
}));

vi.mock('./bootstrap.js', () => ({
  bootstrapProvisionSubscription: vi.fn(),
}));

import { handler, KiloClawBillingService } from './index.js';
import { bootstrapProvisionSubscription } from './bootstrap.js';
import {
  processCreditRenewalDiscovery,
  processCreditRenewalItem,
  processOrganizationTrialExpiryPage,
  processTrialExpiryPage,
  processTrialInactivityStopCandidate,
  recordCreditRenewalTerminalFailure,
  runSweep,
} from './lifecycle.js';
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
      STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID: 'price_legacy_standard_intro',
      STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID: 'price_legacy_standard',
      STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID: 'price_legacy_commit',
      STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID: 'price_current_standard',
      STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID: 'price_current_commit',
      INTERNAL_API_SECRET: 'internal-api-secret',
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
      organization_trial_expiry_suspensions: 0,
      organization_trial_entitlement_recoveries: 0,
      sweep2_subscription_expiry: 0,
      destruction_warnings: 0,
      organization_destruction_warnings: 0,
      sweep3_instance_destruction: 0,
      organization_instance_destructions: 0,
      sweep4_past_due_cleanup: 0,
      sweep5_intro_schedules_repaired: 0,
      complementary_inference_ended_emails: 0,
      emails_sent: 0,
      emails_skipped: 0,
      errors: 0,
    };
    vi.mocked(runSweep).mockResolvedValue(emptySummary);
    vi.mocked(processTrialInactivityStopCandidate).mockResolvedValue(emptySummary);
    vi.mocked(processCreditRenewalDiscovery).mockResolvedValue(emptySummary);
    vi.mocked(processCreditRenewalItem).mockResolvedValue(emptySummary);
    vi.mocked(processTrialExpiryPage).mockResolvedValue({
      summary: emptySummary,
      continuationEnqueued: false,
    });
    vi.mocked(processOrganizationTrialExpiryPage).mockResolvedValue({
      summary: emptySummary,
      continuationEnqueued: false,
    });
    vi.mocked(recordCreditRenewalTerminalFailure).mockResolvedValue(undefined);
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

  it('enqueues standalone instance destruction on the quarter-hourly cron', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();

    await handler.scheduled?.(
      { cron: '5,20,35,50 * * * *' } as ScheduledController,
      env,
      {} as ExecutionContext
    );

    expect(lifecycleSend).toHaveBeenCalledTimes(1);
    expect(lifecycleSend).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'standalone_instance_destruction',
        sweep: 'instance_destruction',
      })
    );
    expect(trialInactivitySend).not.toHaveBeenCalled();

    const record = findLogRecord('Enqueued standalone instance destruction sweep');
    expect(record).toMatchObject({
      event: 'run_started',
      outcome: 'started',
      cron: '5,20,35,50 * * * *',
    });
    expect(record?.tags).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'worker',
        billingSweep: 'instance_destruction',
      })
    );
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

  it('logs and ignores unknown cron triggers', async () => {
    const { env, lifecycleSend, trialInactivitySend } = createEnv();

    await handler.scheduled?.(
      { cron: '5 * * * *' } as ScheduledController,
      env,
      {} as ExecutionContext
    );

    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(trialInactivitySend).not.toHaveBeenCalled();
    expect(findLogRecord('Ignoring unknown billing cron trigger')).toMatchObject({
      event: 'run_skipped',
      outcome: 'discarded',
      cron: '5 * * * *',
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

  it('fans out credit renewal discovery before continuing the lifecycle run', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '11111111-1111-4111-8111-111111111111';
    const message = {
      body: { kind: 'lifecycle', runId, sweep: 'credit_renewal' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).not.toHaveBeenCalled();
    expect(lifecycleSend).toHaveBeenNthCalledWith(1, {
      kind: 'credit_renewal_discovery',
      runId,
      sweep: 'credit_renewal_discovery',
    });
    expect(lifecycleSend).toHaveBeenNthCalledWith(2, {
      kind: 'lifecycle',
      runId,
      sweep: 'interrupted_auto_resume',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('runs standalone instance destruction without chaining later lifecycle sweeps', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '22222222-2222-4222-8222-222222222222';
    const message = {
      body: {
        kind: 'standalone_instance_destruction',
        runId,
        sweep: 'instance_destruction',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).toHaveBeenCalledWith(env, message.body, 1);
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();

    const record = findLogRecord('Completed standalone instance destruction run');
    expect(record).toMatchObject({
      event: 'run_completed',
      outcome: 'completed',
    });
    expect(record?.tags).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'worker',
        billingRunId: runId,
        billingSweep: 'instance_destruction',
        billingAttempt: 1,
      })
    );
  });

  it('starts paginated trial-expiry processing without advancing to subscription expiry', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '21212121-2121-4212-8212-212121212121';
    const message = {
      body: { kind: 'lifecycle', runId, sweep: 'trial_expiry' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).not.toHaveBeenCalled();
    expect(processTrialExpiryPage).not.toHaveBeenCalled();
    expect(lifecycleSend).toHaveBeenCalledTimes(1);
    expect(lifecycleSend).toHaveBeenCalledWith({
      kind: 'trial_expiry_page',
      runId,
      sweep: 'trial_expiry',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('enqueues organization trial expiry only after a final trial-expiry page completes', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '31313131-3131-4313-8313-313131313131';
    const message = {
      body: {
        kind: 'trial_expiry_continuation',
        runId,
        sweep: 'trial_expiry',
        cutoffTime: '2026-04-20T00:00:00.000Z',
        cursorSubscriptionId: '11111111-1111-4111-8111-111111111111',
        cursorTrialEndsAt: '2026-04-17T00:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processTrialExpiryPage).toHaveBeenCalledWith(env, message.body, 1);
    expect(lifecycleSend).toHaveBeenCalledTimes(1);
    expect(lifecycleSend).toHaveBeenCalledWith({
      kind: 'lifecycle',
      runId,
      sweep: 'organization_trial_expiry',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('does not enqueue organization trial expiry while trial-expiry continuation remains', async () => {
    const { env, lifecycleSend } = createEnv();
    vi.mocked(processTrialExpiryPage).mockResolvedValueOnce({
      summary: {
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
        organization_trial_expiry_suspensions: 0,
        organization_trial_entitlement_recoveries: 0,
        sweep2_subscription_expiry: 0,
        destruction_warnings: 0,
        organization_destruction_warnings: 0,
        sweep3_instance_destruction: 0,
        organization_instance_destructions: 0,
        sweep4_past_due_cleanup: 0,
        sweep5_intro_schedules_repaired: 0,
        complementary_inference_ended_emails: 0,
        emails_sent: 0,
        emails_skipped: 0,
        errors: 0,
      },
      continuationEnqueued: true,
    });
    const message = {
      body: {
        kind: 'trial_expiry_page',
        runId: '41414141-4141-4414-8414-414141414141',
        sweep: 'trial_expiry',
        pageBudget: 1,
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processTrialExpiryPage).toHaveBeenCalledWith(env, message.body, 1);
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('starts paginated organization trial-expiry processing without advancing to subscription expiry', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '51515151-5151-4515-8515-515151515151';
    const message = {
      body: { kind: 'lifecycle', runId, sweep: 'organization_trial_expiry' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).not.toHaveBeenCalled();
    expect(processOrganizationTrialExpiryPage).not.toHaveBeenCalled();
    expect(lifecycleSend).toHaveBeenCalledTimes(1);
    expect(lifecycleSend).toHaveBeenCalledWith({
      kind: 'organization_trial_expiry_page',
      runId,
      sweep: 'organization_trial_expiry',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('enqueues subscription expiry only after a final organization-trial-expiry page completes', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '61616161-6161-4616-8616-616161616161';
    const message = {
      body: {
        kind: 'organization_trial_expiry_continuation',
        runId,
        sweep: 'organization_trial_expiry',
        cutoffTime: '2026-05-18T00:00:00.000Z',
        cursorSubscriptionId: '11111111-1111-4111-8111-111111111111',
        cursorHardExpiryBoundary: '2026-05-17T00:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processOrganizationTrialExpiryPage).toHaveBeenCalledWith(env, message.body, 1);
    expect(lifecycleSend).toHaveBeenCalledTimes(1);
    expect(lifecycleSend).toHaveBeenCalledWith({
      kind: 'lifecycle',
      runId,
      sweep: 'subscription_expiry',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(findLogRecord('Completed organization-trial-expiry page message')).toMatchObject({
      event: 'run_completed',
      outcome: 'completed',
      continuationEnqueued: false,
      summary: expect.objectContaining({
        organization_trial_expiry_suspensions: 0,
      }),
    });
  });

  it('does not enqueue subscription expiry while organization-trial-expiry continuation remains', async () => {
    const { env, lifecycleSend } = createEnv();
    vi.mocked(processOrganizationTrialExpiryPage).mockResolvedValueOnce({
      summary: {
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
        organization_trial_expiry_suspensions: 0,
        organization_trial_entitlement_recoveries: 0,
        sweep2_subscription_expiry: 0,
        destruction_warnings: 0,
        organization_destruction_warnings: 0,
        sweep3_instance_destruction: 0,
        organization_instance_destructions: 0,
        sweep4_past_due_cleanup: 0,
        sweep5_intro_schedules_repaired: 0,
        complementary_inference_ended_emails: 0,
        emails_sent: 0,
        emails_skipped: 0,
        errors: 0,
      },
      continuationEnqueued: true,
    });
    const message = {
      body: {
        kind: 'organization_trial_expiry_page',
        runId: '71717171-7171-4717-8717-717171717171',
        sweep: 'organization_trial_expiry',
        pageBudget: 1,
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processOrganizationTrialExpiryPage).toHaveBeenCalledWith(env, message.body, 1);
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('continues hourly lifecycle instance destruction into past-due cleanup', async () => {
    const { env, lifecycleSend } = createEnv();
    const runId = '33333333-3333-4333-8333-333333333333';
    const message = {
      body: {
        kind: 'lifecycle',
        runId,
        sweep: 'instance_destruction',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).toHaveBeenCalledWith(env, message.body, 1);
    expect(lifecycleSend).toHaveBeenCalledWith({
      kind: 'lifecycle',
      runId,
      sweep: 'past_due_cleanup',
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
        sweep: 'interrupted_auto_resume',
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

  it('processes credit-renewal discovery queue messages', async () => {
    const { env, lifecycleSend } = createEnv();
    const message = {
      body: {
        kind: 'credit_renewal_discovery',
        runId: '66666666-6666-4666-8666-666666666666',
        sweep: 'credit_renewal_discovery',
        pageBudget: 25,
        wallClockBudgetMs: 1000,
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processCreditRenewalDiscovery).toHaveBeenCalledWith(
      env,
      {
        kind: 'credit_renewal_discovery',
        runId: '66666666-6666-4666-8666-666666666666',
        sweep: 'credit_renewal_discovery',
        pageBudget: 25,
        wallClockBudgetMs: 1000,
      },
      1
    );
    expect(runSweep).not.toHaveBeenCalled();
    expect(lifecycleSend).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('processes one credit-renewal item queue message', async () => {
    const { env } = createEnv();
    const message = {
      body: {
        kind: 'credit_renewal_item',
        runId: '77777777-7777-4777-8777-777777777777',
        sweep: 'credit_renewal_item',
        subscriptionId: '88888888-8888-4888-8888-888888888888',
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processCreditRenewalItem).toHaveBeenCalledWith(
      env,
      {
        kind: 'credit_renewal_item',
        runId: '77777777-7777-4777-8777-777777777777',
        sweep: 'credit_renewal_item',
        subscriptionId: '88888888-8888-4888-8888-888888888888',
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      },
      1
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('discards invalid credit-renewal queue messages with structured logs', async () => {
    const { env } = createEnv();
    const message = {
      body: {
        kind: 'credit_renewal_item',
        runId: '77777777-7777-4777-8777-777777777777',
        sweep: 'credit_renewal_item',
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(processCreditRenewalItem).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(findLogRecord('Discarding invalid billing queue message')).toMatchObject({
      event: 'invalid_message_discarded',
      outcome: 'discarded',
      attempts: 1,
    });
  });

  it('retries unexpected credit-renewal item failures and records terminal failure on the last retry', async () => {
    const { env } = createEnv();
    vi.mocked(processCreditRenewalItem).mockRejectedValueOnce(new Error('db unavailable'));
    const message = {
      body: {
        kind: 'credit_renewal_item',
        runId: '77777777-7777-4777-8777-777777777777',
        sweep: 'credit_renewal_item',
        subscriptionId: '88888888-8888-4888-8888-888888888888',
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      },
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(recordCreditRenewalTerminalFailure).toHaveBeenCalledWith(env, {
      kind: 'credit_renewal_terminal_failure',
      runId: '77777777-7777-4777-8777-777777777777',
      sweep: 'credit_renewal_terminal_failure',
      subscriptionId: '88888888-8888-4888-8888-888888888888',
      renewalBoundary: '2026-06-01T00:00:00.000Z',
      attempts: 3,
      failureMessage: 'db unavailable',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries the last credit-renewal item attempt when terminal failure recording fails', async () => {
    const { env } = createEnv();
    vi.mocked(processCreditRenewalItem).mockRejectedValueOnce(new Error('db unavailable'));
    vi.mocked(recordCreditRenewalTerminalFailure).mockRejectedValueOnce(
      new Error('terminal repository unavailable')
    );
    const message = {
      body: {
        kind: 'credit_renewal_item',
        runId: '77777777-7777-4777-8777-777777777777',
        sweep: 'credit_renewal_item',
        subscriptionId: '88888888-8888-4888-8888-888888888888',
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      },
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(recordCreditRenewalTerminalFailure).toHaveBeenCalledTimes(1);
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(
      findLogRecord('Failed to record credit-renewal terminal failure before DLQ')
    ).toMatchObject({
      event: 'terminal_failure_record_failed',
      outcome: 'failed',
      attempts: 3,
    });
  });

  it('processes explicit terminal-failure queue messages', async () => {
    const { env } = createEnv();
    const message = {
      body: {
        kind: 'credit_renewal_terminal_failure',
        runId: '99999999-9999-4999-8999-999999999999',
        sweep: 'credit_renewal_terminal_failure',
        subscriptionId: '88888888-8888-4888-8888-888888888888',
        renewalBoundary: '2026-06-01T00:00:00.000Z',
        attempts: 3,
        failureMessage: 'dead-lettered',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(recordCreditRenewalTerminalFailure).toHaveBeenCalledWith(env, message.body);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
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
        sweep: 'interrupted_auto_resume',
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
        billingSweep: 'interrupted_auto_resume',
        billingAttempt: 3,
      })
    );
  });
});
