import { paidCreditExpiration } from './paid-credit-expiration';

test.each([
  ['2026-10-13T02:43:08.123Z', '2027-10-13T02:43:08.123Z'],
  ['2028-02-29T23:30:00.000Z', '2029-02-28T23:30:00.000Z'],
  ['2027-03-01T01:00:00.000Z', '2028-03-01T01:00:00.000Z'],
])('paid credits issued at %s expire at %s', (issuedAt, expected) => {
  expect(paidCreditExpiration(new Date(issuedAt)).toISOString()).toBe(expected);
});
