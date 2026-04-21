/**
 * Tests for the account-verification page redirect logic.
 *
 * The CORRECT behavior should be:
 * - If stytchStatus !== null AND user.customer_source !== null:
 *   redirect directly to the final destination (callbackPath or /get-started),
 *   skipping the survey entirely.
 * - If stytchStatus !== null AND user.customer_source === null:
 *   redirect to /customer-source-survey with callbackPath forwarding.
 * - If stytchStatus === null: render the page (no redirect).
 */

import React from 'react';
import type { User } from '@kilocode/db/schema';

// Make React available globally for JSX in the server component
(globalThis as { React: typeof React }).React = React;

// --- Capture redirect calls ---
const mockRedirect = jest.fn<never, [string]>(() => {
  // next/navigation redirect() throws to halt execution
  throw new Error('NEXT_REDIRECT');
});

// --- Mock dependencies ---
jest.mock('next/navigation', () => ({
  redirect: (...args: [string]) => mockRedirect(...args),
}));

jest.mock('next/headers', () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

const mockGetUserFromAuthOrRedirect = jest.fn<Promise<User>, [string?]>();
jest.mock('@/lib/user.server', () => ({
  getUserFromAuthOrRedirect: (...args: [string?]) => mockGetUserFromAuthOrRedirect(...args),
}));

type SignupSourceArg =
  | { kind: 'openclaw-security-advisor' }
  | { kind: 'credit-campaign'; slug: string }
  | null;
const mockGetStytchStatus = jest.fn<Promise<boolean | null>, [User, string | null, Headers]>();
const mockHandleSignupPromotion = jest.fn<Promise<void>, [User, boolean, SignupSourceArg?]>();
jest.mock('@/lib/stytch', () => ({
  getStytchStatus: (...args: [User, string | null, Headers]) => mockGetStytchStatus(...args),
  handleSignupPromotion: (...args: [User, boolean, SignupSourceArg?]) =>
    mockHandleSignupPromotion(...args),
}));

// Mock the DB-backed campaign lookup. The page calls this to confirm that a
// /c/<slug> callback refers to a real campaign before attributing the
// signup; tests stub it per-case via `mockLookupCampaignBySlug`.
const mockLookupCampaignBySlug = jest.fn<Promise<unknown>, [string]>();
jest.mock('@/lib/credit-campaigns', () => ({
  // Re-export the pure helpers so `isCreditCampaignCallback` still runs in
  // the page. Only the DB-touching function needs mocking.
  ...jest.requireActual('@/lib/credit-campaigns-shared'),
  lookupCampaignBySlug: (slug: string) => mockLookupCampaignBySlug(slug),
}));

// Mock React components that aren't relevant to redirect testing
jest.mock('@/components/auth/StytchClient', () => ({
  StytchClient: () => null,
}));
jest.mock('@/components/AnimatedLogo', () => ({
  AnimatedLogo: () => null,
}));
jest.mock('@/components/BigLoader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/layouts/PageContainer', () => ({
  PageContainer: ({ children }: { children: React.ReactNode }) => children,
}));

// isValidCallbackPath is NOT mocked — we use the real implementation
// so the tests also validate that paths like /get-started pass validation.

// --- Helper to build a test user ---
function makeUser(overrides: Partial<User> = {}): User {
  const id = `test-user-${Math.random()}`;
  const now = new Date().toISOString();
  return {
    id,
    google_user_email: `${id}@example.com`,
    google_user_name: 'Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `stripe-${id}`,
    hosted_domain: '@@NON_WORKSPACE_GOOGLE_ACCOUNT@@',
    created_at: now,
    updated_at: now,
    microdollars_used: 0,
    kilo_pass_threshold: null,
    total_microdollars_acquired: 0,
    is_admin: false,
    blocked_reason: null,
    has_validation_novel_card_with_hold: false,
    has_validation_stytch: false,
    api_token_pepper: null,
    auto_top_up_enabled: false,
    default_model: null,
    is_bot: false,
    next_credit_expiration_at: null,
    cohorts: {},
    completed_welcome_form: false,
    linkedin_url: null,
    github_url: null,
    discord_server_membership_verified_at: null,
    openrouter_upstream_safety_identifier: null,
    customer_source: null,
    ...overrides,
  } as User;
}

// --- Helper to invoke the page component ---
async function renderPage(searchParams: Record<string, string> = {}) {
  // Use isolateModulesAsync to guarantee a fresh module import each time,
  // preventing module caching from causing false positives across tests.
  await jest.isolateModulesAsync(async () => {
    const mod = await import('@/app/account-verification/page');
    const AccountVerificationPage = mod.default;
    try {
      await AccountVerificationPage({
        searchParams: Promise.resolve(searchParams),
        params: Promise.resolve(undefined),
      });
    } catch (e: unknown) {
      // redirect() throws NEXT_REDIRECT — that's expected
      if (e instanceof Error && e.message !== 'NEXT_REDIRECT') {
        throw e;
      }
    }
  });
}

// --- Tests ---
describe('account-verification redirect logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the module so each test gets a fresh import
    jest.resetModules();
  });

  // ---------------------------------------------------------------
  // Baseline: stytchStatus === null means no redirect (page renders)
  // ---------------------------------------------------------------
  describe('when stytchStatus is null (not yet verified)', () => {
    it('should NOT redirect — renders the verification page', async () => {
      const user = makeUser({ customer_source: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(null);

      await renderPage();

      expect(mockRedirect).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // Case: verified user who has NOT completed the survey
  // ---------------------------------------------------------------
  describe('when stytchStatus is non-null AND customer_source is null (survey not completed)', () => {
    it('should redirect to /customer-source-survey with /get-started as default destination', async () => {
      const user = makeUser({ customer_source: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage();

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith(
        `/customer-source-survey?callbackPath=${encodeURIComponent('/get-started')}`
      );
    });

    it('should redirect to /customer-source-survey with callbackPath forwarded', async () => {
      const user = makeUser({ customer_source: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/get-started' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith(
        `/customer-source-survey?callbackPath=${encodeURIComponent('/get-started')}`
      );
    });

    it('should redirect to /customer-source-survey with an org callbackPath forwarded', async () => {
      const user = makeUser({ customer_source: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/organizations/some-org-id' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith(
        `/customer-source-survey?callbackPath=${encodeURIComponent('/organizations/some-org-id')}`
      );
    });
  });

  // ---------------------------------------------------------------
  // Case: verified user who HAS completed the survey
  // These tests expose the redundant-redirect bug.
  // ---------------------------------------------------------------
  describe('when stytchStatus is non-null AND customer_source is set (survey already completed)', () => {
    it('should redirect directly to /get-started, NOT through /customer-source-survey', async () => {
      const user = makeUser({ customer_source: 'Twitter' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage();

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('should redirect directly to callbackPath when customer_source is set', async () => {
      const user = makeUser({ customer_source: 'Twitter' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/get-started' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('should redirect directly to an org callbackPath when customer_source is set', async () => {
      const user = makeUser({ customer_source: 'A friend or colleague' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/organizations/some-org-id' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith('/organizations/some-org-id');
    });

    it('should redirect to /get-started when customer_source is empty string (skipped survey)', async () => {
      const user = makeUser({ customer_source: '' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage();

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('should redirect directly to callbackPath when customer_source is empty string (skipped)', async () => {
      const user = makeUser({ customer_source: '' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/get-started' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });
  });

  // ---------------------------------------------------------------
  // Edge: stytchStatus is false (non-null but falsy)
  // false !== null, so redirect logic should still fire
  // ---------------------------------------------------------------
  describe('when stytchStatus is false (verified but not allowed free tier)', () => {
    it('should still redirect — false is non-null', async () => {
      const user = makeUser({ customer_source: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(false);

      await renderPage();

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith(
        `/customer-source-survey?callbackPath=${encodeURIComponent('/get-started')}`
      );
    });

    it('should skip survey when customer_source is set even with stytchStatus=false', async () => {
      const user = makeUser({ customer_source: 'Google search' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(false);

      await renderPage();

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });
  });

  // ---------------------------------------------------------------
  // Bonus attribution: signupSource passed to handleSignupPromotion
  // Regression coverage for kilobot findings on PR #2622:
  //   1. `startsWith('/openclaw-advisor')` matched sibling paths like
  //      `/openclaw-advisor-fake` — must now exact-match the pathname.
  //   2. Already-validated users hitting /account-verification directly
  //      could self-award the bonus once — must gate on the transition
  //      from has_validation_stytch=null to non-null.
  // ---------------------------------------------------------------
  describe('openclaw-security-advisor signupSource attribution', () => {
    it('attributes a new user with callbackPath=/openclaw-advisor', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/openclaw-advisor?code=ABCD-1234' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, {
        kind: 'openclaw-security-advisor',
      });
    });

    it('does NOT attribute sibling path /openclaw-advisor-fake (exact-pathname match)', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/openclaw-advisor-fake?code=ABCD-1234' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute already-validated user who visits with openclaw-advisor callback', async () => {
      const user = makeUser({ has_validation_stytch: true });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/openclaw-advisor?code=ABCD-1234' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute when callbackPath is a different product path', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/device-auth?code=ABCD-1234' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    // Defense-in-depth for the blocker called out in the post-merge review
    // on PR #2622: even if a user manually reaches /account-verification
    // with callbackPath=/openclaw-advisor (bypassing the page-level
    // short-circuit in openclaw-advisor/page.tsx), bonus attribution must
    // still refuse when no valid device-auth code accompanies the path.
    // The code is the "real plugin flow" signal; without it any visitor
    // could self-award the bonus by visiting the sign-in URL directly.
    it('does NOT attribute when callbackPath=/openclaw-advisor has no code param', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/openclaw-advisor' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute when callbackPath=/openclaw-advisor code is malformed', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      // `.` and `_` survive URL parsing but fall outside the device-auth
      // charset `[A-Za-z0-9-]`. Must not qualify for the bonus even
      // though the pathname exact-matches.
      await renderPage({ callbackPath: '/openclaw-advisor?code=ab.cd' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute when callbackPath=/openclaw-advisor code exceeds 16 chars', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      // 17 ASCII alphanumerics — within the charset but longer than the
      // device-auth generator ever produces. Rejected by the format guard.
      await renderPage({ callbackPath: '/openclaw-advisor?code=ABCDEFGHIJKLMNOPQ' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });
  });

  // ---------------------------------------------------------------
  // Bonus attribution for admin-managed URL campaigns (/c/<slug>).
  // Mirrors the openclaw-advisor attribution guards (exact-path match,
  // first-validation-only, sibling-path rejection) because the same
  // class of abuse applies: a manually-constructed callback must not
  // award a signup bonus without completing the real flow.
  // ---------------------------------------------------------------
  describe('credit-campaign signupSource attribution', () => {
    beforeEach(() => {
      // Default: slug lookup succeeds with a minimal campaign stub. Tests
      // that exercise the "dead callback" path override with null.
      mockLookupCampaignBySlug.mockResolvedValue({ slug: 'mocked', id: 1 });
    });

    it('attributes a new user with callbackPath=/c/<slug> when campaign exists and strips the callback', async () => {
      // A /c/<slug> URL is a one-shot signup entry — once the bonus is
      // granted, sending the user back to /c/<slug> just shows them the
      // "for new accounts" message. Always strip the callback so they
      // land on /get-started like any other new signup.
      const user = makeUser({ has_validation_stytch: null, customer_source: 'Reddit' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/summit' });

      expect(mockLookupCampaignBySlug).toHaveBeenCalledWith('summit');
      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, {
        kind: 'credit-campaign',
        slug: 'summit',
      });
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('attributes a slug with internal hyphens and digits', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/podcast-q1-2026' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, {
        kind: 'credit-campaign',
        slug: 'podcast-q1-2026',
      });
    });

    it('does NOT attribute when the slug format is valid but the campaign is not in DB', async () => {
      // Prevents phantom `credit-campaign` analytics tags; strip still
      // fires on the callback so signup lands on /get-started instead of
      // the dead /c/<slug> URL.
      mockLookupCampaignBySlug.mockResolvedValue(null);
      const user = makeUser({ has_validation_stytch: null, customer_source: 'Reddit' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/doesnotexist' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('strips malformed /c/<slug> callbacks (uppercase, too short) — no bounce to the malformed URL', async () => {
      // `isValidCallbackPath` whitelists any `/c/` prefix, but
      // `isCreditCampaignCallback` requires the slug to match
      // `/^[a-z0-9-]{5,40}$/`. Without the prefix-level strip, a crafted
      // /c/Summit (uppercase) or /c/xx (short) would pass the callback
      // whitelist but skip the strip, and the user would be redirected
      // to the malformed URL post-signup.
      const user = makeUser({ has_validation_stytch: null, customer_source: 'Reddit' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/Summit' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('strips /c/<slug> callbacks on the post-validation pass (has_validation_stytch already set)', async () => {
      // During a real signup, account-verification renders twice: first
      // to mount the Stytch client, then after Stytch completes. By the
      // second pass `has_validation_stytch` is no longer null. The strip
      // decision runs independently of `isFirstValidation` so the redirect
      // still routes to /get-started, not the (now-useless) /c/<slug>.
      const user = makeUser({ has_validation_stytch: true, customer_source: 'Reddit' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/summit' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });

    it('does NOT attribute sibling path /c-fake/<slug> (prefix-match guard)', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c-fake/summit' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute when residual path segments follow the slug', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/summit/extra' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute a bare /c/ with no slug', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute a slug shorter than 5 chars', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/abc' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute already-validated user with /c/<slug> callback', async () => {
      const user = makeUser({ has_validation_stytch: true });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/summit' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });

    it('does NOT attribute slugs with uppercase or invalid chars', async () => {
      const user = makeUser({ has_validation_stytch: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: '/c/Summit' });

      expect(mockHandleSignupPromotion).toHaveBeenCalledWith(user, true, null);
    });
  });

  // ---------------------------------------------------------------
  // Edge: invalid callbackPath should be ignored
  // ---------------------------------------------------------------
  describe('when callbackPath is invalid', () => {
    it('should ignore invalid callbackPath for user without customer_source', async () => {
      const user = makeUser({ customer_source: null });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: 'https://evil.com/phish' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      // Invalid callbackPath is dropped — redirect to survey with default destination
      expect(mockRedirect).toHaveBeenCalledWith(
        `/customer-source-survey?callbackPath=${encodeURIComponent('/get-started')}`
      );
    });

    it('should ignore invalid callbackPath for user with customer_source set', async () => {
      const user = makeUser({ customer_source: 'Reddit' });
      mockGetUserFromAuthOrRedirect.mockResolvedValue(user);
      mockGetStytchStatus.mockResolvedValue(true);

      await renderPage({ callbackPath: 'https://evil.com/phish' });

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      // Invalid callbackPath dropped — go to /get-started
      expect(mockRedirect).toHaveBeenCalledWith('/get-started');
    });
  });
});
