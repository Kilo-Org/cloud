import 'server-only';
import { db } from '@/lib/drizzle';
import { credit_campaigns, credit_transactions, type CreditCampaign } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { count, eq, inArray, sql } from 'drizzle-orm';
import {
  GRANT_MSG_ALREADY_APPLIED,
  GRANT_MSG_CAP_REACHED,
  grantCreditForCategoryConfig,
} from '@/lib/promotionalCredits';
import type { NonSelfServicePromoCreditCategoryConfig } from '@/lib/PromoCreditCategoryConfig';
import { CREDIT_CAMPAIGN_SLUG_FORMAT, isCampaignEligible } from '@/lib/credit-campaigns-shared';

/**
 * Admin-managed signup-bonus URL campaigns. Sibling system to
 * promoCreditCategories.ts: same `credit_transactions` sink, same grant
 * helpers, but campaign config is runtime-managed in the DB instead of
 * code-defined. Entry surface today is `/c/<slug>`; the naming stays
 * entry-method-agnostic (`credit_campaigns`, `c-<slug>` category prefix)
 * so a future code-entry or other surface can reuse these rows without
 * a rename or data migration.
 *
 * Pure helpers (regex, callback parser, eligibility predicate) live in
 * `credit-campaigns-shared.ts` so client components can import them
 * without pulling this `'server-only'` module — which transitively
 * imports the DB client and the server-only config — into the client
 * bundle. That file is re-exported below so server callers keep their
 * existing single-import site.
 */

export {
  CREDIT_CAMPAIGN_SLUG_FORMAT,
  CREDIT_CAMPAIGN_CATEGORY_PREFIX,
  credit_categoryForSlug,
  isCreditCampaignCallback,
  isCampaignEligible,
  type CampaignEligibility,
} from '@/lib/credit-campaigns-shared';

export async function lookupCampaignBySlug(slug: string): Promise<CreditCampaign | null> {
  if (!CREDIT_CAMPAIGN_SLUG_FORMAT.test(slug)) return null;
  const rows = await db
    .select()
    .from(credit_campaigns)
    .where(eq(credit_campaigns.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function countCampaignRedemptions(credit_category: string): Promise<number> {
  const result = await db
    .select({ n: count() })
    .from(credit_transactions)
    .where(eq(credit_transactions.credit_category, credit_category));
  return result[0]?.n ?? 0;
}

export type GrantCampaignResult =
  | { granted: true }
  | { granted: false; reason: 'not-found' | 'inactive' | 'ended' | 'capped' | 'error' };

/**
 * Full grant path: slug → campaign → eligibility → grant. Called from
 * `handleSignupPromotion` once the signup has cleared Stytch/Turnstile.
 * Returns a structured reason on failure so integration tests can pin
 * the branch taken without inspecting side effects.
 *
 * Eligibility is checked again here (not just at `/c/<slug>` render
 * time) because the campaign state can change between landing and
 * signup completion — admin may have deactivated, the cap may have
 * filled from concurrent signups, the end date may have passed. The
 * `is_idempotent: true` + DB unique constraint on (user, category)
 * absorbs the residual race on duplicate grant attempts.
 */
export async function grantCreditCampaignBonus(
  user: User,
  slug: string
): Promise<GrantCampaignResult> {
  try {
    const campaign = await lookupCampaignBySlug(slug);
    if (!campaign) return { granted: false, reason: 'not-found' };

    const redemptionCount = await countCampaignRedemptions(campaign.credit_category);
    const eligibility = isCampaignEligible(campaign, redemptionCount);
    if (!eligibility.ok) return { granted: false, reason: eligibility.reason };

    const amount_usd = Number(campaign.amount_microdollars) / 1_000_000;
    const config: NonSelfServicePromoCreditCategoryConfig = {
      credit_category: campaign.credit_category,
      amount_usd,
      description: `Signup bonus from campaign: ${campaign.slug}`,
      expiry_hours: campaign.credit_expiry_hours ?? undefined,
      is_idempotent: true,
      total_redemptions_allowed: campaign.total_redemptions_allowed ?? undefined,
      promotion_ends_at: campaign.campaign_ends_at
        ? new Date(campaign.campaign_ends_at)
        : undefined,
      is_user_selfservicable: false,
    };

    const grant = await grantCreditForCategoryConfig(
      { user, organization: null },
      { credit_category: campaign.credit_category, counts_as_selfservice: false },
      config
    );
    if (!grant.success) {
      // Idempotent replay: the unique constraint on (user, credit_category)
      // fired inside onConflictDoNothing, meaning the user already has this
      // bonus from an earlier successful grant. Semantically they got it,
      // so report granted:true — same return as a fresh grant.
      if (grant.message.includes(GRANT_MSG_ALREADY_APPLIED)) {
        return { granted: true };
      }
      // Cap-race: the inner re-check ran between our eligibility check and
      // the insert, and the cap filled in the meantime. Report as 'capped'
      // to match what the render-time check would have said a moment later.
      if (grant.message.includes(GRANT_MSG_CAP_REACHED)) {
        return { granted: false, reason: 'capped' };
      }
      // Anything else is unexpected (customer/org requirement, expiry
      // boundary race, missing amount). Log for investigation.
      captureException(new Error(grant.message), {
        tags: { source: 'credit_campaign_grant_fail', slug },
        extra: { userId: user.id, email: user.google_user_email },
      });
      return { granted: false, reason: 'error' };
    }
    return { granted: true };
  } catch (error) {
    captureException(error, {
      tags: { source: 'credit_campaign_grant', slug },
      extra: { userId: user.id, email: user.google_user_email },
    });
    return { granted: false, reason: 'error' };
  }
}

/**
 * Admin-UI guard: a new campaign's derived `credit_category` must not
 * collide with any TS-defined category. Keeps the two systems
 * addressable without cross-contamination. Imported lazily inside the
 * guard so the module graph on public request paths doesn't pay for the
 * TS category map load.
 */
export async function isCreditCategoryCollision(credit_category: string): Promise<boolean> {
  const { promoCreditCategoriesByKey } = await import('@/lib/promoCreditCategories');
  return promoCreditCategoriesByKey.has(credit_category);
}

/**
 * Returns the known `credit_category` strings for all campaigns. Used
 * by the admin list page to scope the stats aggregation to DB-managed
 * categories only (avoids the firehose problem on `/admin/credit-categories`).
 */
export async function listCampaignCategories(): Promise<string[]> {
  const rows = await db
    .select({ credit_category: credit_campaigns.credit_category })
    .from(credit_campaigns);
  return rows.map(r => r.credit_category);
}

/**
 * Atomic scoped stats aggregation used by the admin UI. IN-list of
 * campaign categories + GROUP BY; runs in tens of milliseconds even
 * as `credit_transactions` grows, because the (credit_category) index
 * supports the lookup.
 */
export async function getCampaignStats(credit_categories: string[]): Promise<
  Map<
    string,
    {
      redemption_count: number;
      total_dollars: number;
      last_redemption_at: string | null;
    }
  >
> {
  const map = new Map<
    string,
    { redemption_count: number; total_dollars: number; last_redemption_at: string | null }
  >();
  if (credit_categories.length === 0) return map;
  const rows = await db
    .select({
      credit_category: credit_transactions.credit_category,
      redemption_count: sql<number>`COUNT(*)::int`,
      total_dollars: sql<number>`COALESCE(SUM(${credit_transactions.amount_microdollars}) / 1000000.0, 0)::float`,
      last_redemption_at: sql<string | null>`MAX(${credit_transactions.created_at})`,
    })
    .from(credit_transactions)
    .where(inArray(credit_transactions.credit_category, credit_categories))
    .groupBy(credit_transactions.credit_category);
  for (const r of rows) {
    if (r.credit_category == null) continue;
    map.set(r.credit_category, {
      redemption_count: r.redemption_count,
      total_dollars: r.total_dollars,
      last_redemption_at: r.last_redemption_at,
    });
  }
  return map;
}
