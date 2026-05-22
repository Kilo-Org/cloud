import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { KILOCLAW_PRICE_VERSIONS } from '@kilocode/db';
import { BILLING_FLOW } from '@kilocode/worker-utils/kiloclaw-billing-observability';
import {
  BILLING_HOURLY_CRON,
  BILLING_QUEUE_MAX_RETRIES,
  BILLING_SWEEP_ORDER,
  INSTANCE_DESTRUCTION_QUARTER_HOURLY_CRON,
  TRIAL_INACTIVITY_DAILY_CRON,
  TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP,
  TRIAL_INACTIVITY_SWEEP,
  type BillingQueueMessage,
  type BillingSweepKind,
  type LifecycleQueueMessage,
  type BillingWorkerEnv,
} from './types.js';
import {
  processCreditRenewalDiscovery,
  processCreditRenewalItem,
  processOrganizationTrialExpiryPage,
  processTrialExpiryPage,
  processTrialInactivityStopCandidate,
  recordCreditRenewalTerminalFailure,
  runSweep,
} from './lifecycle.js';
import { logger, withLogTags, type BillingLogFields } from './logger.js';
import { bootstrapProvisionSubscription, resolveProvisionEntitlement } from './bootstrap.js';

const BootstrapProvisionSubscriptionSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid(),
  orgId: z.string().uuid().nullable().optional(),
  expectedPriceVersion: z.enum(KILOCLAW_PRICE_VERSIONS).optional(),
});

const ResolveProvisionEntitlementSchema = z.object({
  userId: z.string().min(1),
  orgId: z.string().uuid().nullable().optional(),
});

const LifecycleQueueMessageSchema = z.object({
  kind: z.literal('lifecycle'),
  runId: z.string().uuid(),
  sweep: z.enum(BILLING_SWEEP_ORDER),
});

const StandaloneInstanceDestructionQueueMessageSchema = z.object({
  kind: z.literal('standalone_instance_destruction'),
  runId: z.string().uuid(),
  sweep: z.literal('instance_destruction'),
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

const CreditRenewalDiscoveryQueueMessageSchema = z.object({
  kind: z.literal('credit_renewal_discovery'),
  runId: z.string().uuid(),
  sweep: z.literal('credit_renewal_discovery'),
  cutoffTime: z.string().datetime().optional(),
  cursorSubscriptionId: z.string().uuid().optional(),
  cursorRenewalBoundary: z.string().datetime().optional(),
  pageBudget: z.number().int().min(1).max(1000).optional(),
  wallClockBudgetMs: z.number().int().min(1).max(110_000).optional(),
});

const CreditRenewalDiscoveryContinuationQueueMessageSchema = z.object({
  kind: z.literal('credit_renewal_discovery_continuation'),
  runId: z.string().uuid(),
  sweep: z.literal('credit_renewal_discovery'),
  cutoffTime: z.string().datetime(),
  cursorSubscriptionId: z.string().uuid(),
  cursorRenewalBoundary: z.string().datetime(),
  pageBudget: z.number().int().min(1).max(1000).optional(),
  wallClockBudgetMs: z.number().int().min(1).max(110_000).optional(),
});

const TrialExpiryPageQueueMessageSchema = z.object({
  kind: z.literal('trial_expiry_page'),
  runId: z.string().uuid(),
  sweep: z.literal('trial_expiry'),
  cutoffTime: z.string().datetime().optional(),
  cursorSubscriptionId: z.string().uuid().optional(),
  cursorTrialEndsAt: z.string().datetime().optional(),
  pageBudget: z.number().int().min(1).max(1000).optional(),
  wallClockBudgetMs: z.number().int().min(1).max(110_000).optional(),
});

const TrialExpiryContinuationQueueMessageSchema = z.object({
  kind: z.literal('trial_expiry_continuation'),
  runId: z.string().uuid(),
  sweep: z.literal('trial_expiry'),
  cutoffTime: z.string().datetime(),
  cursorSubscriptionId: z.string().uuid(),
  cursorTrialEndsAt: z.string().datetime(),
  pageBudget: z.number().int().min(1).max(1000).optional(),
  wallClockBudgetMs: z.number().int().min(1).max(110_000).optional(),
});

const OrganizationTrialExpiryPageQueueMessageSchema = z.object({
  kind: z.literal('organization_trial_expiry_page'),
  runId: z.string().uuid(),
  sweep: z.literal('organization_trial_expiry'),
  cutoffTime: z.string().datetime().optional(),
  cursorSubscriptionId: z.string().uuid().optional(),
  cursorHardExpiryBoundary: z.string().datetime().optional(),
  pageBudget: z.number().int().min(1).max(1000).optional(),
  wallClockBudgetMs: z.number().int().min(1).max(110_000).optional(),
});

const OrganizationTrialExpiryContinuationQueueMessageSchema = z.object({
  kind: z.literal('organization_trial_expiry_continuation'),
  runId: z.string().uuid(),
  sweep: z.literal('organization_trial_expiry'),
  cutoffTime: z.string().datetime(),
  cursorSubscriptionId: z.string().uuid(),
  cursorHardExpiryBoundary: z.string().datetime(),
  pageBudget: z.number().int().min(1).max(1000).optional(),
  wallClockBudgetMs: z.number().int().min(1).max(110_000).optional(),
});

const CreditRenewalItemQueueMessageSchema = z.object({
  kind: z.literal('credit_renewal_item'),
  runId: z.string().uuid(),
  sweep: z.literal('credit_renewal_item'),
  subscriptionId: z.string().uuid(),
  userId: z.string().min(1).optional(),
  renewalBoundary: z.string().datetime(),
  discoveredAt: z.string().datetime().optional(),
  resolveTerminalFailureOnExpectedOutcome: z.boolean().optional(),
  diagnostics: z
    .object({
      instanceId: z.string().uuid().nullable(),
      plan: z.string().min(1),
      status: z.string().min(1),
    })
    .optional(),
});

const CreditRenewalTerminalFailureQueueMessageSchema = z.object({
  kind: z.literal('credit_renewal_terminal_failure'),
  runId: z.string().uuid(),
  sweep: z.literal('credit_renewal_terminal_failure'),
  subscriptionId: z.string().uuid(),
  renewalBoundary: z.string().datetime(),
  attempts: z.number().int().min(BILLING_QUEUE_MAX_RETRIES),
  failureMessage: z.string().optional(),
});

const BillingQueueMessageSchema = z.discriminatedUnion('kind', [
  LifecycleQueueMessageSchema,
  StandaloneInstanceDestructionQueueMessageSchema,
  TrialInactivityQueueMessageSchema,
  TrialInactivityStopCandidateQueueMessageSchema,
  CreditRenewalDiscoveryQueueMessageSchema,
  CreditRenewalDiscoveryContinuationQueueMessageSchema,
  TrialExpiryPageQueueMessageSchema,
  TrialExpiryContinuationQueueMessageSchema,
  OrganizationTrialExpiryPageQueueMessageSchema,
  OrganizationTrialExpiryContinuationQueueMessageSchema,
  CreditRenewalItemQueueMessageSchema,
  CreditRenewalTerminalFailureQueueMessageSchema,
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
    expectedPriceVersion?: string;
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
            expectedPriceVersion: parsed.expectedPriceVersion,
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

  async resolveProvisionEntitlement(params: { userId: string; orgId?: string | null }): Promise<{
    priceVersion: string;
    selfServiceInstanceType: string;
  }> {
    const parsed = ResolveProvisionEntitlementSchema.parse(params);
    const orgId = parsed.orgId ?? null;

    return await withLogTags(
      {
        source: 'rpc',
        tags: {
          billingFlow: BILLING_FLOW,
          billingComponent: 'worker',
          userId: parsed.userId,
        },
      },
      async () => {
        const start = Date.now();
        log('info', 'resolve-provision-entitlement started', {
          event: 'resolve_provision_entitlement',
          outcome: 'started',
          orgId,
        });
        try {
          const entitlement = await resolveProvisionEntitlement(this.env, {
            userId: parsed.userId,
            orgId,
          });

          log('info', 'resolve-provision-entitlement completed', {
            event: 'resolve_provision_entitlement',
            outcome: 'completed',
            orgId,
            durationMs: Date.now() - start,
            kiloclawPriceVersion: entitlement.priceVersion,
            instanceType: entitlement.selfServiceInstanceType,
          });

          return entitlement;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log('error', 'resolve-provision-entitlement failed', {
            event: 'resolve_provision_entitlement',
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

    if (controller.cron === INSTANCE_DESTRUCTION_QUARTER_HOURLY_CRON) {
      const message = {
        kind: 'standalone_instance_destruction',
        runId,
        sweep: 'instance_destruction',
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
          await env.LIFECYCLE_QUEUE.send(message);

          log('info', 'Enqueued standalone instance destruction sweep', {
            event: 'run_started',
            outcome: 'started',
            cron: controller.cron,
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
            } else if (
              parsed.data.kind === 'credit_renewal_discovery' ||
              parsed.data.kind === 'credit_renewal_discovery_continuation'
            ) {
              await processCreditRenewalDiscovery(env, parsed.data, message.attempts);
              log('info', 'Completed credit-renewal discovery message', {
                event: 'run_completed',
                outcome: 'completed',
              });
            } else if (
              parsed.data.kind === 'trial_expiry_page' ||
              parsed.data.kind === 'trial_expiry_continuation'
            ) {
              const result = await processTrialExpiryPage(env, parsed.data, message.attempts);
              if (!result.continuationEnqueued) {
                const next = nextSweep('trial_expiry');
                if (next) {
                  await env.LIFECYCLE_QUEUE.send({
                    kind: 'lifecycle',
                    runId: parsed.data.runId,
                    sweep: next,
                  });
                }
              }
              log('info', 'Completed trial-expiry page message', {
                event: 'run_completed',
                outcome: 'completed',
                continuationEnqueued: result.continuationEnqueued,
              });
            } else if (
              parsed.data.kind === 'organization_trial_expiry_page' ||
              parsed.data.kind === 'organization_trial_expiry_continuation'
            ) {
              const result = await processOrganizationTrialExpiryPage(
                env,
                parsed.data,
                message.attempts
              );
              if (!result.continuationEnqueued) {
                const next = nextSweep('organization_trial_expiry');
                if (next) {
                  await env.LIFECYCLE_QUEUE.send({
                    kind: 'lifecycle',
                    runId: parsed.data.runId,
                    sweep: next,
                  });
                }
              }
              log('info', 'Completed organization-trial-expiry page message', {
                event: 'run_completed',
                outcome: 'completed',
                continuationEnqueued: result.continuationEnqueued,
                summary: result.summary,
              });
            } else if (parsed.data.kind === 'credit_renewal_item') {
              await processCreditRenewalItem(env, parsed.data, message.attempts);
              log('info', 'Completed credit-renewal item message', {
                event: 'run_completed',
                outcome: 'completed',
                subscriptionId: parsed.data.subscriptionId,
                renewalBoundary: parsed.data.renewalBoundary,
              });
            } else if (parsed.data.kind === 'credit_renewal_terminal_failure') {
              await recordCreditRenewalTerminalFailure(env, parsed.data);
              log('info', 'Completed credit-renewal terminal-failure message', {
                event: 'run_completed',
                outcome: 'completed',
                subscriptionId: parsed.data.subscriptionId,
                renewalBoundary: parsed.data.renewalBoundary,
              });
            } else if (parsed.data.kind === 'standalone_instance_destruction') {
              await runSweep(env, parsed.data, message.attempts);
              log('info', 'Completed standalone instance destruction run', {
                event: 'run_completed',
                outcome: 'completed',
              });
            } else if (parsed.data.kind === 'lifecycle' && parsed.data.sweep === 'credit_renewal') {
              await env.LIFECYCLE_QUEUE.send({
                kind: 'credit_renewal_discovery',
                runId: parsed.data.runId,
                sweep: 'credit_renewal_discovery',
              });
              const next = nextSweep(parsed.data.sweep);
              if (next) {
                await env.LIFECYCLE_QUEUE.send({
                  kind: 'lifecycle',
                  runId: parsed.data.runId,
                  sweep: next,
                });
              }
              log('info', 'Started credit-renewal fanout discovery', {
                event: 'run_started',
                outcome: 'started',
              });
            } else if (parsed.data.kind === 'lifecycle' && parsed.data.sweep === 'trial_expiry') {
              await env.LIFECYCLE_QUEUE.send({
                kind: 'trial_expiry_page',
                runId: parsed.data.runId,
                sweep: 'trial_expiry',
              });
              log('info', 'Started trial-expiry paginated processing', {
                event: 'run_started',
                outcome: 'started',
              });
            } else if (
              parsed.data.kind === 'lifecycle' &&
              parsed.data.sweep === 'organization_trial_expiry'
            ) {
              await env.LIFECYCLE_QUEUE.send({
                kind: 'organization_trial_expiry_page',
                runId: parsed.data.runId,
                sweep: 'organization_trial_expiry',
              });
              log('info', 'Started organization-trial-expiry paginated processing', {
                event: 'run_started',
                outcome: 'started',
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

              if (parsed.data.kind === 'credit_renewal_item') {
                try {
                  await recordCreditRenewalTerminalFailure(env, {
                    kind: 'credit_renewal_terminal_failure',
                    runId: parsed.data.runId,
                    sweep: 'credit_renewal_terminal_failure',
                    subscriptionId: parsed.data.subscriptionId,
                    renewalBoundary: parsed.data.renewalBoundary,
                    attempts: message.attempts,
                    failureMessage: errorMessage,
                  });
                } catch (terminalFailureError) {
                  log('error', 'Failed to record credit-renewal terminal failure before DLQ', {
                    event: 'terminal_failure_record_failed',
                    outcome: 'failed',
                    attempts: message.attempts,
                    subscriptionId: parsed.data.subscriptionId,
                    renewalBoundary: parsed.data.renewalBoundary,
                    error:
                      terminalFailureError instanceof Error
                        ? terminalFailureError.message
                        : String(terminalFailureError),
                  });
                  message.retry();
                  return;
                }

                message.ack();
                return;
              }
            }

            message.retry();
          }
        }
      );
    }
  },
};

export default handler;
