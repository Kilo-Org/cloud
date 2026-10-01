import { expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { KILO_PASS_TIER_CONFIG } from '@kilocode/web-shared/lib/kilo-pass/constants';
import {
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassTier,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { createOrGetIssuanceHeader } from '@kilocode/web-shared/lib/kilo-pass/issuance';
import { getEffectiveKiloPassThreshold } from '@kilocode/web-shared/lib/kilo-pass/threshold';
import { createTestSubscription } from '@kilocode/web-shared/tests/helpers/kilo-pass.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  computeMonthlyKiloPassStreak,
  updateKiloPassThresholdAfterBaseCredits,
} from './subscription-accounting';

test('computeMonthlyKiloPassStreak counts consecutive issuance months', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
  });

  await db.transaction(async tx => {
    await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth: '2026-01-01',
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId: `inv-streak-jan-${crypto.randomUUID()}`,
    });
    await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth: '2026-02-01',
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId: `inv-streak-feb-${crypto.randomUUID()}`,
    });

    await expect(
      computeMonthlyKiloPassStreak(tx, {
        subscriptionId,
        issueMonth: '2026-02-01',
      })
    ).resolves.toBe(2);
  });
});

test.each([
  [KiloPassTier.Tier19, KiloPassCadence.Monthly],
  [KiloPassTier.Tier49, KiloPassCadence.Monthly],
  [KiloPassTier.Tier199, KiloPassCadence.Monthly],
  [KiloPassTier.Tier19, KiloPassCadence.Yearly],
  [KiloPassTier.Tier49, KiloPassCadence.Yearly],
  [KiloPassTier.Tier199, KiloPassCadence.Yearly],
] as const)(
  'updateKiloPassThresholdAfterBaseCredits keeps %s %s grants reachable',
  async (tier, _cadence) => {
    const baseMicrodollars = KILO_PASS_TIER_CONFIG[tier].monthlyPriceUsd * 1_000_000;
    const openingBalances = [
      ['positive', 2_000_000],
      ['zero', 0],
      ['between zero and -$1', -500_000],
      ['below -$1', -2_000_000],
      ['very large negative', -1_000_000_000],
    ] as const;

    for (const [_balanceName, openingBalance] of openingBalances) {
      const openingAcquired = 2_000_000_000;
      const openingUsed = openingAcquired - openingBalance;
      const user = await insertTestUser({
        total_microdollars_acquired: openingAcquired,
        microdollars_used: openingUsed,
      });

      // Simulate the just-issued base-credit transaction before setting its threshold.
      const postGrantAcquired = openingAcquired + baseMicrodollars;
      await db
        .update(kilocode_users)
        .set({ total_microdollars_acquired: postGrantAcquired })
        .where(eq(kilocode_users.id, user.id));

      for (let issuance = 0; issuance < 2; issuance += 1) {
        await db.transaction(async tx => {
          await updateKiloPassThresholdAfterBaseCredits(tx, {
            kiloUserId: user.id,
            baseAmountUsd: KILO_PASS_TIER_CONFIG[tier].monthlyPriceUsd,
          });
        });
      }

      const updatedUser = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      const expectedThreshold = Math.min(openingUsed + baseMicrodollars, postGrantAcquired);
      expect(updatedUser?.kilo_pass_threshold).toBe(expectedThreshold);

      const effectiveThreshold = getEffectiveKiloPassThreshold(
        updatedUser?.kilo_pass_threshold ?? null
      );
      expect(effectiveThreshold).not.toBeNull();
      if (effectiveThreshold === null) throw new Error('Expected a Kilo Pass threshold');
      expect(effectiveThreshold).toBeLessThan(postGrantAcquired);
      expect(postGrantAcquired - effectiveThreshold).toBeGreaterThanOrEqual(1_000_000);
    }
  }
);
