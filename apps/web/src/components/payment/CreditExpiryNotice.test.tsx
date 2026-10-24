import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { CreditExpiryNotice, usePaidCreditPolicyReady } from './CreditExpiryNotice';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({ user: { getPaidCreditPolicy: { queryOptions: () => ({}) } } }),
}));

Object.assign(globalThis, { React });

const mockUseQuery = jest.mocked(useQuery);

function setPolicy(creditExpiryPolicy: 'never' | 'one_year') {
  mockUseQuery.mockReturnValue({
    data: { creditExpiryPolicy, passExpiryPolicy: creditExpiryPolicy },
    isSuccess: true,
  } as unknown as UseQueryResult);
}

describe('CreditExpiryNotice', () => {
  it('does not disclose new terms while rollout is disabled', () => {
    setPolicy('never');
    expect(renderToStaticMarkup(<CreditExpiryNotice />)).toBe('');
    expect(renderToStaticMarkup(<CreditExpiryNotice purchase="pass" />)).toBe('');
  });

  it('does not guess terms before the server policy is available', () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isSuccess: false,
    } as unknown as UseQueryResult);
    const html = renderToStaticMarkup(<CreditExpiryNotice />);
    expect(html).toContain('Loading credit expiration terms...');
    expect(html).not.toContain('expire one year');
  });

  it('discloses one-year principal expiration without changing existing credit terms', () => {
    setPolicy('one_year');
    const html = renderToStaticMarkup(<CreditExpiryNotice />);
    expect(html).toContain('Purchased credits expire one year after purchase.');
    expect(html).toContain('Existing credits keep their current terms.');
    expect(html).toContain('Promotional and bonus credits may expire sooner.');
  });

  it('explains monthly issuance and grandfathered annual terms for Pass', () => {
    setPolicy('one_year');
    const html = renderToStaticMarkup(<CreditExpiryNotice purchase="pass" />);
    expect(html).toContain('Each monthly base-credit allotment expires one year after issuance.');
    expect(html).toContain(
      'Annual terms paid before this policy began keep their original terms until renewal.'
    );
  });
});

function DirectPurchaseButton() {
  const policyReady = usePaidCreditPolicyReady();
  return <button disabled={!policyReady}>Purchase</button>;
}

describe('direct purchase policy readiness', () => {
  it.each([
    { label: 'pending', data: undefined, isSuccess: false, isError: false },
    { label: 'failed', data: undefined, isSuccess: false, isError: true },
    {
      label: 'failed refresh with stale data',
      data: { creditExpiryPolicy: 'never', passExpiryPolicy: 'never' },
      isSuccess: false,
      isError: true,
    },
  ])('blocks a direct purchase when policy is $label', state => {
    mockUseQuery.mockReturnValue({ ...state, refetch: jest.fn() } as unknown as UseQueryResult);
    expect(renderToStaticMarkup(<DirectPurchaseButton />)).toContain('disabled=""');
    expect(renderToStaticMarkup(<CreditExpiryNotice />)).not.toContain('expire one year');
  });

  it.each(['never', 'one_year'] as const)(
    'allows a direct purchase after policy %s is confirmed',
    policy => {
      setPolicy(policy);
      expect(renderToStaticMarkup(<DirectPurchaseButton />)).not.toContain('disabled');
    }
  );

  it('offers a retry when policy loading fails', () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
      refetch: jest.fn(),
    } as unknown as UseQueryResult);
    expect(renderToStaticMarkup(<CreditExpiryNotice />)).toContain('Retry loading terms');
  });
});
