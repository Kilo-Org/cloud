import { describe, expect, it } from '@jest/globals';
import { billingPayerPresentation } from './billing-payer-presentation';

const failure = {
  code: 'INSUFFICIENT_CREDITS' as const,
  payer: { type: 'org' as const, id: 'org-1' },
  retryable: false,
};

describe('billingPayerPresentation', () => {
  it('uses the actual organization name and billing-manager action', () => {
    expect(
      billingPayerPresentation(failure, {
        organization: { id: 'org-1', name: 'Long Organization Name', role: 'billing_manager' },
      })
    ).toEqual({
      payerName: 'Long Organization Name',
      action: { href: '/organizations/org-1', label: 'Add organization credits' },
    });
  });

  it('gives ordinary members the billing-details action and guidance', () => {
    expect(
      billingPayerPresentation(failure, {
        organization: { id: 'org-1', name: 'Acme', role: 'member' },
      })
    ).toEqual({
      payerName: 'Acme',
      action: {
        href: '/organizations/org-1/payment-details',
        label: 'View organization billing',
        memberGuidance: true,
      },
    });
  });

  it('does not expose an action when the payer differs from the authorized surface', () => {
    expect(
      billingPayerPresentation(failure, {
        organization: { id: 'org-2', name: 'Other', role: 'owner' },
      })
    ).toEqual({ payerName: 'This organization' });
  });

  it('uses the personal credits action only on the personal surface', () => {
    expect(
      billingPayerPresentation({ ...failure, payer: { type: 'user', id: 'user-1' } }, {})
    ).toEqual({ payerName: 'Your account', action: { href: '/credits', label: 'Add credits' } });
  });
});
