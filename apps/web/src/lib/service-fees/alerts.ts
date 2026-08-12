import 'server-only';

import { captureException } from '@sentry/nextjs';

import {
  AdminSlackNotificationError,
  sendAdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import type { ServiceFeeFlow } from '@/lib/service-fees/types';

export const SERVICE_FEE_MISSED_SENTRY_TAG = 'service_fee_missed';

export type MissedServiceFeeAlertInput = {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  kiloUserId?: string | null;
  organizationId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  currency: string;
  failureCode: string;
  attemptedAt: Date | string;
};

export type MissedServiceFeeAlertDependencies = {
  sendNotification?: typeof sendAdminSlackNotification;
  captureException?: typeof captureException;
};

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function ownerId(input: MissedServiceFeeAlertInput): string {
  return nonEmpty(input.organizationId) ?? nonEmpty(input.kiloUserId) ?? 'unknown';
}

function attemptedAtIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'invalid_timestamp';
  }
  return date.toISOString();
}

export function buildMissedServiceFeeAlertText(input: MissedServiceFeeAlertInput): string {
  const lines = [
    'Missed service fee',
    `assessment_key=${input.assessmentKey}`,
    `flow=${input.flow}`,
    `owner_id=${ownerId(input)}`,
    `stripe_checkout_session_id=${nonEmpty(input.stripeCheckoutSessionId) ?? 'none'}`,
    `stripe_invoice_id=${nonEmpty(input.stripeInvoiceId) ?? 'none'}`,
    `stripe_payment_intent_id=${nonEmpty(input.stripePaymentIntentId) ?? 'none'}`,
    `stripe_charge_id=${nonEmpty(input.stripeChargeId) ?? 'none'}`,
    `eligible_subtotal_minor=${input.eligibleSubtotalMinor}`,
    `expected_fee_minor=${input.expectedFeeMinor}`,
    `currency=${input.currency}`,
    `failure_code=${input.failureCode}`,
    `attempted_at=${attemptedAtIso(input.attemptedAt)}`,
  ];
  return lines.join('\n');
}

/**
 * Best-effort Admin Slack alert for a fail-open missed fee. Retries are not
 * deduplicated. Slack or Sentry failure must not change assessment outcome.
 */
export async function sendMissedServiceFeeAlert(
  input: MissedServiceFeeAlertInput,
  deps: MissedServiceFeeAlertDependencies = {}
): Promise<void> {
  const sendNotification = deps.sendNotification ?? sendAdminSlackNotification;
  const capture = deps.captureException ?? captureException;

  try {
    await sendNotification({
      text: buildMissedServiceFeeAlertText(input),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    const isSlackError = error instanceof AdminSlackNotificationError;
    capture(isSlackError ? error : new Error('Admin Slack notification failed'), {
      tags: { source: SERVICE_FEE_MISSED_SENTRY_TAG },
      extra: {
        kind: isSlackError ? error.kind : 'unexpected',
        status: isSlackError ? (error.status ?? null) : null,
        assessmentKey: input.assessmentKey,
        flow: input.flow,
        ownerId: ownerId(input),
        failureCode: input.failureCode,
      },
    });
  }
}
