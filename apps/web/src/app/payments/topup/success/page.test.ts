import type { CreditTransaction } from '@kilocode/db/schema';
import { getRedirectUrl } from './page';

function makeTransaction(overrides: Partial<CreditTransaction> = {}): CreditTransaction {
  return {
    id: '9a89e8e5-7c15-4d43-9fc1-24a97970f989',
    kilo_user_id: 'user-1',
    amount_microdollars: 20_000_000,
    expiration_baseline_microdollars_used: null,
    original_baseline_microdollars_used: 0,
    is_free: false,
    description: 'Top-up via stripe',
    original_transaction_id: null,
    stripe_payment_id: 'ch_test',
    coinbase_credit_block_id: null,
    credit_category: null,
    expiry_date: null,
    created_at: '2026-06-25T10:00:00.000Z',
    organization_id: null,
    created_by_kilo_user_id: null,
    check_category_uniqueness: false,
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
        makeTransaction({ organization_id: '66333c77-6ac2-4a14-9278-3d45d67e87ec' }),
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
