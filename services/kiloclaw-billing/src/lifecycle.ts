import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { addMonths, format } from 'date-fns';

import type { WorkerDb } from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db';
import {
  BILLING_FLOW,
  createBillingCorrelationHeaders,
  type BillingCorrelationContext,
} from '@kilocode/worker-utils/kiloclaw-billing-observability';
import {
  credit_transactions,
  kiloclaw_earlybird_purchases,
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kilocode_users,
  user_affiliate_attributions,
} from '@kilocode/db/schema';
import type {
  KiloClawPlan,
  KiloClawScheduledPlan,
  KiloClawSubscriptionStatus,
} from '@kilocode/db/schema-types';

import type { BillingSweepMessage, BillingWorkerEnv } from './types.js';
import { logger, withLogTags, type BillingLogFields } from './logger.js';

const MS_PER_DAY = 86_400_000;
const DESTRUCTION_GRACE_DAYS = 7;
const PAST_DUE_THRESHOLD_DAYS = 14;
const TRIAL_WARNING_DAYS = 2;
const DESTRUCTION_WARNING_DAYS = 2;
const KILOCLAW_EARLYBIRD_EXPIRY_DATE = '2026-09-26';

const KILOCLAW_PLAN_COST_MICRODOLLARS = {
  standard: 9_000_000,
  commit: 48_000_000,
} as const;

type TemplateName =
  | 'clawSuspendedTrial'
  | 'clawSuspendedSubscription'
  | 'clawSuspendedPayment'
  | 'clawDestructionWarning'
  | 'clawInstanceDestroyed'
  | 'clawTrialEndingSoon'
  | 'clawTrialExpiresTomorrow'
  | 'clawEarlybirdEndingSoon'
  | 'clawEarlybirdExpiresTomorrow'
  | 'clawCreditRenewalFailed';

type SendResult =
  | { sent: true }
  | { sent: false; reason: 'neverbounce_rejected' | 'provider_not_configured' };

type BillingSummary = {
  credit_renewals: number;
  credit_renewals_canceled: number;
  credit_renewals_past_due: number;
  credit_renewals_auto_top_up: number;
  credit_renewals_skipped_duplicate: number;
  interrupted_auto_resumes: number;
  trial_warnings: number;
  earlybird_warnings: number;
  sweep1_trial_expiry: number;
  sweep2_subscription_expiry: number;
  destruction_warnings: number;
  sweep3_instance_destruction: number;
  sweep4_past_due_cleanup: number;
  sweep5_intro_schedules_repaired: number;
  emails_sent: number;
  emails_skipped: number;
  errors: number;
};

type CreditRenewalRow = {
  user_id: string;
  email: string;
  instance_id: string | null;
  plan: KiloClawPlan;
  status: KiloClawSubscriptionStatus;
  credit_renewal_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  scheduled_plan: KiloClawScheduledPlan | null;
  commit_ends_at: string | null;
  past_due_since: string | null;
  suspended_at: string | null;
  auto_top_up_triggered_for_period: string | null;
  total_microdollars_acquired: number;
  microdollars_used: number;
  auto_top_up_enabled: boolean;
  kilo_pass_threshold: number | null;
  next_credit_expiration_at: string | null;
  user_updated_at: string;
};

type EmailActionInput = {
  to: string;
  templateName: TemplateName;
  templateVars: Record<string, string>;
  subjectOverride?: string;
};

type UserForAutoTopUp = {
  id: string;
  total_microdollars_acquired: number;
  microdollars_used: number;
  next_credit_expiration_at: string | null;
  updated_at: string;
  auto_top_up_enabled: boolean;
};

type BillingEntityFields = {
  userId?: string;
  instanceId?: string;
  stripeSubscriptionId?: string;
};

type SweepExecutionContext = BillingCorrelationContext & {
  billingFlow: typeof BILLING_FLOW;
  billingRunId: string;
  billingSweep: BillingSweepMessage['sweep'];
  billingAttempt: number;
};

type SideEffectRequest =
  | { action: 'send_email'; input: EmailActionInput }
  | {
      action: 'trigger_user_auto_top_up';
      input: { user: UserForAutoTopUp };
    }
  | {
      action: 'ensure_auto_intro_schedule';
      input: { stripeSubscriptionId: string; userId: string };
    }
  | {
      action: 'track_trial_end';
      input: {
        clickId?: string;
        customerId: string;
        customerEmail: string;
        eventDateIso: string;
      };
    }
  | {
      action: 'project_pending_kilo_pass_bonus';
      input: {
        userId: string;
        microdollarsUsed: number;
        kiloPassThreshold: number | null;
      };
    }
  | {
      action: 'issue_kilo_pass_bonus_from_usage_threshold';
      input: { userId: string; nowIso: string };
    };

type SideEffectResponse<T extends SideEffectRequest> = T['action'] extends 'send_email'
  ? SendResult
  : T['action'] extends 'trigger_user_auto_top_up'
    ? { ok: true }
    : T['action'] extends 'ensure_auto_intro_schedule'
      ? { repaired: boolean }
      : T['action'] extends 'track_trial_end'
        ? { tracked: boolean }
        : T['action'] extends 'project_pending_kilo_pass_bonus'
          ? { projectedBonusMicrodollars: number }
          : { ok: true };

export class KiloClawApiError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody = '') {
    super(`KiloClaw API error (${statusCode})`);
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function createSummary(): BillingSummary {
  return {
    credit_renewals: 0,
    credit_renewals_canceled: 0,
    credit_renewals_past_due: 0,
    credit_renewals_auto_top_up: 0,
    credit_renewals_skipped_duplicate: 0,
    interrupted_auto_resumes: 0,
    trial_warnings: 0,
    earlybird_warnings: 0,
    sweep1_trial_expiry: 0,
    sweep2_subscription_expiry: 0,
    destruction_warnings: 0,
    sweep3_instance_destruction: 0,
    sweep4_past_due_cleanup: 0,
    sweep5_intro_schedules_repaired: 0,
    emails_sent: 0,
    emails_skipped: 0,
    errors: 0,
  };
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

function getDb(env: BillingWorkerEnv): WorkerDb {
  return getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
}

function buildClawUrl(env: BillingWorkerEnv): string {
  return `${env.KILOCODE_BACKEND_BASE_URL}/claw`;
}

function formatDateForEmail(date: Date): string {
  return format(date, 'MMMM d, yyyy');
}

function workerInstanceId(
  instance: { id: string; sandboxId?: string | null; sandbox_id?: string | null } | null | undefined
): string | undefined {
  if (!instance) return undefined;
  const sandboxId = instance.sandboxId ?? instance.sandbox_id;
  if (!sandboxId) return undefined;
  return sandboxId.startsWith('ki_') ? instance.id : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSweepContext(message: BillingSweepMessage, attempt: number): SweepExecutionContext {
  return {
    billingFlow: BILLING_FLOW,
    billingRunId: message.runId,
    billingSweep: message.sweep,
    billingAttempt: attempt,
  };
}

async function callBillingSideEffect<T extends SideEffectRequest>(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  request: T,
  entityFields: BillingEntityFields = {}
): Promise<SideEffectResponse<T>> {
  if (!env.INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }
  const internalApiSecret = env.INTERNAL_API_SECRET;

  const billingCallId = crypto.randomUUID();
  const startedAt = performance.now();
  const callContext = {
    ...context,
    billingCallId,
  };

  return await withLogTags(
    {
      source: 'callBillingSideEffect',
      tags: {
        ...callContext,
        billingComponent: 'side_effects',
      },
    },
    async () => {
      log('info', 'Starting billing side effect call', {
        event: 'downstream_call',
        outcome: 'started',
        action: request.action,
        ...entityFields,
      });

      const headers = new Headers({
        'content-type': 'application/json',
        'x-internal-api-key': internalApiSecret,
      });
      const correlationHeaders = createBillingCorrelationHeaders(callContext);
      for (const key of Object.keys(correlationHeaders)) {
        const value = correlationHeaders[key];
        headers.set(key, value);
      }

      const response = await fetch(
        `${env.KILOCODE_BACKEND_BASE_URL}/api/internal/kiloclaw/billing-side-effects`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
        }
      );

      const durationMs = performance.now() - startedAt;
      if (!response.ok) {
        const body = await response.text();
        log('error', 'Billing side effect call failed', {
          event: 'downstream_call',
          outcome: 'failed',
          action: request.action,
          statusCode: response.status,
          durationMs,
          ...entityFields,
        });
        throw new Error(`Billing side effect failed (${response.status}): ${body}`);
      }

      const result: SideEffectResponse<T> = await response.json();
      log('info', 'Completed billing side effect call', {
        event: 'downstream_call',
        outcome: 'completed',
        action: request.action,
        statusCode: response.status,
        durationMs,
        ...entityFields,
      });

      return result;
    }
  );
}

async function requestKiloClaw<T>(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  path: string,
  init?: RequestInit,
  entityFields: BillingEntityFields = {}
): Promise<T> {
  if (!env.KILOCLAW_INTERNAL_API_SECRET) {
    throw new Error('KILOCLAW_INTERNAL_API_SECRET is not configured');
  }
  const kiloclawInternalApiSecret = env.KILOCLAW_INTERNAL_API_SECRET;

  const billingCallId = crypto.randomUUID();
  const startedAt = performance.now();
  const callContext = {
    ...context,
    billingCallId,
  };

  return await withLogTags(
    {
      source: 'requestKiloClaw',
      tags: {
        ...callContext,
        billingComponent: 'kiloclaw_platform',
      },
    },
    async () => {
      log('info', 'Starting kiloclaw platform call', {
        event: 'downstream_call',
        outcome: 'started',
        action: init?.method ?? 'GET',
        path,
        ...entityFields,
      });

      const headers = new Headers(init?.headers);
      headers.set('content-type', 'application/json');
      headers.set('x-internal-api-key', kiloclawInternalApiSecret);
      const correlationHeaders = createBillingCorrelationHeaders(callContext);
      for (const key of Object.keys(correlationHeaders)) {
        const value = correlationHeaders[key];
        headers.set(key, value);
      }

      const response = await env.KILOCLAW.fetch(
        new Request(`https://kiloclaw${path}`, {
          ...init,
          headers,
        })
      );

      const durationMs = performance.now() - startedAt;
      if (!response.ok) {
        const responseBody = await response.text();
        log('error', 'Kiloclaw platform call failed', {
          event: 'downstream_call',
          outcome: 'failed',
          action: init?.method ?? 'GET',
          path,
          statusCode: response.status,
          durationMs,
          ...entityFields,
        });
        throw new KiloClawApiError(response.status, responseBody);
      }

      const result = (await response.json()) as T;
      log('info', 'Completed kiloclaw platform call', {
        event: 'downstream_call',
        outcome: 'completed',
        action: init?.method ?? 'GET',
        path,
        statusCode: response.status,
        durationMs,
        ...entityFields,
      });
      return result;
    }
  );
}

async function startInstance(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  userId: string,
  instanceId?: string
): Promise<void> {
  const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
  await requestKiloClaw<{ ok: true }>(
    env,
    context,
    `/api/platform/start${params}`,
    {
      method: 'POST',
      body: JSON.stringify({ userId }),
    },
    { userId, instanceId }
  );
}

async function stopInstance(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  userId: string,
  instanceId?: string
): Promise<void> {
  const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
  await requestKiloClaw<{ ok: true }>(
    env,
    context,
    `/api/platform/stop${params}`,
    {
      method: 'POST',
      body: JSON.stringify({ userId }),
    },
    { userId, instanceId }
  );
}

async function destroyInstance(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  userId: string,
  instanceId?: string
): Promise<void> {
  const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
  await requestKiloClaw<{ ok: true }>(
    env,
    context,
    `/api/platform/destroy${params}`,
    {
      method: 'POST',
      body: JSON.stringify({ userId }),
    },
    { userId, instanceId }
  );
}

async function trySendEmail(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  userId: string,
  userEmail: string,
  emailType: string,
  templateName: TemplateName,
  templateVars: Record<string, string>,
  summary: BillingSummary,
  subjectOverride?: string
): Promise<boolean> {
  const result = await database
    .insert(kiloclaw_email_log)
    .values({ user_id: userId, email_type: emailType })
    .onConflictDoNothing();

  if (result.rowCount === 0) {
    summary.emails_skipped++;
    return false;
  }

  try {
    const emailResult = await callBillingSideEffect(
      env,
      context,
      {
        action: 'send_email',
        input: {
          to: userEmail,
          templateName,
          templateVars,
          subjectOverride,
        },
      },
      { userId }
    );

    if (!emailResult.sent) {
      if (emailResult.reason === 'provider_not_configured') {
        await database
          .delete(kiloclaw_email_log)
          .where(
            and(
              eq(kiloclaw_email_log.user_id, userId),
              eq(kiloclaw_email_log.email_type, emailType)
            )
          );
      }
      summary.emails_skipped++;
      return false;
    }
  } catch (error) {
    try {
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(eq(kiloclaw_email_log.user_id, userId), eq(kiloclaw_email_log.email_type, emailType))
        );
    } catch (deleteError) {
      log('warn', 'Failed to remove email log row after send failure', {
        userId,
        emailType,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
    throw error;
  }

  summary.emails_sent++;
  return true;
}

async function projectPendingKiloPassBonusMicrodollars(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  params: {
    userId: string;
    microdollarsUsed: number;
    kiloPassThreshold: number | null;
  }
): Promise<number> {
  const result = await callBillingSideEffect(
    env,
    context,
    {
      action: 'project_pending_kilo_pass_bonus',
      input: params,
    },
    { userId: params.userId }
  );

  return result.projectedBonusMicrodollars;
}

async function maybeIssueKiloPassBonusFromUsageThreshold(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  params: { userId: string; nowIso: string }
): Promise<void> {
  await callBillingSideEffect(
    env,
    context,
    {
      action: 'issue_kilo_pass_bonus_from_usage_threshold',
      input: params,
    },
    { userId: params.userId }
  );
}

async function triggerUserAutoTopUp(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  user: UserForAutoTopUp
): Promise<void> {
  await callBillingSideEffect(
    env,
    context,
    {
      action: 'trigger_user_auto_top_up',
      input: { user },
    },
    { userId: user.id }
  );
}

async function ensureAutoIntroSchedule(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  stripeSubscriptionId: string,
  userId: string
): Promise<boolean> {
  const result = await callBillingSideEffect(
    env,
    context,
    {
      action: 'ensure_auto_intro_schedule',
      input: {
        stripeSubscriptionId,
        userId,
      },
    },
    { userId, stripeSubscriptionId }
  );

  return result.repaired;
}

async function trackTrialEnd(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  params: {
    clickId?: string;
    customerId: string;
    customerEmail: string;
    eventDateIso: string;
  }
): Promise<void> {
  if (!params.clickId) return;

  await callBillingSideEffect(
    env,
    context,
    {
      action: 'track_trial_end',
      input: params,
    },
    { userId: params.customerId }
  );
}

async function autoResumeIfSuspended(
  env: BillingWorkerEnv,
  database: WorkerDb,
  context: SweepExecutionContext,
  kiloUserId: string,
  instanceId: string | undefined
): Promise<void> {
  const instanceFilter = instanceId
    ? and(
        eq(kiloclaw_instances.id, instanceId),
        eq(kiloclaw_instances.user_id, kiloUserId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    : and(eq(kiloclaw_instances.user_id, kiloUserId), isNull(kiloclaw_instances.destroyed_at));

  const [targetInstance] = await database
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
    })
    .from(kiloclaw_instances)
    .where(instanceFilter)
    .limit(1);

  if (targetInstance) {
    try {
      await startInstance(env, context, kiloUserId, workerInstanceId(targetInstance));
    } catch (error) {
      log('error', 'Failed to auto-resume instance', {
        userId: kiloUserId,
        instanceId: targetInstance.id,
        error: errorMessage(error),
      });
      return;
    }
  }

  const resettableEmailTypes = [
    'claw_suspended_trial',
    'claw_suspended_subscription',
    'claw_suspended_payment',
    'claw_destruction_warning',
    'claw_instance_destroyed',
    'claw_credit_renewal_failed',
  ];

  await database
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, kiloUserId),
        inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
      )
    );

  const subscriptionFilter = instanceId
    ? and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.instance_id, instanceId)
      )
    : eq(kiloclaw_subscriptions.user_id, kiloUserId);

  await database
    .update(kiloclaw_subscriptions)
    .set({ suspended_at: null, destruction_deadline: null })
    .where(subscriptionFilter);

  log('info', 'Auto-resume completed', {
    userId: kiloUserId,
    instanceId: instanceId ?? null,
    hadActiveInstance: !!targetInstance,
  });
}

async function processCreditRenewalRow(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  row: CreditRenewalRow,
  clawUrl: string,
  summary: BillingSummary
): Promise<void> {
  const { user_id: userId, credit_renewal_at: renewalAt } = row;
  if (!renewalAt) return;

  const subscriptionWhere = row.instance_id
    ? and(
        eq(kiloclaw_subscriptions.user_id, userId),
        eq(kiloclaw_subscriptions.instance_id, row.instance_id)
      )
    : eq(kiloclaw_subscriptions.user_id, userId);

  if (row.cancel_at_period_end) {
    await database
      .update(kiloclaw_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        auto_top_up_triggered_for_period: null,
      })
      .where(subscriptionWhere);

    summary.credit_renewals_canceled++;
    log('info', 'Credit renewal canceled at period end', { userId });
    return;
  }

  const effectivePlan =
    row.scheduled_plan === 'commit' || row.scheduled_plan === 'standard'
      ? row.scheduled_plan
      : row.plan;

  if (effectivePlan !== 'commit' && effectivePlan !== 'standard') {
    log('error', 'Credit renewal found unexpected plan', { userId, plan: effectivePlan });
    return;
  }

  const applyingPlanSwitch = row.scheduled_plan !== null && row.scheduled_plan !== row.plan;
  const costMicrodollars = KILOCLAW_PLAN_COST_MICRODOLLARS[effectivePlan];
  const periodMonths = effectivePlan === 'commit' ? 6 : 1;
  const rawBalance = row.total_microdollars_acquired - row.microdollars_used;
  const projectedBonus = await projectPendingKiloPassBonusMicrodollars(env, context, {
    userId,
    microdollarsUsed: row.microdollars_used + costMicrodollars,
    kiloPassThreshold: row.kilo_pass_threshold,
  });
  const effectiveBalance = rawBalance + projectedBonus;

  if (effectiveBalance >= costMicrodollars) {
    const periodKey = format(new Date(renewalAt), 'yyyy-MM');
    const instanceId = row.instance_id ?? 'unknown';
    const categoryPrefix =
      effectivePlan === 'commit'
        ? `kiloclaw-subscription-commit:${instanceId}`
        : `kiloclaw-subscription:${instanceId}`;
    const deductionCategory = `${categoryPrefix}:${periodKey}`;
    const newPeriodStart = renewalAt;
    const newPeriodEnd = addMonths(new Date(renewalAt), periodMonths).toISOString();
    const wasPastDue = row.status === 'past_due';

    let deductionIsNew = false;

    await database.transaction(async tx => {
      const deductionResult = await tx
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: userId,
          amount_microdollars: -costMicrodollars,
          is_free: false,
          description: `KiloClaw ${effectivePlan} renewal`,
          credit_category: deductionCategory,
          check_category_uniqueness: true,
          original_baseline_microdollars_used: row.microdollars_used,
        })
        .onConflictDoNothing();

      deductionIsNew = (deductionResult.rowCount ?? 0) > 0;
      if (!deductionIsNew) return;

      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));

      const updateSet: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {
        current_period_start: newPeriodStart,
        current_period_end: newPeriodEnd,
        credit_renewal_at: newPeriodEnd,
        auto_top_up_triggered_for_period: null,
      };

      if (applyingPlanSwitch) {
        updateSet.plan = effectivePlan;
        updateSet.scheduled_plan = null;
        updateSet.scheduled_by = null;
        updateSet.commit_ends_at =
          effectivePlan === 'commit' ? addMonths(new Date(newPeriodStart), 6).toISOString() : null;
      }

      if (
        effectivePlan === 'commit' &&
        !applyingPlanSwitch &&
        row.commit_ends_at &&
        new Date(row.commit_ends_at) <= new Date(newPeriodStart)
      ) {
        updateSet.commit_ends_at = addMonths(new Date(row.commit_ends_at), 6).toISOString();
      }

      if (wasPastDue) {
        updateSet.status = 'active';
        updateSet.past_due_since = null;
      }

      await tx.update(kiloclaw_subscriptions).set(updateSet).where(subscriptionWhere);
    });

    if (!deductionIsNew) {
      summary.credit_renewals_skipped_duplicate++;
      log('info', 'Credit renewal skipped duplicate deduction', { userId, deductionCategory });
      return;
    }

    try {
      await maybeIssueKiloPassBonusFromUsageThreshold(env, context, {
        userId,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      log('error', 'Kilo Pass bonus evaluation failed after credit renewal', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (wasPastDue && !row.suspended_at) {
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, userId),
            eq(kiloclaw_email_log.email_type, 'claw_credit_renewal_failed')
          )
        );
    }

    if (wasPastDue && row.suspended_at) {
      await autoResumeIfSuspended(env, database, context, userId, row.instance_id ?? undefined);
    }

    summary.credit_renewals++;
    log('info', 'Credit renewal succeeded', {
      userId,
      plan: effectivePlan,
      costMicrodollars,
      newPeriodEnd,
      applyingPlanSwitch,
    });
    return;
  }

  if (row.auto_top_up_enabled && !row.auto_top_up_triggered_for_period) {
    await database
      .update(kiloclaw_subscriptions)
      .set({ auto_top_up_triggered_for_period: renewalAt })
      .where(subscriptionWhere);

    try {
      await triggerUserAutoTopUp(env, context, {
        id: userId,
        total_microdollars_acquired: row.total_microdollars_acquired,
        microdollars_used: row.microdollars_used,
        auto_top_up_enabled: row.auto_top_up_enabled,
        next_credit_expiration_at: row.next_credit_expiration_at,
        updated_at: row.user_updated_at,
      });
    } catch (error) {
      log('error', 'Auto top-up trigger failed during credit renewal', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    summary.credit_renewals_auto_top_up++;
    log('info', 'Credit renewal auto top-up triggered', { userId });
    return;
  }

  await database
    .update(kiloclaw_subscriptions)
    .set({
      status: 'past_due',
      past_due_since: sql`COALESCE(${kiloclaw_subscriptions.past_due_since}, now())`,
    })
    .where(subscriptionWhere);

  await trySendEmail(
    database,
    env,
    context,
    userId,
    row.email,
    'claw_credit_renewal_failed',
    'clawCreditRenewalFailed',
    { claw_url: clawUrl },
    summary
  );

  summary.credit_renewals_past_due++;
  log('info', 'Credit renewal insufficient balance', {
    userId,
    effectiveBalance,
    costMicrodollars,
  });
}

async function runCreditRenewalSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const now = new Date().toISOString();
  const clawUrl = buildClawUrl(env);

  const creditRenewalRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      instance_id: kiloclaw_subscriptions.instance_id,
      plan: kiloclaw_subscriptions.plan,
      status: kiloclaw_subscriptions.status,
      credit_renewal_at: kiloclaw_subscriptions.credit_renewal_at,
      current_period_end: kiloclaw_subscriptions.current_period_end,
      cancel_at_period_end: kiloclaw_subscriptions.cancel_at_period_end,
      scheduled_plan: kiloclaw_subscriptions.scheduled_plan,
      commit_ends_at: kiloclaw_subscriptions.commit_ends_at,
      past_due_since: kiloclaw_subscriptions.past_due_since,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      auto_top_up_triggered_for_period: kiloclaw_subscriptions.auto_top_up_triggered_for_period,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
      auto_top_up_enabled: kilocode_users.auto_top_up_enabled,
      kilo_pass_threshold: kilocode_users.kilo_pass_threshold,
      next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      user_updated_at: kilocode_users.updated_at,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.payment_source, 'credits'),
        isNull(kiloclaw_subscriptions.stripe_subscription_id),
        inArray(kiloclaw_subscriptions.status, ['active', 'past_due']),
        lte(kiloclaw_subscriptions.credit_renewal_at, now)
      )
    );

  for (const row of creditRenewalRows) {
    try {
      await processCreditRenewalRow(database, env, context, row, clawUrl, summary);
    } catch (error) {
      summary.errors++;
      log('error', 'Credit renewal sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runInterruptedAutoResumeSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const interruptedResumeRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.payment_source, 'credits'),
        eq(kiloclaw_subscriptions.status, 'active'),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of interruptedResumeRows) {
    try {
      await autoResumeIfSuspended(
        env,
        database,
        context,
        row.user_id,
        row.instance_id ?? undefined
      );
      summary.interrupted_auto_resumes++;
    } catch (error) {
      summary.errors++;
      log('error', 'Interrupted auto-resume retry failed', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function stopInstanceForEnforcement(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  row: {
    user_id: string;
    instance_id: string | null;
    sandbox_id: string | null;
  }
): Promise<void> {
  if (!row.instance_id) return;

  try {
    await stopInstance(
      env,
      context,
      row.user_id,
      workerInstanceId({ id: row.instance_id, sandbox_id: row.sandbox_id })
    );
  } catch (error) {
    const isExpected =
      error instanceof KiloClawApiError && (error.statusCode === 404 || error.statusCode === 409);
    log(isExpected ? 'info' : 'error', 'Stop instance during billing enforcement failed', {
      userId: row.user_id,
      instanceId: row.instance_id,
      statusCode: error instanceof KiloClawApiError ? error.statusCode : null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function destroyInstanceForEnforcement(
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  row: {
    user_id: string;
    instance_id: string | null;
    sandbox_id: string | null;
  }
): Promise<void> {
  if (!row.instance_id) return;

  try {
    await destroyInstance(
      env,
      context,
      row.user_id,
      workerInstanceId({ id: row.instance_id, sandbox_id: row.sandbox_id })
    );
  } catch (error) {
    const isExpected =
      error instanceof KiloClawApiError && (error.statusCode === 404 || error.statusCode === 409);
    log(isExpected ? 'info' : 'error', 'Destroy instance during billing enforcement failed', {
      userId: row.user_id,
      instanceId: row.instance_id,
      statusCode: error instanceof KiloClawApiError ? error.statusCode : null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runTrialExpirySweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const now = new Date().toISOString();
  const clawUrl = buildClawUrl(env);

  const expiredTrials = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'trialing'),
        lt(kiloclaw_subscriptions.trial_ends_at, now),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of expiredTrials) {
    try {
      await stopInstanceForEnforcement(env, context, row);

      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          status: 'canceled',
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.id, row.id));

      const [attribution] = await database
        .select({ tracking_id: user_affiliate_attributions.tracking_id })
        .from(user_affiliate_attributions)
        .where(
          and(
            eq(user_affiliate_attributions.user_id, row.user_id),
            eq(user_affiliate_attributions.provider, 'impact')
          )
        )
        .limit(1);

      await trackTrialEnd(env, context, {
        clickId: attribution?.tracking_id,
        customerId: row.user_id,
        customerEmail: row.email,
        eventDateIso: now,
      }).catch(error => {
        log('warn', 'Impact trial end tracking failed during sweep', {
          userId: row.user_id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      await trySendEmail(
        database,
        env,
        context,
        row.user_id,
        row.email,
        'claw_suspended_trial',
        'clawSuspendedTrial',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );

      summary.sweep1_trial_expiry++;
    } catch (error) {
      summary.errors++;
      log('error', 'Trial expiry sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runSubscriptionExpirySweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const now = new Date().toISOString();
  const clawUrl = buildClawUrl(env);

  const expiredSubscriptions = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'canceled'),
        lt(kiloclaw_subscriptions.current_period_end, now),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of expiredSubscriptions) {
    try {
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);

      await stopInstanceForEnforcement(env, context, row);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.id, row.id));

      await trySendEmail(
        database,
        env,
        context,
        row.user_id,
        row.email,
        'claw_suspended_subscription',
        'clawSuspendedSubscription',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );

      summary.sweep2_subscription_expiry++;
    } catch (error) {
      summary.errors++;
      log('error', 'Subscription expiry sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runInstanceDestructionSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const now = new Date().toISOString();
  const clawUrl = buildClawUrl(env);

  const destructionCandidates = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        lt(kiloclaw_subscriptions.destruction_deadline, now),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of destructionCandidates) {
    try {
      await destroyInstanceForEnforcement(env, context, row);

      if (row.instance_id) {
        await database
          .update(kiloclaw_instances)
          .set({ destroyed_at: now })
          .where(
            and(eq(kiloclaw_instances.id, row.instance_id), isNull(kiloclaw_instances.destroyed_at))
          );
      }

      await database
        .update(kiloclaw_subscriptions)
        .set({ destruction_deadline: null })
        .where(eq(kiloclaw_subscriptions.id, row.id));

      await trySendEmail(
        database,
        env,
        context,
        row.user_id,
        row.email,
        'claw_instance_destroyed',
        'clawInstanceDestroyed',
        { claw_url: clawUrl },
        summary
      );

      await database
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, row.user_id),
            sql`${kiloclaw_email_log.email_type} LIKE 'claw_instance_ready:%'`
          )
        );

      summary.sweep3_instance_destruction++;
    } catch (error) {
      summary.errors++;
      log('error', 'Instance destruction sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runPastDueCleanupSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const clawUrl = buildClawUrl(env);
  const fourteenDaysAgo = new Date(Date.now() - PAST_DUE_THRESHOLD_DAYS * MS_PER_DAY).toISOString();
  const now = new Date().toISOString();

  const pastDueRows = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'past_due'),
        lt(kiloclaw_subscriptions.past_due_since, fourteenDaysAgo),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of pastDueRows) {
    try {
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);

      await stopInstanceForEnforcement(env, context, row);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.id, row.id));

      await trySendEmail(
        database,
        env,
        context,
        row.user_id,
        row.email,
        'claw_suspended_payment',
        'clawSuspendedPayment',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );

      summary.sweep4_past_due_cleanup++;
    } catch (error) {
      summary.errors++;
      log('error', 'Past-due cleanup sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runIntroScheduleRepairSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const strandedIntroRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'active'),
        isNull(kiloclaw_subscriptions.stripe_schedule_id),
        isNotNull(kiloclaw_subscriptions.stripe_subscription_id),
        eq(kiloclaw_subscriptions.cancel_at_period_end, false)
      )
    );

  for (const row of strandedIntroRows) {
    try {
      const stripeSubId = row.stripe_subscription_id;
      if (!stripeSubId) continue;

      const repaired = await ensureAutoIntroSchedule(env, context, stripeSubId, row.user_id);
      if (!repaired) continue;

      summary.sweep5_intro_schedules_repaired++;
      log('info', 'Intro schedule repair sweep completed for row', {
        userId: row.user_id,
        stripeSubscriptionId: stripeSubId,
      });
    } catch (error) {
      summary.errors++;
      log('error', 'Intro schedule repair sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runDestructionWarningSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const advisoryNow = new Date().toISOString();
  const twoDaysFromNow = new Date(Date.now() + DESTRUCTION_WARNING_DAYS * MS_PER_DAY).toISOString();
  const clawUrl = buildClawUrl(env);

  const destructionWarningRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      destruction_deadline: kiloclaw_subscriptions.destruction_deadline,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        gte(kiloclaw_subscriptions.destruction_deadline, advisoryNow),
        lte(kiloclaw_subscriptions.destruction_deadline, twoDaysFromNow),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of destructionWarningRows) {
    try {
      if (!row.destruction_deadline) continue;
      const sent = await trySendEmail(
        database,
        env,
        context,
        row.user_id,
        row.email,
        'claw_destruction_warning',
        'clawDestructionWarning',
        {
          destruction_date: formatDateForEmail(new Date(row.destruction_deadline)),
          claw_url: clawUrl,
        },
        summary
      );
      if (sent) summary.destruction_warnings++;
    } catch (error) {
      summary.errors++;
      log('error', 'Destruction warning sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runTrialWarningSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const advisoryNow = new Date().toISOString();
  const trialWarningCutoff = new Date(Date.now() + TRIAL_WARNING_DAYS * MS_PER_DAY).toISOString();
  const clawUrl = buildClawUrl(env);

  const trialWarningRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'trialing'),
        gte(kiloclaw_subscriptions.trial_ends_at, advisoryNow),
        lte(kiloclaw_subscriptions.trial_ends_at, trialWarningCutoff),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of trialWarningRows) {
    try {
      if (!row.trial_ends_at) continue;

      const daysRemaining = Math.ceil(
        (new Date(row.trial_ends_at).getTime() - Date.now()) / MS_PER_DAY
      );

      const sent =
        daysRemaining <= 1
          ? await trySendEmail(
              database,
              env,
              context,
              row.user_id,
              row.email,
              'claw_trial_1d',
              'clawTrialExpiresTomorrow',
              { claw_url: clawUrl },
              summary
            )
          : await trySendEmail(
              database,
              env,
              context,
              row.user_id,
              row.email,
              'claw_trial_5d',
              'clawTrialEndingSoon',
              {
                days_remaining: String(daysRemaining),
                claw_url: clawUrl,
              },
              summary,
              `Your KiloClaw Trial Ends in ${daysRemaining} Days`
            );

      if (sent) summary.trial_warnings++;
    } catch (error) {
      summary.errors++;
      log('error', 'Trial warning sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runEarlybirdWarningSweep(
  database: WorkerDb,
  env: BillingWorkerEnv,
  context: SweepExecutionContext,
  summary: BillingSummary
): Promise<void> {
  const clawUrl = buildClawUrl(env);
  const earlybirdExpiry = new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE);
  const daysUntilEarlybird = Math.ceil((earlybirdExpiry.getTime() - Date.now()) / MS_PER_DAY);

  if (daysUntilEarlybird <= 0 || daysUntilEarlybird > 14) {
    return;
  }

  const earlybirdRows = await database
    .select({
      user_id: kiloclaw_earlybird_purchases.user_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_earlybird_purchases)
    .innerJoin(kilocode_users, eq(kiloclaw_earlybird_purchases.user_id, kilocode_users.id))
    .leftJoin(
      kiloclaw_subscriptions,
      eq(kiloclaw_earlybird_purchases.user_id, kiloclaw_subscriptions.user_id)
    )
    .where(
      and(
        sql`(${kiloclaw_subscriptions.status} IS NULL OR ${kiloclaw_subscriptions.status} NOT IN ('active', 'trialing'))`,
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of earlybirdRows) {
    try {
      const expiryDate = formatDateForEmail(earlybirdExpiry);
      const sent =
        daysUntilEarlybird <= 1
          ? await trySendEmail(
              database,
              env,
              context,
              row.user_id,
              row.email,
              'claw_earlybird_1d',
              'clawEarlybirdExpiresTomorrow',
              {
                expiry_date: expiryDate,
                claw_url: clawUrl,
              },
              summary
            )
          : await trySendEmail(
              database,
              env,
              context,
              row.user_id,
              row.email,
              'claw_earlybird_14d',
              'clawEarlybirdEndingSoon',
              {
                days_remaining: String(daysUntilEarlybird),
                expiry_date: expiryDate,
                claw_url: clawUrl,
              },
              summary
            );

      if (sent) summary.earlybird_warnings++;
    } catch (error) {
      summary.errors++;
      log('error', 'Earlybird warning sweep failed for user', {
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function runSweep(
  env: BillingWorkerEnv,
  message: BillingSweepMessage,
  attempt = 1
): Promise<BillingSummary> {
  const context = createSweepContext(message, attempt);

  return await withLogTags(
    {
      source: 'runSweep',
      tags: {
        ...context,
        billingComponent: 'worker',
      },
    },
    async () => {
      const database = getDb(env);
      const summary = createSummary();
      const startedAt = performance.now();

      log('info', 'Starting billing sweep', {
        event: 'sweep_started',
        outcome: 'started',
      });

      try {
        switch (message.sweep) {
          case 'credit_renewal':
            await runCreditRenewalSweep(database, env, context, summary);
            break;
          case 'interrupted_auto_resume':
            await runInterruptedAutoResumeSweep(database, env, context, summary);
            break;
          case 'trial_expiry':
            await runTrialExpirySweep(database, env, context, summary);
            break;
          case 'subscription_expiry':
            await runSubscriptionExpirySweep(database, env, context, summary);
            break;
          case 'instance_destruction':
            await runInstanceDestructionSweep(database, env, context, summary);
            break;
          case 'past_due_cleanup':
            await runPastDueCleanupSweep(database, env, context, summary);
            break;
          case 'intro_schedule_repair':
            await runIntroScheduleRepairSweep(database, env, context, summary);
            break;
          case 'destruction_warning':
            await runDestructionWarningSweep(database, env, context, summary);
            break;
          case 'trial_warning':
            await runTrialWarningSweep(database, env, context, summary);
            break;
          case 'earlybird_warning':
            await runEarlybirdWarningSweep(database, env, context, summary);
            break;
        }

        log('info', 'Completed billing sweep', {
          event: 'sweep_completed',
          outcome: 'completed',
          durationMs: performance.now() - startedAt,
          summary,
        });
        return summary;
      } catch (error) {
        log('error', 'Billing sweep failed', {
          event: 'sweep_failed',
          outcome: 'failed',
          durationMs: performance.now() - startedAt,
          error: errorMessage(error),
        });
        throw error;
      }
    }
  );
}
