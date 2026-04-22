import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { BILLING_FLOW } from '@kilocode/worker-utils/kiloclaw-billing-observability';
import {
  BILLING_HOURLY_CRON,
  BILLING_QUEUE_MAX_RETRIES,
  BILLING_SWEEP_ORDER,
  TRIAL_INACTIVITY_DAILY_CRON,
  TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP,
  TRIAL_INACTIVITY_SWEEP,
  type BillingQueueMessage,
  type BillingSweepKind,
  type LifecycleQueueMessage,
  type BillingWorkerEnv,
} from './types.js';
import { processTrialInactivityStopCandidate, runSweep } from './lifecycle.js';
import { logger, withLogTags, type BillingLogFields } from './logger.js';
import { bootstrapProvisionSubscription } from './bootstrap.js';

const BootstrapProvisionSubscriptionSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid(),
  orgId: z.string().uuid().nullable().optional(),
});

const LifecycleQueueMessageSchema = z.object({
  kind: z.literal('lifecycle'),
  runId: z.string().uuid(),
  sweep: z.enum(BILLING_SWEEP_ORDER),
});

const TrialInactivityQueueMessageSchema = z.object({
  kind: z.literal('trial_inactivity_stop'),
  runId: z.string().uuid(),
  sweep: z.literal(TRIAL_INACTIVITY_SWEEP),
});

const TrialInactivityStopCandidateQueueMessageSchema = z.object({
  kind: z.literal('trial_inactivity_stop_candidate'),
  runId: z.string().uuid(),
  sweep: z.literal(TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP),
  subscriptionId: z.string().uuid(),
  userId: z.string().min(1),
  instanceId: z.string().uuid(),
});

const BillingQueueMessageSchema = z.discriminatedUnion('kind', [
  LifecycleQueueMessageSchema,
  TrialInactivityQueueMessageSchema,
  TrialInactivityStopCandidateQueueMessageSchema,
]);

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

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * RPC entrypoint invoked by other Workers over a service binding.
 *
 * Callers authenticate implicitly via the binding topology — only Workers
 * explicitly bound to `kiloclaw-billing` with `entrypoint: "KiloClawBillingService"`
 * can reach these methods. No shared secret is needed across the boundary.
 */
export class KiloClawBillingService extends WorkerEntrypoint<BillingWorkerEnv> {
  async bootstrapProvisionSubscription(params: {
    userId: string;
    instanceId: string;
    orgId?: string | null;
  }): Promise<{ subscriptionId: string }> {
    const parsed = BootstrapProvisionSubscriptionSchema.parse(params);
    const orgId = parsed.orgId ?? null;

    return await withLogTags(
      {
        source: 'rpc',
        tags: {
          billingFlow: BILLING_FLOW,
          billingComponent: 'worker',
          userId: parsed.userId,
          instanceId: parsed.instanceId,
        },
      },
      async () => {
        const start = Date.now();
        log('info', 'bootstrap-subscription started', {
          event: 'bootstrap_subscription',
          outcome: 'started',
          orgId,
        });
        try {
          const subscription = await bootstrapProvisionSubscription(this.env, {
            userId: parsed.userId,
            instanceId: parsed.instanceId,
            orgId,
          });

          log('info', 'bootstrap-subscription completed', {
            event: 'bootstrap_subscription',
            outcome: 'completed',
            orgId,
            durationMs: Date.now() - start,
            kiloclawSubscriptionId: subscription.id,
          });

          return { subscriptionId: subscription.id };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log('error', 'bootstrap-subscription failed', {
            event: 'bootstrap_subscription',
            outcome: 'failed',
            orgId,
            durationMs: Date.now() - start,
            error: errorMessage,
          });
          throw error;
        }
      }
    );
  }
}

export const handler: ExportedHandler<BillingWorkerEnv, BillingQueueMessage> = {
  async fetch() {
    return Response.json({
      ok: true,
      service: 'kiloclaw-billing',
      timestamp: new Date().toISOString(),
    });
  },

  async scheduled(controller, env) {
    const runId = crypto.randomUUID();

    if (controller.cron === TRIAL_INACTIVITY_DAILY_CRON) {
      const message = {
        kind: 'trial_inactivity_stop',
        runId,
        sweep: TRIAL_INACTIVITY_SWEEP,
      } satisfies BillingQueueMessage;

      await withLogTags(
        {
          source: 'scheduled',
          tags: {
            billingFlow: BILLING_FLOW,
            billingComponent: 'worker',
            billingRunId: runId,
            billingSweep: message.sweep,
          },
        },
        async () => {
          if (!isEnvFlagEnabled(env.TRIAL_INACTIVITY_STOP_ENABLED)) {
            log('info', 'Skipping daily trial inactivity kickoff because feature is disabled', {
              event: 'run_skipped',
              outcome: 'discarded',
              cron: controller.cron,
            });
            return;
          }

          await env.TRIAL_INACTIVITY_QUEUE.send(message);

          log('info', 'Enqueued daily trial inactivity kickoff', {
            event: 'run_started',
            outcome: 'started',
            cron: controller.cron,
            dryRun: isEnvFlagEnabled(env.TRIAL_INACTIVITY_STOP_DRY_RUN),
          });
        }
      );
      return;
    }

    if (controller.cron !== BILLING_HOURLY_CRON) {
      await withLogTags(
        {
          source: 'scheduled',
          tags: {
            billingFlow: BILLING_FLOW,
            billingComponent: 'worker',
            billingRunId: runId,
          },
        },
        async () => {
          log('warn', 'Ignoring unknown billing cron trigger', {
            event: 'run_skipped',
            outcome: 'discarded',
            cron: controller.cron,
          });
        }
      );
      return;
    }

    const firstMessage: LifecycleQueueMessage = {
      kind: 'lifecycle',
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
          cron: controller.cron,
        });
      }
    );
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const parsed = BillingQueueMessageSchema.safeParse(message.body);
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
            if (parsed.data.kind === 'trial_inactivity_stop_candidate') {
              await processTrialInactivityStopCandidate(env, parsed.data, message.attempts);
              log('info', 'Completed trial inactivity stop candidate', {
                event: 'run_completed',
                outcome: 'completed',
                subscriptionId: parsed.data.subscriptionId,
                userId: parsed.data.userId,
                instanceId: parsed.data.instanceId,
              });
            } else {
              await runSweep(env, parsed.data, message.attempts);

              if (parsed.data.kind === 'lifecycle') {
                const next = nextSweep(parsed.data.sweep);
                if (next) {
                  await env.LIFECYCLE_QUEUE.send({
                    kind: 'lifecycle',
                    runId: parsed.data.runId,
                    sweep: next,
                  });
                } else {
                  log('info', 'Completed billing lifecycle run', {
                    event: 'run_completed',
                    outcome: 'completed',
                  });
                }
              } else {
                log('info', 'Completed daily trial inactivity run', {
                  event: 'run_completed',
                  outcome: 'completed',
                });
              }
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
