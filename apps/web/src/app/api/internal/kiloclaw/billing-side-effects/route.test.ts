import { NextRequest } from 'next/server';
import { send as sendEmail } from '@/lib/email';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
}));

jest.mock('@/lib/email', () => ({
  send: jest.fn(),
}));

jest.mock('@/lib/autoTopUp', () => ({
  maybePerformAutoTopUp: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/stripe-handlers', () => ({
  ensureAutoIntroSchedule: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/stripe-price-ids.server', () => ({
  isIntroPriceId: jest.fn().mockReturnValue(true),
}));

jest.mock('@/lib/stripe-client', () => ({
  client: {
    subscriptions: {
      retrieve: jest.fn(),
    },
  },
}));

jest.mock('@/lib/impact', () => ({
  trackTrialEnd: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/credit-billing', () => ({
  projectPendingKiloPassBonusMicrodollars: jest.fn(),
}));

jest.mock('@/lib/kilo-pass/usage-triggered-bonus', () => ({
  maybeIssueKiloPassBonusFromUsageThreshold: jest.fn(),
}));

import { POST } from './route';

const mockSendEmail = jest.mocked(sendEmail);
const mockMaybePerformAutoTopUp = jest.mocked(maybePerformAutoTopUp);

type ConsoleSpy = jest.SpiedFunction<typeof console.log> | jest.SpiedFunction<typeof console.error>;

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/internal/kiloclaw/billing-side-effects', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': 'internal-secret',
      ...headers,
    },
  });
}

function findJsonLog(spy: ConsoleSpy, message: string): Record<string, unknown> | undefined {
  return spy.mock.calls
    .map(call => call[0])
    .filter((value): value is string => typeof value === 'string')
    .map(value => JSON.parse(value) as Record<string, unknown>)
    .find(record => record.message === message);
}

describe('POST /api/internal/kiloclaw/billing-side-effects', () => {
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    mockSendEmail.mockResolvedValue({ sent: true });
    mockMaybePerformAutoTopUp.mockResolvedValue(undefined);
  });

  it('logs started and completed side effects with billing correlation and no email recipient', async () => {
    const response = await POST(
      createRequest(
        {
          action: 'send_email',
          input: {
            to: 'user@example.com',
            templateName: 'clawCreditRenewalFailed',
            templateVars: {
              claw_url: 'https://app.kilo.ai/claw',
            },
          },
        },
        {
          'x-kiloclaw-billing-run-id': '11111111-1111-4111-8111-111111111111',
          'x-kiloclaw-billing-sweep': 'credit_renewal',
          'x-kiloclaw-billing-call-id': '22222222-2222-4222-8222-222222222222',
          'x-kiloclaw-billing-attempt': '2',
        }
      )
    );

    expect(response.status).toBe(200);
    expect(findJsonLog(consoleLogSpy, 'Starting billing side effect request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'side_effects',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        billingSweep: 'credit_renewal',
        billingCallId: '22222222-2222-4222-8222-222222222222',
        billingAttempt: 2,
        event: 'downstream_action',
        outcome: 'started',
        action: 'send_email',
        templateName: 'clawCreditRenewalFailed',
      })
    );
    expect(findJsonLog(consoleLogSpy, 'Completed billing side effect request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'side_effects',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        event: 'downstream_action',
        outcome: 'completed',
        action: 'send_email',
        templateName: 'clawCreditRenewalFailed',
        statusCode: 200,
      })
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain('user@example.com');
  });

  it('logs failed side effects with safe identifiers', async () => {
    mockMaybePerformAutoTopUp.mockRejectedValueOnce(new Error('auto top-up unavailable'));

    await expect(
      POST(
        createRequest(
          {
            action: 'trigger_user_auto_top_up',
            input: {
              user: {
                id: 'user-123',
                total_microdollars_acquired: 100,
                microdollars_used: 50,
                next_credit_expiration_at: null,
                updated_at: '2026-04-07T00:00:00.000Z',
                auto_top_up_enabled: true,
              },
            },
          },
          {
            'x-kiloclaw-billing-run-id': '11111111-1111-4111-8111-111111111111',
            'x-kiloclaw-billing-sweep': 'credit_renewal',
            'x-kiloclaw-billing-call-id': '33333333-3333-4333-8333-333333333333',
            'x-kiloclaw-billing-attempt': '1',
          }
        )
      )
    ).rejects.toThrow('auto top-up unavailable');

    expect(findJsonLog(consoleErrorSpy, 'Billing side effect request failed')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingComponent: 'side_effects',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        billingSweep: 'credit_renewal',
        billingCallId: '33333333-3333-4333-8333-333333333333',
        billingAttempt: 1,
        event: 'downstream_action',
        outcome: 'failed',
        action: 'trigger_user_auto_top_up',
        userId: 'user-123',
        statusCode: 500,
        error: 'auto top-up unavailable',
      })
    );
  });
});
