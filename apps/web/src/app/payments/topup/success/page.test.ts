import type { TopUpTransactionSummary } from './actions';
import { getRedirectUrl } from './page';

function makeTransaction(
  overrides: Partial<TopUpTransactionSummary> = {}
): TopUpTransactionSummary {
  return {
    id: '9a89e8e5-7c15-4d43-9fc1-24a97970f989',
    amountMicrodollars: 20_000_000,
    organizationId: null,
    ...overrides,
  };
}

describe('getRedirectUrl', () => {
  it('uses transaction identity for a verified personal purchase', () => {
    expect(getRedirectUrl(makeTransaction(), null)).toBe(
      '/credits?topup-transaction-id=9a89e8e5-7c15-4d43-9fc1-24a97970f989'
    );
  });

  it('preserves the organization success amount contract', () => {
    expect(
      getRedirectUrl(
        makeTransaction({ organizationId: '66333c77-6ac2-4a14-9278-3d45d67e87ec' }),
        null
      )
    ).toBe('/organizations/66333c77-6ac2-4a14-9278-3d45d67e87ec?topup-amount-usd=20');
  });

  it('shows pending status when the ledger transaction is delayed', () => {
    expect(getRedirectUrl(undefined, null)).toBe('/credits?topup-status=pending');
  });

  it('prefers a validated stored return URL', () => {
    expect(getRedirectUrl(undefined, '/claw')).toBe('/claw');
  });
});
