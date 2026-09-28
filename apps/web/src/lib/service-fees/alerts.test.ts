import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { captureException as captureSentryException } from '@sentry/nextjs';

import type { sendAdminSlackNotification } from '@/lib/slack/admin-notifications';

class AdminSlackNotificationError extends Error {
  constructor(
    readonly kind: 'network' | 'upstream',
    readonly status?: number
  ) {
    super('Admin Slack notification request failed');
    this.name = 'AdminSlackNotificationError';
  }
}

async function loadAlerts() {
  jest.resetModules();
  jest.doMock('@sentry/nextjs', () => ({
    captureException: jest.fn(),
  }));
  jest.doMock('@/lib/slack/admin-notifications', () => ({
    AdminSlackNotificationError,
    sendAdminSlackNotification: jest.fn(async () => undefined),
  }));
  return import('./alerts');
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock('@/lib/slack/admin-notifications');
  jest.dontMock('@sentry/nextjs');
});

const ALERT_INPUT = {
  assessmentKey: 'checkout:11111111-1111-4111-8111-111111111111',
  flow: 'organization_top_up' as const,
  organizationId: 'org_123',
  kiloUserId: 'user_456',
  stripeCheckoutSessionId: 'cs_test_1',
  stripeInvoiceId: 'in_test_1',
  stripePaymentIntentId: 'pi_test_1',
  stripeChargeId: 'ch_test_1',
  eligibleSubtotalMinor: 10_000,
  expectedFeeMinor: 500,
  currency: 'usd',
  failureCode: 'fee_application_failed',
  attemptedAt: new Date('2026-09-01T00:00:00.000Z'),
};

describe('sendMissedServiceFeeAlert', () => {
  it('sends only non-sensitive identifiers, amounts, and the failure code', async () => {
    const { buildMissedServiceFeeAlertText, sendMissedServiceFeeAlert } = await loadAlerts();
    const sendNotification = jest.fn<typeof sendAdminSlackNotification>(async () => undefined);
    const capture = jest.fn<typeof captureSentryException>(() => 'event-id');

    await sendMissedServiceFeeAlert(ALERT_INPUT, {
      sendNotification,
      captureException: capture,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const notification = sendNotification.mock.calls[0]?.[0];
    expect(notification?.unfurl_links).toBe(false);
    expect(notification?.unfurl_media).toBe(false);
    expect(notification?.text).toBe(buildMissedServiceFeeAlertText(ALERT_INPUT));
    expect(notification?.text).toContain(
      'assessment_key=checkout:11111111-1111-4111-8111-111111111111'
    );
    expect(notification?.text).toContain('flow=organization_top_up');
    expect(notification?.text).toContain('owner_id=org_123');
    expect(notification?.text).toContain('eligible_subtotal_minor=10000');
    expect(notification?.text).toContain('expected_fee_minor=500');
    expect(notification?.text).toContain('currency=usd');
    expect(notification?.text).toContain('failure_code=fee_application_failed');
    expect(notification?.text).toContain('attempted_at=2026-09-01T00:00:00.000Z');
    expect(notification?.text).not.toMatch(/email|payload|webhook|card|secret|metadata/i);
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures only Slack kind/status and identifiers when Slack fails', async () => {
    const { sendMissedServiceFeeAlert, SERVICE_FEE_MISSED_SENTRY_TAG } = await loadAlerts();
    const slackError = new AdminSlackNotificationError('upstream', 500);
    const sendNotification = jest.fn<typeof sendAdminSlackNotification>(async () => {
      throw slackError;
    });
    const capture = jest.fn<typeof captureSentryException>(() => 'event-id');

    await expect(
      sendMissedServiceFeeAlert(ALERT_INPUT, {
        sendNotification,
        captureException: capture,
      })
    ).resolves.toBeUndefined();

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(slackError, {
      tags: { source: SERVICE_FEE_MISSED_SENTRY_TAG },
      extra: {
        kind: 'upstream',
        status: 500,
        assessmentKey: ALERT_INPUT.assessmentKey,
        flow: ALERT_INPUT.flow,
        ownerId: 'org_123',
        failureCode: 'fee_application_failed',
      },
    });
    const captureContext = capture.mock.calls[0]?.[1];
    expect(JSON.stringify(captureContext)).not.toMatch(/secret|payload|webhook|email/i);
  });

  it('captures and swallows unexpected notifier failures without retaining the raw error', async () => {
    const { sendMissedServiceFeeAlert, SERVICE_FEE_MISSED_SENTRY_TAG } = await loadAlerts();
    const sendNotification = jest.fn<typeof sendAdminSlackNotification>(async () => {
      throw new Error('potentially sensitive notifier error');
    });
    const capture = jest.fn<typeof captureSentryException>(() => 'event-id');

    await expect(
      sendMissedServiceFeeAlert(ALERT_INPUT, {
        sendNotification,
        captureException: capture,
      })
    ).resolves.toBeUndefined();

    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: SERVICE_FEE_MISSED_SENTRY_TAG },
      extra: {
        kind: 'unexpected',
        status: null,
        assessmentKey: ALERT_INPUT.assessmentKey,
        flow: ALERT_INPUT.flow,
        ownerId: 'org_123',
        failureCode: 'fee_application_failed',
      },
    });
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: 'Admin Slack notification failed' })
    );
  });
});
