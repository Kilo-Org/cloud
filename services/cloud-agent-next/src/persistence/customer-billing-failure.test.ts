import { expect, it } from 'vitest';
import { readCustomerBillingFailure } from './customer-billing-failure.js';

it.each([
  null,
  undefined,
  '{',
  '{}',
  JSON.stringify({ code: 'FUTURE_CODE', payer: { type: 'user', id: 'user' }, retryable: true }),
])('ignores an unreadable stored billing failure: %s', value => {
  expect(readCustomerBillingFailure(value)).toBeUndefined();
});

it('preserves a supported stored billing failure', () => {
  const failure = {
    code: 'BILLING_UNAVAILABLE',
    payer: { type: 'user', id: 'user' },
    retryable: true,
  };
  expect(readCustomerBillingFailure(JSON.stringify(failure))).toEqual(failure);
});
