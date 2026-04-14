import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lifecycle.js', () => ({
  runSweep: vi.fn(),
}));

import { handler } from './index.js';
import { runSweep } from './lifecycle.js';
import type { BillingSweepMessage, BillingWorkerEnv } from './types.js';

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

function createEnv(): { env: BillingWorkerEnv; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => undefined);
  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgres://test' },
      LIFECYCLE_QUEUE: {
        send,
      } as unknown as BillingWorkerEnv['LIFECYCLE_QUEUE'],
      KILOCLAW: {
        fetch: vi.fn(),
      },
      KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
      STRIPE_KILOCLAW_COMMIT_PRICE_ID: 'price_commit',
      STRIPE_KILOCLAW_STANDARD_PRICE_ID: 'price_standard',
      STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID: 'price_standard_intro',
      INTERNAL_API_SECRET: 'next-secret',
      KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
    },
    send,
  };
}

function createBatch(message: QueueMessage): MessageBatch<BillingSweepMessage> {
  return {
    queue: 'kiloclaw-billing-lifecycle',
    messages: [message as unknown as Message<BillingSweepMessage>],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<BillingSweepMessage>;
}

describe('kiloclaw billing worker handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loggedValues = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
    vi.mocked(runSweep).mockResolvedValue({
      credit_renewals: 0,
      credit_renewals_canceled: 0,
      credit_renewals_past_due: 0,
      credit_renewals_auto_top_up: 0,
      credit_renewals_skipped_duplicate: 0,
      interrupted_auto_resume_requests: 0,
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
    });
  });

  it('enqueues the first sweep on cron kickoff', async () => {
    const { env, send } = createEnv();

    await handler.scheduled?.({} as ScheduledController, env, {} as ExecutionContext);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sweep: 'credit_renewal' }));
  });

  it('acks invalid queue messages', async () => {
    const { env } = createEnv();
    const message = {
      body: { runId: 'not-a-uuid', sweep: 'credit_renewal' },
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
    const { env, send } = createEnv();
    const runId = '11111111-1111-4111-8111-111111111111';
    const message = {
      body: { runId, sweep: 'credit_renewal' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(runSweep).toHaveBeenCalledWith(env, { runId, sweep: 'credit_renewal' }, 1);
    expect(send).toHaveBeenLastCalledWith({
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
    const { env, send } = createEnv();
    const message = {
      body: {
        runId: '11111111-1111-4111-8111-111111111111',
        sweep: 'complementary_inference_ended',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handler.queue?.(createBatch(message), env, {} as ExecutionContext);

    expect(send).not.toHaveBeenCalled();
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

  it('logs a terminal run failure before DLQ on the last retry', async () => {
    const { env } = createEnv();
    vi.mocked(runSweep).mockRejectedValueOnce(new Error('boom'));
    const message = {
      body: {
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
