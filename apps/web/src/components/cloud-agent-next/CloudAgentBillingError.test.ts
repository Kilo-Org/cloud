import { describe, expect, it } from '@jest/globals';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudAgentBillingError, currentPaymentReturnPath } from './CloudAgentBillingError';

type BillingErrorProps = ComponentProps<typeof CloudAgentBillingError>;

const personal = { payerName: 'Your account', action: { href: '/credits', label: 'Add credits' } };
const orgMember = {
  payerName: 'Acme Engineering',
  action: {
    href: '/organizations/org-1/payment-details',
    label: 'View organization billing',
    memberGuidance: true,
  },
};

function renderBillingError(props: BillingErrorProps): string {
  return renderToStaticMarkup(createElement(CloudAgentBillingError, props));
}

describe('CloudAgentBillingError', () => {
  it('renders an accessible personal 402 with both balances and action', () => {
    const html = renderBillingError({
      failure: {
        code: 'INSUFFICIENT_CREDITS',
        payer: { type: 'user', id: 'u1' },
        retryable: false,
        remainingMicrodollars: 1_250_000,
        minimumRequiredMicrodollars: 2_000_000,
      },
      presentation: personal,
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Your account needs more credits to start Cloud Agent compute.');
    expect(html).toContain('Available: $1.25 · Required: $2.00');
    expect(html).toContain('Your prompt did not start.');
    expect(html).toContain('href="/credits"');
    expect(html).toContain('Add credits');
  });

  it.each([
    ['remainingMicrodollars', 'Available: $1.00'],
    ['minimumRequiredMicrodollars', 'Required: $2.00'],
  ] as const)('renders %s independently', (key, text) => {
    const html = renderBillingError({
      failure: {
        code: 'INSUFFICIENT_CREDITS',
        payer: { type: 'org', id: 'org-1' },
        retryable: false,
        [key]: key === 'remainingMicrodollars' ? 1_000_000 : 2_000_000,
      },
      presentation: orgMember,
    });
    expect(html).toContain(text);
    expect(html).toContain('Acme Engineering');
    expect(html).toContain('View organization billing');
    expect(html).toContain('An organization owner, admin, or billing manager can add credits.');
  });

  it.each([
    [
      'COMPUTE_STOPPING',
      'Cloud Agent is saving and stopping compute. Your prompt has not started. Try again after shutdown completes.',
    ],
    [
      'BILLING_UNAVAILABLE',
      'Cloud Agent cannot verify compute billing right now. Your prompt has not started and you have not been charged.',
    ],
  ] as const)('renders exact %s core copy without an action', (code, copy) => {
    const html = renderBillingError({
      failure: { code, payer: { type: 'user', id: 'u1' }, retryable: true },
      presentation: { payerName: 'Your account' },
    });
    expect(html).toContain(copy);
    expect(html).not.toContain('href=');
  });

  it('keeps the complete query string for a payment return', () => {
    expect(
      currentPaymentReturnPath({
        pathname: '/cloud/chat',
        search: '?sessionId=ses-1&tab=chat',
      } as Location)
    ).toBe('/cloud/chat?sessionId=ses-1&tab=chat');
  });
});
