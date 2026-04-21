import type { CreditCampaign } from '@kilocode/db/schema';

/**
 * Pure client- and server-safe helpers for admin-managed credit
 * campaigns. Split from `credit-campaigns.ts` (which imports the DB
 * via `'server-only'`) so client components can pull the slug format
 * and callback parser without Turbopack tracing through the
 * server-only chain.
 */

export const CREDIT_CAMPAIGN_SLUG_FORMAT = /^[a-z0-9-]{5,40}$/;

export const CREDIT_CAMPAIGN_CATEGORY_PREFIX = 'c-';

export function credit_categoryForSlug(slug: string): string {
  return CREDIT_CAMPAIGN_CATEGORY_PREFIX + slug;
}

const CREDIT_CAMPAIGN_PATH_RE = /^\/c\/([a-z0-9-]+)\/?(?:[?#]|$)/;

export function isCreditCampaignCallback(
  callbackPath: string | null | undefined
): { slug: string } | null {
  if (typeof callbackPath !== 'string' || callbackPath.length === 0) return null;
  const match = CREDIT_CAMPAIGN_PATH_RE.exec(callbackPath);
  if (!match) return null;
  const slug = match[1];
  if (!CREDIT_CAMPAIGN_SLUG_FORMAT.test(slug)) return null;
  return { slug };
}

export type CampaignEligibility =
  | { ok: true }
  | { ok: false; reason: 'inactive' | 'ended' | 'capped' };

export function isCampaignEligible(
  campaign: Pick<CreditCampaign, 'active' | 'campaign_ends_at' | 'total_redemptions_allowed'>,
  redemptionCount: number,
  now: Date = new Date()
): CampaignEligibility {
  if (!campaign.active) return { ok: false, reason: 'inactive' };
  if (campaign.campaign_ends_at && new Date(campaign.campaign_ends_at) <= now) {
    return { ok: false, reason: 'ended' };
  }
  if (redemptionCount >= campaign.total_redemptions_allowed) {
    return { ok: false, reason: 'capped' };
  }
  return { ok: true };
}
