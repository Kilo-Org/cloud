import assert from 'node:assert';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { referral_codes } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user.server';
import {
  getImpactAdvocateWidgetId,
  issueImpactAdvocateVerifiedAccessToken,
} from '@/lib/impact-advocate';
import { ensureImpactAdvocateParticipantProfile } from '@/lib/impact-referral';

async function getOrCreateOpaqueReferralIdentifier(userId: string): Promise<string> {
  const generated = crypto.randomUUID();
  await db
    .insert(referral_codes)
    .values({ kilo_user_id: userId, code: generated })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(referral_codes)
    .where(eq(referral_codes.kilo_user_id, userId));
  assert.equal(rows.length, 1);
  return rows[0].code;
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
    const opaqueReferralIdentifier = await getOrCreateOpaqueReferralIdentifier(user.id);
    await ensureImpactAdvocateParticipantProfile({
      user,
      opaqueReferralIdentifier,
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
