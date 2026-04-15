import { z } from 'zod';
import { BILLING_FLOW } from '@kilocode/worker-utils/kiloclaw-billing-observability';
import {
  BILLING_QUEUE_MAX_RETRIES,
  BILLING_SWEEP_ORDER,
  type BillingSweepKind,
  type BillingSweepMessage,
  type BillingWorkerEnv,
} from './types.js';
import { runSweep } from './lifecycle.js';
import { logger, withLogTags, type BillingLogFields } from './logger.js';
import { bootstrapProvisionSubscription } from './bootstrap.js';

const BootstrapProvisionSubscriptionSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid(),
  orgId: z.string().uuid().nullable().optional(),
});

const BillingSweepMessageSchema = z.object({
  runId: z.string().uuid(),
  sweep: z.enum(BILLING_SWEEP_ORDER),
});

function nextSweep(current: BillingSweepKind): BillingSweepKind | null {
  const index = BILLING_SWEEP_ORDER.indexOf(current);
  if (index < 0 || index === BILLING_SWEEP_ORDER.length - 1) {
    return null;
  }
  return BILLING_SWEEP_ORDER[index + 1];
}

function log(level: 'info' | 'warn' | 'error', message: string, fields: BillingLogFields) {
  if (level === 'error') {
    logger.withFields(fields).error(message);
    return;
  }
  if (level === 'warn') {
    logger.withFields(fields).warn(message);
    return;
  }
  logger.withFields(fields).info(message);
}

export const handler: ExportedHandler<BillingWorkerEnv, BillingSweepMessage> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/bootstrap-subscription') {
      if (!env.INTERNAL_API_SECRET) {
        return Response.json({ error: 'INTERNAL_API_SECRET is not configured' }, { status: 500 });
      }

      const providedSecret = request.headers.get('x-internal-api-key');
      if (!providedSecret || providedSecret !== env.INTERNAL_API_SECRET) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'Malformed JSON body' }, { status: 400 });
      }

      const parsed = BootstrapProvisionSubscriptionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { error: 'Invalid request', details: parsed.error.flatten().fieldErrors },
          { status: 400 }
        );
      }

      try {
        const subscription = await bootstrapProvisionSubscription(env, {
          userId: parsed.data.userId,
          instanceId: parsed.data.instanceId,
          orgId: parsed.data.orgId ?? null,
        });

        return Response.json({
          ok: true,
          subscriptionId: subscription.id,
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        );
      }
    }

    return Response.json({
      ok: true,
      service: 'kiloclaw-billing',
      timestamp: new Date().toISOString(),
    });
  },

  async scheduled(_controller, env) {
    const runId = crypto.randomUUID();
    const firstMessage: BillingSweepMessage = {
      runId,
      sweep: BILLING_SWEEP_ORDER[0],
    };

    await withLogTags(
      {
        source: 'scheduled',
        tags: {
          billingFlow: BILLING_FLOW,
          billingComponent: 'worker',
          billingRunId: runId,
          billingSweep: firstMessage.sweep,
        },
      },
      async () => {
        await env.LIFECYCLE_QUEUE.send(firstMessage);

        log('info', 'Enqueued billing lifecycle kickoff', {
          event: 'run_started',
          outcome: 'started',
        });
      }
    );
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const parsed = BillingSweepMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        await withLogTags(
          {
            source: 'queue',
            tags: {
              billingFlow: BILLING_FLOW,
              billingComponent: 'worker',
              billingAttempt: message.attempts,
            },
          },
          async () => {
            log('error', 'Discarding invalid billing queue message', {
              event: 'invalid_message_discarded',
              outcome: 'discarded',
              attempts: message.attempts,
              error: parsed.error.message,
            });
          }
        );
        message.ack();
        continue;
      }

      await withLogTags(
        {
          source: 'queue',
          tags: {
            billingFlow: BILLING_FLOW,
            billingComponent: 'worker',
            billingRunId: parsed.data.runId,
            billingSweep: parsed.data.sweep,
            billingAttempt: message.attempts,
          },
        },
        async () => {
          try {
            await runSweep(env, parsed.data, message.attempts);

            const next = nextSweep(parsed.data.sweep);
            if (next) {
              await env.LIFECYCLE_QUEUE.send({
                runId: parsed.data.runId,
                sweep: next,
              });
            } else {
              log('info', 'Completed billing lifecycle run', {
                event: 'run_completed',
                outcome: 'completed',
              });
            }

            message.ack();
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const willGoToDlq = message.attempts >= BILLING_QUEUE_MAX_RETRIES;

            log('error', 'Billing queue message failed', {
              event: 'queue_retry',
              outcome: 'retry',
              attempts: message.attempts,
              willGoToDlq,
              error: errorMessage,
            });

            if (willGoToDlq) {
              log('error', 'Billing lifecycle run failed before DLQ', {
                event: 'run_failed',
                outcome: 'failed',
                attempts: message.attempts,
                willGoToDlq: true,
                error: errorMessage,
              });
            }

            message.retry();
          }
        }
      );
    }
  },
};

export default handler;
