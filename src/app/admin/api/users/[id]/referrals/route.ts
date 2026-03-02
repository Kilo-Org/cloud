import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { findUserById, findUsersByIds } from '@/lib/user';
import { getReferralCodeForUser, getReferralCodeUsages } from '@/lib/referral';
import { db } from '@/lib/drizzle';
import { referral_code_usages } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { toNonNullish } from '@/lib/utils';

type ReferredUser = {
  id: string;
  email: string;
  name: string;
  created_at: string;
  google_user_image_url: string;
  paid_at: string | null;
  amount_usd: number | null;
};

export type AdminUserReferralsResponse = {
  userId: string;
  code: { code: string; maxRedemptions: number } | null;
  referrers: ReferredUser[];
  referredUsers: ReferredUser[];
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ error: string } | AdminUserReferralsResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const userId = (await params).id;

  // Existence check
  const user = await findUserById(userId);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Code owned by the user (normalize unlimited to 0 if absent)
  const refCode = await getReferralCodeForUser(userId);
  const code =
    refCode != null
      ? {
          code: refCode.code,
          maxRedemptions: refCode.max_redemptions ?? 0,
        }
      : null;

  // All usages where this user is the redeemer => determines referrers
  const referrerRows = await db
    .select()
    .from(referral_code_usages)
    .where(eq(referral_code_usages.redeeming_kilo_user_id, userId));

  // Usages where this user is the referrer => referred users
  const redemptions = await getReferralCodeUsages(userId);
  const referredIdsSet = redemptions.map(r => r.redeeming_kilo_user_id);

  const lookupIds = [...referredIdsSet, ...referrerRows.map(o => o.referring_kilo_user_id)];
  const usersById = await findUsersByIds(lookupIds);

  const referrers = referrerRows.map(referrerInfo => {
    const user = toNonNullish(usersById.get(referrerInfo.referring_kilo_user_id));
    return {
      id: user.id,
      email: user.google_user_email,
      name: user.google_user_name,
      created_at: referrerInfo.created_at,
      google_user_image_url: user.google_user_image_url,
      paid_at: referrerInfo.paid_at,
      amount_usd: referrerInfo.amount_usd,
    } satisfies ReferredUser;
  });

  const referredUsers = redemptions.map(r => {
    const redeemingUser = toNonNullish(usersById.get(r.redeeming_kilo_user_id));
    return {
      id: redeemingUser.id,
      email: redeemingUser.google_user_email,
      name: redeemingUser.google_user_name,
      created_at: redeemingUser.created_at,
      paid_at: r.paid_at,
      amount_usd: r.amount_usd,
      google_user_image_url: redeemingUser.google_user_image_url,
    } satisfies ReferredUser;
  });

  const payload: AdminUserReferralsResponse = {
    userId,
    code,
    referrers,
    referredUsers,
  };

  return NextResponse.json(payload, { status: 200 });
}
