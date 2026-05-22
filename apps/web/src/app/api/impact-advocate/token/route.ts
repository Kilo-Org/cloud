import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { referral_codes } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user/server';
import {
  getImpactAdvocateWidgetId,
  issueImpactAdvocateVerifiedAccessToken,
} from '@/lib/impact/advocate';
import {
  countryCodeFromHeaders,
  localeFromHeaders,
  queueImpactAdvocateSelfRegistration,
} from '@/lib/impact/referral';

/**
 * Internal Kilo referral code (kept for legacy/internal attribution flows in
 * `referral_codes`). This is intentionally NOT linked to
 * `impact_advocate_participants.opaque_referral_identifier` anymore — that
 * column is now reserved for the SaaSquatch-issued referral code so the
 * conversion lifecycle's referrer-resolution lookup actually works.
 */
async function ensureInternalReferralCode(userId: string): Promise<void> {
  await db
    .insert(referral_codes)
    .values({ kilo_user_id: userId, code: crypto.randomUUID() })
    .onConflictDoNothing({ target: [referral_codes.kilo_user_id] });
}

export async function GET() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = issueImpactAdvocateVerifiedAccessToken(user);
  if (!token) {
    return NextResponse.json({ error: 'Impact Advocate is not configured' }, { status: 503 });
  }

  try {
    await ensureInternalReferralCode(user.id);

    // Mirror the user into SaaSquatch as an advocate so they become
    // discoverable when their referees convert. The dispatcher reads the
    // SaaSquatch-issued code out of the response and persists it as
    // `participants.opaque_referral_identifier`. Idempotent across repeat
    // page loads via dedupe key.
    const requestHeaders = await headers();
    await queueImpactAdvocateSelfRegistration({
      user,
      locale: localeFromHeaders(requestHeaders),
      countryCode: countryCodeFromHeaders(requestHeaders),
    });
  } catch (error) {
    console.error('[impact-advocate-token] failed to prepare referral sharing identity', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Referral sharing is temporarily unavailable' },
      { status: 503 }
    );
  }

  return NextResponse.json({
    token,
    widgetId: getImpactAdvocateWidgetId(),
  });
}
