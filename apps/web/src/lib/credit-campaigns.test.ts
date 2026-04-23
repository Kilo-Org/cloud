/**
 * Unit tests for the pure helpers in credit-campaigns.ts. Pins the
 * monetary attribution decision for admin-managed URL campaigns:
 * which `/c/<slug>` callback paths qualify, and which campaigns are
 * eligible to grant at signup. DB-integrated helpers
 * (lookupCampaignBySlug, grantCreditCampaignBonus) are exercised in
 * integration tests elsewhere.
 */

import {
  CREDIT_CAMPAIGN_SLUG_FORMAT,
  credit_categoryForSlug,
  isCampaignEligible,
  isCreditCampaignCallback,
} from './credit-campaigns';

describe('CREDIT_CAMPAIGN_SLUG_FORMAT', () => {
  it('accepts 5-40 chars of lowercase alphanumerics and hyphens', () => {
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('summit')).toBe(true);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('podcast-q1')).toBe(true);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('abc12')).toBe(true);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('a'.repeat(40))).toBe(true);
  });

  it('rejects under 5 chars (modest brute-force deterrent)', () => {
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('abcd')).toBe(false);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('a')).toBe(false);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('')).toBe(false);
  });

  it('rejects over 40 chars', () => {
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('a'.repeat(41))).toBe(false);
  });

  it('rejects uppercase, underscores, and other punctuation', () => {
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('Summit')).toBe(false);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('my_slug')).toBe(false);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('my.slug')).toBe(false);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('my slug')).toBe(false);
    expect(CREDIT_CAMPAIGN_SLUG_FORMAT.test('my/slug')).toBe(false);
  });
});

describe('credit_categoryForSlug', () => {
  it('prefixes with c- to segregate DB-managed campaigns from TS categories', () => {
    expect(credit_categoryForSlug('summit')).toBe('c-summit');
    expect(credit_categoryForSlug('podcast-q1')).toBe('c-podcast-q1');
  });
});

describe('isCreditCampaignCallback', () => {
  describe('positive cases — attributes to a credit campaign', () => {
    it('matches /c/<slug> with a simple slug', () => {
      expect(isCreditCampaignCallback('/c/summit')).toEqual({ slug: 'summit' });
    });

    it('matches slugs with internal hyphens and digits', () => {
      expect(isCreditCampaignCallback('/c/podcast-q1-2026')).toEqual({ slug: 'podcast-q1-2026' });
    });

    it('matches with a trailing slash', () => {
      expect(isCreditCampaignCallback('/c/summit/')).toEqual({ slug: 'summit' });
    });

    it('matches when a query string follows', () => {
      expect(isCreditCampaignCallback('/c/summit?utm_source=newsletter')).toEqual({
        slug: 'summit',
      });
    });

    it('matches when a fragment follows', () => {
      expect(isCreditCampaignCallback('/c/summit#anchor')).toEqual({ slug: 'summit' });
    });
  });

  describe('negative cases — must not attribute', () => {
    it('rejects null, undefined, and empty string', () => {
      expect(isCreditCampaignCallback(null)).toBeNull();
      expect(isCreditCampaignCallback(undefined)).toBeNull();
      expect(isCreditCampaignCallback('')).toBeNull();
    });

    it('rejects a bare /c/ with no slug', () => {
      expect(isCreditCampaignCallback('/c/')).toBeNull();
      expect(isCreditCampaignCallback('/c')).toBeNull();
    });

    it('rejects slugs shorter than 5 chars', () => {
      expect(isCreditCampaignCallback('/c/abc')).toBeNull();
      expect(isCreditCampaignCallback('/c/a')).toBeNull();
    });

    it('rejects /c-fake/<slug> (prefix-match sibling attack)', () => {
      // Defense against the same naive-prefix-match bug class the
      // openclaw-advisor bonus-guard fix addresses. A sibling path
      // that shares the `/c` prefix must not qualify.
      expect(isCreditCampaignCallback('/c-fake/summit')).toBeNull();
      expect(isCreditCampaignCallback('/campaign/summit')).toBeNull();
      expect(isCreditCampaignCallback('/cc/summit')).toBeNull();
    });

    it('rejects /c/<slug> followed by extra path segments', () => {
      // `/c/summit/extra` is not one of our canonical URLs. We only
      // ever generate `/c/<slug>` (optionally with trailing slash or
      // query). Rejecting residual segments keeps the attribution
      // surface tight: no "/c/summit/anything-else" variants can
      // sneak into bonus eligibility.
      expect(isCreditCampaignCallback('/c/summit/extra')).toBeNull();
      expect(isCreditCampaignCallback('/c/summit/extra/more')).toBeNull();
    });

    it('rejects slugs with invalid characters', () => {
      expect(isCreditCampaignCallback('/c/Summit')).toBeNull();
      expect(isCreditCampaignCallback('/c/my_slug')).toBeNull();
      expect(isCreditCampaignCallback('/c/my.slug')).toBeNull();
    });

    it('rejects other product entry points', () => {
      expect(isCreditCampaignCallback('/openclaw-advisor?code=ABCD')).toBeNull();
      expect(isCreditCampaignCallback('/claw')).toBeNull();
      expect(isCreditCampaignCallback('/install')).toBeNull();
    });
  });
});

describe('isCampaignEligible', () => {
  // Sentinel "effectively uncapped" value so tests of the active/ended
  // branches don't accidentally trip the cap branch. The column is NOT
  // NULL in the DB, so tests must pass a number — this matches the real
  // runtime type of CreditCampaign.total_redemptions_allowed.
  const baseCampaign = {
    active: true,
    campaign_ends_at: null,
    total_redemptions_allowed: 1_000_000,
  };

  describe('ok', () => {
    it('is eligible when active, no end date, redemptions well below cap', () => {
      expect(isCampaignEligible(baseCampaign, 0)).toEqual({ ok: true });
    });

    it('is eligible when campaign_ends_at is in the future', () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      expect(isCampaignEligible({ ...baseCampaign, campaign_ends_at: future }, 0)).toEqual({
        ok: true,
      });
    });

    it('is eligible when redemptions are below the cap', () => {
      expect(isCampaignEligible({ ...baseCampaign, total_redemptions_allowed: 10 }, 9)).toEqual({
        ok: true,
      });
    });
  });

  describe('not ok', () => {
    it('returns inactive when active=false', () => {
      expect(isCampaignEligible({ ...baseCampaign, active: false }, 0)).toEqual({
        ok: false,
        reason: 'inactive',
      });
    });

    it('returns ended when campaign_ends_at is in the past', () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      expect(isCampaignEligible({ ...baseCampaign, campaign_ends_at: past }, 0)).toEqual({
        ok: false,
        reason: 'ended',
      });
    });

    it('returns ended when campaign_ends_at equals now (boundary is inclusive-past)', () => {
      const now = new Date();
      expect(
        isCampaignEligible({ ...baseCampaign, campaign_ends_at: now.toISOString() }, 0, now)
      ).toEqual({ ok: false, reason: 'ended' });
    });

    it('returns capped when redemption count equals the cap', () => {
      expect(isCampaignEligible({ ...baseCampaign, total_redemptions_allowed: 10 }, 10)).toEqual({
        ok: false,
        reason: 'capped',
      });
    });

    it('returns capped when redemption count exceeds the cap', () => {
      expect(isCampaignEligible({ ...baseCampaign, total_redemptions_allowed: 10 }, 100)).toEqual({
        ok: false,
        reason: 'capped',
      });
    });

    it('inactive takes precedence over ended and capped', () => {
      // Stable ordering across reasons: caller shows the one reason
      // string back to the user. `inactive` wins because it's the most
      // specific admin action; `ended` / `capped` are passive.
      const past = new Date(Date.now() - 1000).toISOString();
      expect(
        isCampaignEligible(
          {
            active: false,
            campaign_ends_at: past,
            total_redemptions_allowed: 1,
          },
          100
        )
      ).toEqual({ ok: false, reason: 'inactive' });
    });
  });
});
