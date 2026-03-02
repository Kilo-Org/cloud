import { describe, test, expect } from '@jest/globals';
import { insertTestUser } from '../tests/helpers/user.helper';

import {
  getCreditTransactionsSummaryByUserId,
  summarizeUserPayments,
} from '@/lib/creditTransactions';
import { db } from './drizzle';
import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';

describe('Credit Transactions', () => {
  describe('getCreditTransactionsSummaryByUserId', () => {
    test('should calculate correct summary for mixed transaction types', async () => {
      const user = await insertTestUser();

      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        is_free: true,
        amount_microdollars: 5000000, // 5.0 USD in microdollars
        description: 'Promo 1',
        original_baseline_microdollars_used: user.microdollars_used,
      });

      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        is_free: true,
        amount_microdollars: 15500000, // 15.5 USD in microdollars
        description: 'Promo 2',
        original_baseline_microdollars_used: user.microdollars_used,
      });

      // Create purchased transactions
      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        is_free: false,
        amount_microdollars: 25000000, // 25.0 USD in microdollars
        description: 'Purchase 1',
        original_baseline_microdollars_used: user.microdollars_used,
      });

      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        is_free: false,
        amount_microdollars: 10750000, // 10.75 USD in microdollars
        description: 'Purchase 2',
        original_baseline_microdollars_used: user.microdollars_used,
      });

      const summary = await getCreditTransactionsSummaryByUserId(user.id);

      expect(summary.total_promotional_musd).toBe(20500000); // 5.00 + 15.50
      expect(summary.total_purchased_musd).toBe(35750000); // 25.00 + 10.75
      expect(summary.credit_transaction_count).toBe(4);
    });

    test('should return zeros for user with no transactions', async () => {
      const user = await insertTestUser();

      const summary = await getCreditTransactionsSummaryByUserId(user.id);

      expect(summary.total_promotional_musd).toBe(0);
      expect(summary.total_purchased_musd).toBe(0);
      expect(summary.credit_transaction_count).toBe(0);
    });

    test('should only include transactions for specified user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(credit_transactions).values({
        kilo_user_id: user1.id,
        is_free: true,
        amount_microdollars: 10000000, // 10.0 USD in microdollars
        description: 'User 1 promo',
        original_baseline_microdollars_used: user1.microdollars_used,
      });

      await db.insert(credit_transactions).values({
        kilo_user_id: user2.id,
        is_free: false,
        amount_microdollars: 20000000, // 20.0 USD in microdollars
        description: 'User 2 purchase',
        original_baseline_microdollars_used: user2.microdollars_used,
      });

      const user1Summary = await getCreditTransactionsSummaryByUserId(user1.id);
      const user2Summary = await getCreditTransactionsSummaryByUserId(user2.id);

      expect(user1Summary.total_promotional_musd).toBe(10000000);
      expect(user1Summary.total_purchased_musd).toBe(0);
      expect(user1Summary.credit_transaction_count).toBe(1);

      expect(user2Summary.total_promotional_musd).toBe(0);
      expect(user2Summary.total_purchased_musd).toBe(20000000);
      expect(user2Summary.credit_transaction_count).toBe(1);
    });
  });

  describe('summarizeUserPayments', () => {
    test('should ignore Kilo Pass credit transactions', async () => {
      const user = await insertTestUser();

      const [kiloPassPaidCreditTx] = await db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          is_free: false,
          amount_microdollars: 19000000,
          stripe_payment_id: `in_${crypto.randomUUID()}`,
          description: 'Kilo Pass base credits',
          original_baseline_microdollars_used: user.microdollars_used,
        })
        .returning({ id: credit_transactions.id });

      if (!kiloPassPaidCreditTx) throw new Error('Failed to create Kilo Pass credit transaction');

      const [subscriptionRow] = await db
        .insert(kilo_pass_subscriptions)
        .values({
          kilo_user_id: user.id,
          stripe_subscription_id: `sub_${crypto.randomUUID()}`,
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          status: 'active',
        })
        .returning({ id: kilo_pass_subscriptions.id });

      if (!subscriptionRow) throw new Error('Failed to create kilo_pass_subscriptions row');

      const [issuanceRow] = await db
        .insert(kilo_pass_issuances)
        .values({
          kilo_pass_subscription_id: subscriptionRow.id,
          issue_month: '2026-01-01',
          source: KiloPassIssuanceSource.StripeInvoice,
          stripe_invoice_id: `in_${crypto.randomUUID()}`,
        })
        .returning({ id: kilo_pass_issuances.id });

      if (!issuanceRow) throw new Error('Failed to create kilo_pass_issuances row');

      await db.insert(kilo_pass_issuance_items).values({
        kilo_pass_issuance_id: issuanceRow.id,
        kind: KiloPassIssuanceItemKind.Base,
        credit_transaction_id: kiloPassPaidCreditTx.id,
        amount_usd: 19,
      });

      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        is_free: false,
        amount_microdollars: 5000000,
        stripe_payment_id: `pi_${crypto.randomUUID()}`,
        description: 'Normal top-up',
        original_baseline_microdollars_used: user.microdollars_used,
      });

      const summary = await summarizeUserPayments(user.id);

      expect(summary.payments_count).toBe(1);
      expect(summary.payments_total_microdollars).toBe(5000000);
    });
  });
});
