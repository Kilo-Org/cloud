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

const mockGetStytchStatus = jest.fn<Promise<boolean | null>, [User, string | null, Headers]>();
const mockHandleSignupPromotion = jest.fn<Promise<void>, [User, boolean]>();
jest.mock('@/lib/stytch', () => ({
  getStytchStatus: (...args: [User, string | null, Headers]) => mockGetStytchStatus(...args),
  handleSignupPromotion: (...args: [User, boolean]) => mockHandleSignupPromotion(...args),
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
