import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  BILLING_FLOW,
  readBillingCorrelationHeaders,
  type BillingCorrelationContext,
} from '@kilocode/worker-utils/kiloclaw-billing-observability';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { send as sendEmail } from '@/lib/email';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import { ensureAutoIntroSchedule } from '@/lib/kiloclaw/stripe-handlers';
import { isIntroPriceId } from '@/lib/kiloclaw/stripe-price-ids.server';
import { client as stripe } from '@/lib/stripe-client';
import { trackTrialEnd } from '@/lib/impact';
import { projectPendingKiloPassBonusMicrodollars } from '@/lib/kiloclaw/credit-billing';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';

const billingTemplateNames = [
  'clawSuspendedTrial',
  'clawSuspendedSubscription',
  'clawSuspendedPayment',
  'clawDestructionWarning',
  'clawInstanceDestroyed',
  'clawTrialEndingSoon',
  'clawTrialExpiresTomorrow',
  'clawEarlybirdEndingSoon',
  'clawEarlybirdExpiresTomorrow',
  'clawCreditRenewalFailed',
] as const;

type BillingSideEffectLogFields = BillingCorrelationContext & {
  billingFlow: typeof BILLING_FLOW;
  billingComponent: 'side_effects';
  event: 'downstream_action' | 'request_rejected';
  outcome: 'started' | 'completed' | 'failed';
  action?: string;
  durationMs?: number;
  userId?: string;
  stripeSubscriptionId?: string;
  templateName?: (typeof billingTemplateNames)[number];
  statusCode?: number;
  error?: string;
};

type SendEmailResult = Awaited<ReturnType<typeof sendEmail>>;

function logBillingSideEffect(
  level: 'info' | 'error',
  message: string,
  fields: Omit<BillingSideEffectLogFields, 'billingFlow' | 'billingComponent'>
) {
  const record = JSON.stringify({
    level,
    message,
    billingFlow: BILLING_FLOW,
    billingComponent: 'side_effects',
    ...fields,
  });

  if (level === 'error') {
    console.error(record);
    return;
  }
  console.log(record);
}

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send_email'),
    input: z.object({
      to: z.email(),
      templateName: z.enum(billingTemplateNames),
      templateVars: z.record(z.string(), z.string()),
      subjectOverride: z.string().min(1).optional(),
    }),
  }),
  z.object({
    action: z.literal('trigger_user_auto_top_up'),
    input: z.object({
      user: z.object({
        id: z.string().min(1),
        total_microdollars_acquired: z.number().int(),
        microdollars_used: z.number().int(),
        next_credit_expiration_at: z.string().datetime().nullable(),
        updated_at: z.string().datetime(),
        auto_top_up_enabled: z.boolean(),
      }),
    }),
  }),
  z.object({
    action: z.literal('ensure_auto_intro_schedule'),
    input: z.object({
      stripeSubscriptionId: z.string().min(1),
      userId: z.string().min(1),
    }),
  }),
  z.object({
    action: z.literal('track_trial_end'),
    input: z.object({
      clickId: z.string().min(1).optional(),
      customerId: z.string().min(1),
      customerEmail: z.email(),
      eventDateIso: z.string().datetime(),
    }),
  }),
  z.object({
    action: z.literal('project_pending_kilo_pass_bonus'),
    input: z.object({
      userId: z.string().min(1),
      microdollarsUsed: z.number().int(),
      kiloPassThreshold: z.number().int().nullable(),
    }),
  }),
  z.object({
    action: z.literal('issue_kilo_pass_bonus_from_usage_threshold'),
    input: z.object({
      userId: z.string().min(1),
      nowIso: z.string().datetime(),
    }),
  }),
]);

function getActionLogFields(body: z.infer<typeof BodySchema>): {
  userId?: string;
  stripeSubscriptionId?: string;
  templateName?: (typeof billingTemplateNames)[number];
} {
  switch (body.action) {
    case 'send_email':
      return { templateName: body.input.templateName };
    case 'trigger_user_auto_top_up':
      return { userId: body.input.user.id };
    case 'ensure_auto_intro_schedule':
      return {
        userId: body.input.userId,
        stripeSubscriptionId: body.input.stripeSubscriptionId,
      };
    case 'track_trial_end':
      return { userId: body.input.customerId };
    case 'project_pending_kilo_pass_bonus':
      return { userId: body.input.userId };
    case 'issue_kilo_pass_bonus_from_usage_threshold':
      return { userId: body.input.userId };
  }
}

export async function POST(request: NextRequest) {
  const correlation = readBillingCorrelationHeaders(request.headers) ?? undefined;
  const secret = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !secretMatches(secret, INTERNAL_API_SECRET)) {
    logBillingSideEffect('error', 'Rejected billing side effect request', {
      ...correlation,
      event: 'request_rejected',
      outcome: 'failed',
      statusCode: 401,
      error: 'Unauthorized',
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    logBillingSideEffect('error', 'Rejected billing side effect request', {
      ...correlation,
      event: 'request_rejected',
      outcome: 'failed',
      statusCode: 400,
      error: 'Invalid body',
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const startedAt = performance.now();
  const actionFields = getActionLogFields(parsed.data);

  logBillingSideEffect('info', 'Starting billing side effect request', {
    ...correlation,
    ...actionFields,
    event: 'downstream_action',
    outcome: 'started',
    action: parsed.data.action,
  });

  try {
    let payload:
      | SendEmailResult
      | { ok: true }
      | { repaired: boolean }
      | { tracked: boolean }
      | { projectedBonusMicrodollars: number };

    switch (parsed.data.action) {
      case 'send_email':
        payload = await sendEmail(parsed.data.input);
        break;

      case 'trigger_user_auto_top_up':
        await maybePerformAutoTopUp(parsed.data.input.user);
        payload = { ok: true };
        break;

      case 'ensure_auto_intro_schedule': {
        const liveSub = await stripe.subscriptions.retrieve(parsed.data.input.stripeSubscriptionId);
        const priceId = liveSub.items.data[0]?.price?.id;
        if (!priceId || !isIntroPriceId(priceId) || liveSub.schedule) {
          payload = { repaired: false };
          break;
        }

        await ensureAutoIntroSchedule(
          parsed.data.input.stripeSubscriptionId,
          parsed.data.input.userId
        );
        payload = { repaired: true };
        break;
      }

      case 'track_trial_end':
        if (!parsed.data.input.clickId) {
          payload = { tracked: false };
          break;
        }

        await trackTrialEnd({
          clickId: parsed.data.input.clickId,
          customerId: parsed.data.input.customerId,
          customerEmail: parsed.data.input.customerEmail,
          eventDate: new Date(parsed.data.input.eventDateIso),
        });
        payload = { tracked: true };
        break;

      case 'project_pending_kilo_pass_bonus':
        payload = {
          projectedBonusMicrodollars: await projectPendingKiloPassBonusMicrodollars({
            userId: parsed.data.input.userId,
            microdollarsUsed: parsed.data.input.microdollarsUsed,
            kiloPassThreshold: parsed.data.input.kiloPassThreshold,
          }),
        };
        break;

      case 'issue_kilo_pass_bonus_from_usage_threshold':
        await maybeIssueKiloPassBonusFromUsageThreshold({
          kiloUserId: parsed.data.input.userId,
          nowIso: parsed.data.input.nowIso,
        });
        payload = { ok: true };
        break;
    }

    logBillingSideEffect('info', 'Completed billing side effect request', {
      ...correlation,
      ...actionFields,
      event: 'downstream_action',
      outcome: 'completed',
      action: parsed.data.action,
      durationMs: performance.now() - startedAt,
      statusCode: 200,
    });

    return NextResponse.json(payload);
  } catch (error) {
    logBillingSideEffect('error', 'Billing side effect request failed', {
      ...correlation,
      ...actionFields,
      event: 'downstream_action',
      outcome: 'failed',
      action: parsed.data.action,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      statusCode: 500,
    });
    throw error;
  }
}
