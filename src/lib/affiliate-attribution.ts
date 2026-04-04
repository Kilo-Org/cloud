import 'server-only';

import { db } from '@/lib/drizzle';
import { user_affiliate_attributions } from '@kilocode/db/schema';
import type { AffiliateProvider } from '@kilocode/db/schema-types';
import { and, eq } from 'drizzle-orm';

export async function recordAffiliateAttribution(params: {
  userId: string;
  provider: AffiliateProvider;
  trackingId: string;
}): Promise<void> {
  const trackingId = params.trackingId.trim();
  if (!trackingId) return;

  await db
    .insert(user_affiliate_attributions)
    .values({
      user_id: params.userId,
      provider: params.provider,
      tracking_id: trackingId,
    })
    .onConflictDoNothing({
      target: [user_affiliate_attributions.user_id, user_affiliate_attributions.provider],
    });
}

export async function getAffiliateAttribution(userId: string, provider: AffiliateProvider) {
  return await db.query.user_affiliate_attributions.findFirst({
    where: and(
      eq(user_affiliate_attributions.user_id, userId),
      eq(user_affiliate_attributions.provider, provider)
    ),
  });
}
