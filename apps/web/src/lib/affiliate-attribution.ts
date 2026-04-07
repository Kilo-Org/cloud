import 'server-only';

import { db } from '@/lib/drizzle';
import { sentryLogger } from '@/lib/utils.server';
import { user_affiliate_attributions } from '@kilocode/db/schema';
import type { AffiliateProvider } from '@kilocode/db/schema-types';
import { and, eq } from 'drizzle-orm';

const logInfo = sentryLogger('affiliate-attribution', 'info');
const logWarning = sentryLogger('affiliate-attribution', 'warning');

export async function recordAffiliateAttribution(params: {
  userId: string;
  provider: AffiliateProvider;
  trackingId: string;
}): Promise<void> {
  const trackingId = params.trackingId.trim();
  if (!trackingId) {
    logWarning('Affiliate attribution skipped: empty tracking ID', {
      user_id: params.userId,
      provider: params.provider,
    });
    return;
  }

  const insertResult = await db
    .insert(user_affiliate_attributions)
    .values({
      user_id: params.userId,
      provider: params.provider,
      tracking_id: trackingId,
    })
    .onConflictDoNothing({
      target: [user_affiliate_attributions.user_id, user_affiliate_attributions.provider],
    });

  if ((insertResult.rowCount ?? 0) === 0) {
    logInfo('Affiliate attribution already exists (first-touch preserved)', {
      user_id: params.userId,
      provider: params.provider,
    });
  } else {
    logInfo('Affiliate attribution recorded', {
      user_id: params.userId,
      provider: params.provider,
    });
  }
}

export async function getAffiliateAttribution(userId: string, provider: AffiliateProvider) {
  return await db.query.user_affiliate_attributions.findFirst({
    where: and(
      eq(user_affiliate_attributions.user_id, userId),
      eq(user_affiliate_attributions.provider, provider)
    ),
  });
}
