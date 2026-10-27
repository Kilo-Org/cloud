import {
  addCalendarYearUtc,
  getPaidCreditPolicyPresentation,
  resolvePaidCreditPolicy,
} from './paidCreditPolicy';

const purchasedAt = '2028-02-29T12:34:56.789Z';

describe('paid credit policy', () => {
  it('remains disabled without an explicit effective cutoff', () => {
    expect(getPaidCreditPolicyPresentation(null).creditExpiryPolicy).toBe('never');
    expect(getPaidCreditPolicyPresentation('not-a-date').enabled).toBe(false);
  });

  it('only presents new terms at or after the explicit cutoff', () => {
    const cutoff = '2027-01-01T00:00:00.000Z';
    expect(
      getPaidCreditPolicyPresentation(cutoff, new Date('2026-12-31T23:59:59.999Z')).enabled
    ).toBe(false);
    expect(getPaidCreditPolicyPresentation(cutoff, new Date(cutoff))).toMatchObject({
      enabled: true,
      creditExpiryPolicy: 'one_year',
      passExpiryPolicy: 'one_year',
    });
  });

  it('clamps February 29 while retaining UTC clock precision', () => {
    expect(addCalendarYearUtc(purchasedAt)).toBe('2029-02-28T12:34:56.789Z');
    expect(addCalendarYearUtc('2027-03-01T04:00:00.000Z')).toBe('2028-03-01T04:00:00.000Z');
  });

  it('does not retroactively apply policy when terms were never captured', () => {
    expect(resolvePaidCreditPolicy({ source: 'stripe', purchasedAt })).toMatchObject({
      paid_credit_policy: 'legacy',
      expiry_date: null,
    });
  });

  it('honors immutable disclosed terms independently of the current gate', () => {
    expect(
      resolvePaidCreditPolicy({ source: 'google_play', purchasedAt, terms: 'one_year' })
    ).toMatchObject({
      paid_credit_policy: 'one_year',
      expiry_date: '2029-02-28T12:34:56.789Z',
    });
    expect(
      resolvePaidCreditPolicy({ source: 'google_play', purchasedAt, terms: 'legacy' }).expiry_date
    ).toBeNull();
  });

  it('always exempts Apple paid principal including residual Pass grants', () => {
    expect(
      resolvePaidCreditPolicy({ source: 'apple', purchasedAt, terms: 'one_year' })
    ).toMatchObject({
      paid_credit_policy: 'apple_exempt',
      expiry_date: null,
    });
    expect(
      resolvePaidCreditPolicy({ source: 'pass', purchasedAt, terms: 'apple_exempt' }).expiry_date
    ).toBeNull();
  });

  it('uses issuance date for monthly base allotments from a captured paid term', () => {
    expect(
      resolvePaidCreditPolicy({
        source: 'pass',
        purchasedAt: '2027-01-01',
        issuedAt: purchasedAt,
        terms: 'one_year',
      }).expiry_date
    ).toBe('2029-02-28T12:34:56.789Z');
    expect(
      resolvePaidCreditPolicy({
        source: 'pass',
        purchasedAt: '2026-01-01',
        issuedAt: purchasedAt,
        terms: 'legacy',
      }).expiry_date
    ).toBeNull();
  });

  it('never creates spendable expiry exposure for hosting settlement deposits', () => {
    expect(
      resolvePaidCreditPolicy({ source: 'settlement', purchasedAt, terms: 'one_year' })
    ).toEqual({
      paid_credit_policy: 'settlement',
      credit_source: 'settlement',
      expiry_date: null,
    });
  });
});
