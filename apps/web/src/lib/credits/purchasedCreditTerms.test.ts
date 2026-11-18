import { purchasedCreditTermsText } from './purchasedCreditTerms';

describe('purchasedCreditTermsText', () => {
  it('states the one-year term while the policy is active', () => {
    expect(purchasedCreditTermsText({ creditExpiryPolicy: 'one_year' }, false)).toBe(
      'Expire one year after purchase'
    );
  });

  it('states that new credits do not expire while the policy is off', () => {
    expect(purchasedCreditTermsText({ creditExpiryPolicy: 'never' }, false)).toBe('Do not expire');
  });

  it('never promises a term before the policy answers or after it fails', () => {
    expect(purchasedCreditTermsText(undefined, false)).toBe('Loading terms...');
    expect(purchasedCreditTermsText(undefined, true)).toBe('Terms unavailable');
  });
});
