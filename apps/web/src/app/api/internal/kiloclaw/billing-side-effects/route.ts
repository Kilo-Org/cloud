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
import { enqueueAffiliateEventForUser } from '@/lib/impact/affiliate-events';
import { logImpactReferralDebug } from '@/lib/impact/debug';
import { processPersonalKiloClawPaidConversion } from '@/lib/impact/kiloclaw-referrals';
import { projectPendingKiloPassBonusMicrodollars } from '@/lib/kiloclaw/credit-billing';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';

const personalBillingTemplateNames = [
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
  'clawComplementaryInferenceEnded',
] as const;

const organizationBillingTemplateNames = [
  'clawOrganizationTrialSuspendedBillingAuthority',
  'clawOrganizationTrialSuspendedUser',
  'clawOrganizationDestructionWarningBillingAuthority',
  'clawOrganizationDestructionWarningUser',
  'clawOrganizationInstanceDestroyedBillingAuthority',
  'clawOrganizationInstanceDestroyedUser',
] as const;

const billingTemplateNames = [
  ...personalBillingTemplateNames,
  ...organizationBillingTemplateNames,
] as const;

type BillingSideEffectLogFields = BillingCorrelationContext & {
  billingFlow: typeof BILLING_FLOW;
  billingComponent: 'side_effects';
  event: 'downstream_action' | 'request_rejected';
  outcome: 'started' | 'completed' | 'failed';
  action?: string;
  durationMs?: number;
  userId?: string;
  instanceId?: string;
  organizationId?: string;
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

function hasOrganizationDestinationPath(
  destinationUrl: string,
  organizationId: string,
  suffix: 'claw' | 'payment-details'
): boolean {
  return new URL(destinationUrl).pathname === `/organizations/${organizationId}/${suffix}`;
}

const OrganizationLifecycleIdentitySchema = {
  to: z.email(),
  userId: z.string().min(1),
  instanceId: z.string().min(1),
  organizationId: z.string().min(1),
};

const OrganizationLifecycleBillingAuthorityVarsSchema = z.object({
  organization_name: z.string().min(1),
  instance_label: z.string().min(1),
  destruction_date: z.string().min(1),
  organization_billing_url: z.url(),
});

const OrganizationLifecycleUserVarsSchema = z.object({
  organization_name: z.string().min(1),
  instance_label: z.string().min(1),
  destruction_date: z.string().min(1),
  organization_claw_url: z.url(),
});

const OrganizationLifecycleDestroyedBillingAuthorityVarsSchema = z.object({
  organization_name: z.string().min(1),
  instance_label: z.string().min(1),
  organization_billing_url: z.url(),
});

const OrganizationLifecycleDestroyedUserVarsSchema = z.object({
  organization_name: z.string().min(1),
  instance_label: z.string().min(1),
  organization_claw_url: z.url(),
});

const OrganizationTrialSuspendedBillingAuthorityInputSchema = z
  .object({
    ...OrganizationLifecycleIdentitySchema,
    templateName: z.literal('clawOrganizationTrialSuspendedBillingAuthority'),
    templateVars: OrganizationLifecycleBillingAuthorityVarsSchema,
  })
  .superRefine((input, ctx) => {
    if (
      !hasOrganizationDestinationPath(
        input.templateVars.organization_billing_url,
        input.organizationId,
        'payment-details'
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateVars', 'organization_billing_url'],
        message: 'Organization billing CTA must target the organization payment details page.',
      });
    }
  });

const OrganizationTrialSuspendedUserInputSchema = z
  .object({
    ...OrganizationLifecycleIdentitySchema,
    templateName: z.literal('clawOrganizationTrialSuspendedUser'),
    templateVars: OrganizationLifecycleUserVarsSchema,
  })
  .superRefine((input, ctx) => {
    if (
      !hasOrganizationDestinationPath(
        input.templateVars.organization_claw_url,
        input.organizationId,
        'claw'
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateVars', 'organization_claw_url'],
        message: 'Organization KiloClaw CTA must target the organization KiloClaw page.',
      });
    }
  });

const OrganizationDestructionWarningBillingAuthorityInputSchema = z
  .object({
    ...OrganizationLifecycleIdentitySchema,
    templateName: z.literal('clawOrganizationDestructionWarningBillingAuthority'),
    templateVars: OrganizationLifecycleBillingAuthorityVarsSchema,
  })
  .superRefine((input, ctx) => {
    if (
      !hasOrganizationDestinationPath(
        input.templateVars.organization_billing_url,
        input.organizationId,
        'payment-details'
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateVars', 'organization_billing_url'],
        message: 'Organization billing CTA must target the organization payment details page.',
      });
    }
  });

const OrganizationDestructionWarningUserInputSchema = z
  .object({
    ...OrganizationLifecycleIdentitySchema,
    templateName: z.literal('clawOrganizationDestructionWarningUser'),
    templateVars: OrganizationLifecycleUserVarsSchema,
  })
  .superRefine((input, ctx) => {
    if (
      !hasOrganizationDestinationPath(
        input.templateVars.organization_claw_url,
        input.organizationId,
        'claw'
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateVars', 'organization_claw_url'],
        message: 'Organization KiloClaw CTA must target the organization KiloClaw page.',
      });
    }
  });

const OrganizationInstanceDestroyedBillingAuthorityInputSchema = z
  .object({
    ...OrganizationLifecycleIdentitySchema,
    templateName: z.literal('clawOrganizationInstanceDestroyedBillingAuthority'),
    templateVars: OrganizationLifecycleDestroyedBillingAuthorityVarsSchema,
  })
  .superRefine((input, ctx) => {
    if (
      !hasOrganizationDestinationPath(
        input.templateVars.organization_billing_url,
        input.organizationId,
        'payment-details'
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateVars', 'organization_billing_url'],
        message: 'Organization billing CTA must target the organization payment details page.',
      });
    }
  });

const OrganizationInstanceDestroyedUserInputSchema = z
  .object({
    ...OrganizationLifecycleIdentitySchema,
    templateName: z.literal('clawOrganizationInstanceDestroyedUser'),
    templateVars: OrganizationLifecycleDestroyedUserVarsSchema,
  })
  .superRefine((input, ctx) => {
    if (
      !hasOrganizationDestinationPath(
        input.templateVars.organization_claw_url,
        input.organizationId,
        'claw'
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateVars', 'organization_claw_url'],
        message: 'Organization KiloClaw CTA must target the organization KiloClaw page.',
      });
    }
  });

const SendEmailInputSchema = z.union([
  z.object({
    to: z.email(),
    templateName: z.enum(personalBillingTemplateNames),
    templateVars: z.record(z.string(), z.string()),
    subjectOverride: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    instanceId: z.string().min(1).optional(),
  }),
  z.discriminatedUnion('templateName', [
    OrganizationTrialSuspendedBillingAuthorityInputSchema,
    OrganizationTrialSuspendedUserInputSchema,
    OrganizationDestructionWarningBillingAuthorityInputSchema,
    OrganizationDestructionWarningUserInputSchema,
    OrganizationInstanceDestroyedBillingAuthorityInputSchema,
    OrganizationInstanceDestroyedUserInputSchema,
  ]),
]);

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send_email'),
    input: SendEmailInputSchema,
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
    action: z.literal('enqueue_affiliate_event'),
    input: z.object({
      userId: z.string().min(1),
      provider: z.literal('impact'),
      eventType: z.enum(['trial_start', 'trial_end', 'sale']),
      dedupeKey: z.string().min(1),
      eventDateIso: z.string().datetime(),
      orderId: z.string().min(1),
      amount: z.number().nonnegative().optional(),
      currencyCode: z.string().min(1).optional(),
      itemCategory: z.string().min(1).optional(),
      itemName: z.string().min(1).optional(),
      itemSku: z.string().min(1).optional(),
      promoCode: z.string().min(1).optional(),
    }),
  }),
  z.object({
    action: z.literal('process_paid_conversion'),
    input: z.object({
      userId: z.string().min(1),
      dedupeKey: z.string().min(1),
      eventDateIso: z.string().datetime(),
      orderId: z.string().min(1),
      amount: z.number().nonnegative(),
      currencyCode: z.string().min(1),
      itemCategory: z.string().min(1),
      itemName: z.string().min(1),
      itemSku: z.string().min(1).optional(),
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
  instanceId?: string;
  organizationId?: string;
  stripeSubscriptionId?: string;
  templateName?: (typeof billingTemplateNames)[number];
} {
  switch (body.action) {
    case 'send_email':
      return {
        userId: body.input.userId,
        instanceId: body.input.instanceId,
        organizationId: 'organizationId' in body.input ? body.input.organizationId : undefined,
        templateName: body.input.templateName,
      };
    case 'trigger_user_auto_top_up':
      return { userId: body.input.user.id };
    case 'ensure_auto_intro_schedule':
      return {
        userId: body.input.userId,
        stripeSubscriptionId: body.input.stripeSubscriptionId,
      };
    case 'enqueue_affiliate_event':
      return { userId: body.input.userId };
    case 'process_paid_conversion':
      return { userId: body.input.userId };
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
      | { enqueued: boolean }
      | {
          affiliateSaleEnqueued: boolean;
          winningTouchType: 'referral' | 'affiliate' | 'none';
          conversionId: string | null;
          disqualificationReason: string | null;
        }
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

      case 'enqueue_affiliate_event':
        logImpactReferralDebug('KiloClaw billing side effect enqueueing affiliate event', {
          userId: parsed.data.input.userId,
          provider: parsed.data.input.provider,
          eventType: parsed.data.input.eventType,
          dedupeKey: parsed.data.input.dedupeKey,
          orderId: parsed.data.input.orderId,
          amount: parsed.data.input.amount,
          currencyCode: parsed.data.input.currencyCode,
          itemCategory: parsed.data.input.itemCategory,
        });
        await enqueueAffiliateEventForUser({
          userId: parsed.data.input.userId,
          provider: parsed.data.input.provider,
          eventType: parsed.data.input.eventType,
          dedupeKey: parsed.data.input.dedupeKey,
          eventDate: new Date(parsed.data.input.eventDateIso),
          orderId: parsed.data.input.orderId,
          amount: parsed.data.input.amount,
          currencyCode: parsed.data.input.currencyCode,
          itemCategory: parsed.data.input.itemCategory,
          itemName: parsed.data.input.itemName,
          itemSku: parsed.data.input.itemSku,
          promoCode: parsed.data.input.promoCode,
        });
        payload = { enqueued: true };
        break;

      case 'process_paid_conversion': {
        logImpactReferralDebug('KiloClaw billing side effect processing paid conversion', {
          userId: parsed.data.input.userId,
          dedupeKey: parsed.data.input.dedupeKey,
          orderId: parsed.data.input.orderId,
          amount: parsed.data.input.amount,
          currencyCode: parsed.data.input.currencyCode,
          itemCategory: parsed.data.input.itemCategory,
        });
        const disposition = await processPersonalKiloClawPaidConversion({
          userId: parsed.data.input.userId,
          sourcePaymentId: parsed.data.input.orderId,
          orderId: parsed.data.input.orderId,
          amount: parsed.data.input.amount,
          currencyCode: parsed.data.input.currencyCode,
          itemCategory: parsed.data.input.itemCategory,
          itemName: parsed.data.input.itemName,
          itemSku: parsed.data.input.itemSku,
          convertedAt: new Date(parsed.data.input.eventDateIso),
        });

        logImpactReferralDebug('KiloClaw billing side effect paid conversion disposition', {
          userId: parsed.data.input.userId,
          orderId: parsed.data.input.orderId,
          shouldEnqueueAffiliateSale: disposition.shouldEnqueueAffiliateSale,
          winningTouchType: disposition.winningTouchType,
          conversionId: disposition.conversionId,
          disqualificationReason: disposition.disqualificationReason,
        });

        if (disposition.shouldEnqueueAffiliateSale) {
          await enqueueAffiliateEventForUser({
            userId: parsed.data.input.userId,
            provider: 'impact',
            eventType: 'sale',
            dedupeKey: parsed.data.input.dedupeKey,
            eventDate: new Date(parsed.data.input.eventDateIso),
            orderId: parsed.data.input.orderId,
            amount: parsed.data.input.amount,
            currencyCode: parsed.data.input.currencyCode,
            itemCategory: parsed.data.input.itemCategory,
            itemName: parsed.data.input.itemName,
            itemSku: parsed.data.input.itemSku,
          });
        }

        payload = {
          affiliateSaleEnqueued: disposition.shouldEnqueueAffiliateSale,
          winningTouchType: disposition.winningTouchType,
          conversionId: disposition.conversionId,
          disqualificationReason: disposition.disqualificationReason,
        };
        break;
      }

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
