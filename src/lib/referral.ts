import 'server-only';
import assert from 'node:assert';
import { referral_code_usages, referral_codes } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq, and, count, sql, isNull, isNotNull } from 'drizzle-orm';
import { captureMessage } from '@sentry/nextjs';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import {
  promoCreditCategoriesByKey,
  referralRedeemingBonus,
  referralReferringBonus,
} from '@/lib/promoCreditCategories';
import { findUserById } from '@/lib/user';
import { warnExceptInTest } from '@/lib/utils.server';

function getRandomBase64String(): string {
  return crypto.randomUUID();
}

export async function getReferralCodeForUser(kiloUserId: string) {
  const code = getRandomBase64String();
  await db
    .insert(referral_codes)
    .values({ kilo_user_id: kiloUserId, code: code })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(referral_codes)
    .where(eq(referral_codes.kilo_user_id, kiloUserId));

  assert.equal(rows.length, 1);
  return rows[0];
}

function warnInSentry(message: string) {
  warnExceptInTest(message);
  captureMessage(message, {
    level: 'warning',
    tags: { source: 'referral_code' },
  });
}

export async function getReferralCodeUsages(kiloUserId: string) {
  return await db
    .select()
    .from(referral_code_usages)
    .where(eq(referral_code_usages.referring_kilo_user_id, kiloUserId));
}

const redeemingReferralPromoCode = referralRedeemingBonus.credit_category;
const referringReferralPromoCode = referralReferringBonus.credit_category;

export async function processReferralTopUp(redeemingKiloUserId: string) {
  // Validate referral eligibility using shared helper
  const validationResult = await validateReferralForRedemption(redeemingKiloUserId);
  if (validationResult === 'NOTFOUND') return;

  if (!validationResult) {
    // Validation failed - either no referral, code missing, or max redemptions reached
    warnExceptInTest(
      `Warning: not granting referral bonus due to validation failure! redeemer:${redeemingKiloUserId}`
    );
    return;
  }

  const { referring_kilo_user_id, code } = validationResult;

  const redeemingUser = await findUserById(redeemingKiloUserId);
  if (!redeemingUser) {
    warnInSentry(`Redeeming user ${redeemingKiloUserId} not found`);
    return;
  }

  const referringUser = await findUserById(referring_kilo_user_id);
  if (!referringUser) {
    warnInSentry(`Referring user ${referring_kilo_user_id} not found`);
    return;
  }

  const redeemingPromo = promoCreditCategoriesByKey.get(redeemingReferralPromoCode);
  if (!redeemingPromo || !redeemingPromo.amount_usd) {
    warnInSentry(
      `No promo found for redeeming referral promo found with key ${redeemingReferralPromoCode}`
    );
    return;
  }

  const referringPromo = promoCreditCategoriesByKey.get(referringReferralPromoCode);
  if (!referringPromo || !referringPromo.amount_usd) {
    warnInSentry(
      `No promo found for referring referral promo found with key ${referringReferralPromoCode}`
    );
    return;
  }

  // do 3 things
  // 1. Mark the referral code as redeemed
  // 2. Add credits to the redeeming user
  // 3. Add credits to the referring user
  const [updateRow] = await db
    .update(referral_code_usages)
    .set({ paid_at: sql`NOW()`, amount_usd: redeemingPromo.amount_usd })
    .where(
      and(
        eq(referral_code_usages.redeeming_kilo_user_id, redeemingKiloUserId),
        eq(referral_code_usages.code, code),
        isNull(referral_code_usages.paid_at)
      )
    )
    .returning();

  if (!updateRow) {
    warnInSentry(`Failed to update referral code usage for user ${redeemingKiloUserId}`);
    return;
  }

  await grantCreditForCategory(redeemingUser, {
    ...redeemingPromo,
    description: `Referral bonus for redeeming code ${code}`,
    counts_as_selfservice: false,
  });

  await grantCreditForCategory(referringUser, {
    ...referringPromo,
    description: `Referral bonus for referring user ${redeemingKiloUserId} with code ${code}`,
    counts_as_selfservice: false,
  });
}

async function validateReferralForRedemption(kiloUserId: string) {
  // Get referral usage record
  const result = await db
    .select({
      referring_kilo_user_id: referral_code_usages.referring_kilo_user_id,
      code: referral_code_usages.code,
      paid_at: referral_code_usages.paid_at,
    })
    .from(referral_code_usages)
    .where(eq(referral_code_usages.redeeming_kilo_user_id, kiloUserId))
    .limit(1);

  const referralUsage = result.at(0);
  if (!referralUsage) return 'NOTFOUND';
  if (referralUsage.paid_at) return null;

  const { code, referring_kilo_user_id } = referralUsage;
  // Get the referral code record to check max_redemptions
  const referralCodeRecord = await db.query.referral_codes.findFirst({
    where: eq(referral_codes.code, code),
  });

  if (!referralCodeRecord) return null;

  // Check if the code has already reached its max redemptions
  const [prevRedemptions] = await db
    .select({ count: count() })
    .from(referral_code_usages)
    .where(
      and(
        eq(referral_code_usages.code, referralUsage.code),
        isNotNull(referral_code_usages.paid_at)
      )
    );

  const max_redemptions = referralCodeRecord.max_redemptions;
  if (prevRedemptions.count >= max_redemptions) return null;

  return { code, referring_kilo_user_id, max_redemptions };
}
