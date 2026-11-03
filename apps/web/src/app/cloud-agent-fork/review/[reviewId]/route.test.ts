import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import {
  DEFAULT_CODE_REVIEW_MODE,
  REVIEW_FIX_SESSION_RATE_LIMIT,
  REVIEW_FIX_SESSION_RATE_WINDOW_SECONDS,
} from '@/lib/code-reviews/core/constants';
import type { SessionStartRateLimitInput } from '@/lib/code-reviews/core/session-start-rate-limit';
import type { FixReviewComment } from '@/lib/code-reviews/fix-review/select-comments';

type TrpcContextFixture = {
  user: {
    id: string;
  };
};

type ReviewFixture = {
  id: string;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  platform_integration_id: string | null;
  repo_full_name: string;
  pr_number: number;
  pr_url: string;
  pr_author: string;
  head_ref: string;
  platform: string;
  model: string | null;
};

type ReviewResult =
  | { success: true; review: ReviewFixture; attempts: unknown[] }
  | { success: false; error: string };

type PrepareSessionInput = {
  githubRepo: string;
  prompt: string;
  mode: string;
  model: string;
  autoInitiate: boolean;
  autoCommit: boolean;
};

type PrepareSessionOutput = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
};

type IntegrationFixture = {
  id: string;
  platform: string;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  metadata: Record<string, unknown> | null;
};

type RouteContext = {
  params: Promise<{ reviewId: string }>;
};

type RouteHandler = (request: NextRequest, context: RouteContext) => Promise<Response>;

const mockCreateTRPCContext = jest.fn<() => Promise<TrpcContextFixture>>();
const mockCodeReviewsGet = jest.fn<(input: { reviewId: string }) => Promise<ReviewResult>>();
const mockGetIntegrationById =
  jest.fn<(integrationId: string) => Promise<IntegrationFixture | null>>();
const mockPersonalPrepareSession =
  jest.fn<(input: PrepareSessionInput) => Promise<PrepareSessionOutput>>();
const mockOrganizationPrepareSession =
  jest.fn<
    (input: PrepareSessionInput & { organizationId: string }) => Promise<PrepareSessionOutput>
  >();
const mockIsSessionStartRateLimited =
  jest.fn<(input: SessionStartRateLimitInput) => Promise<boolean>>();
const mockSelectFixReviewCommentsForReview =
  jest.fn<
    (input: {
      repositoryFullName: string;
      pullNumber: number;
      prAuthor: string;
      initiatorKiloUserId: string;
      integration: IntegrationFixture | null;
    }) => Promise<{ comments: FixReviewComment[]; omittedCount: number }>
  >();

const mockCaller = {
  codeReviews: {
    get: mockCodeReviewsGet,
  },
  organizations: {
    cloudAgentNext: {
      prepareSession: mockOrganizationPrepareSession,
    },
  },
  cloudAgentNext: {
    prepareSession: mockPersonalPrepareSession,
  },
};
const mockCreateCaller = jest.fn((_: TrpcContextFixture) => mockCaller);
const mockCreateCallerFactory = jest.fn(() => mockCreateCaller);

jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: () => mockCreateTRPCContext(),
  createCallerFactory: () => mockCreateCallerFactory(),
}));

jest.mock('@/routers/root-router', () => ({
  rootRouter: {},
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: mockGetIntegrationById,
}));

jest.mock('@/lib/code-reviews/core/session-start-rate-limit', () => ({
  isSessionStartRateLimited: (input: SessionStartRateLimitInput) =>
    mockIsSessionStartRateLimited(input),
}));

jest.mock('@/lib/code-reviews/fix-review/select-comments', () => ({
  selectFixReviewCommentsForReview: (
    input: Parameters<typeof mockSelectFixReviewCommentsForReview>[0]
  ) => mockSelectFixReviewCommentsForReview(input),
}));

let getRoute: RouteHandler;
let postRoute: RouteHandler;

const REVIEW_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = 'user_1';
const OTHER_USER_ID = 'user_2';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const REVIEW_INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';
const PR_URL = 'https://github.com/owner/repo/pull/123';
const PR_NUMBER = 123;
const PR_AUTHOR = 'pr-author';
const PR_BRANCH = 'feature/widgets';
const CONFIGURED_BOT_MODEL = 'z-ai/glm-5.2';
const RESOLVED_USAGE_MODEL = 'z-ai/glm-5.2-20260616';
const PERSONAL_KILO_SESSION_ID = 'ses_12345678901234567890123456';
const ORG_KILO_SESSION_ID = 'ses_abcdefabcdefabcdefabcdefab';
const APP_ORIGIN = 'https://kilo.test';

function makeReview(overrides: Partial<ReviewFixture> = {}): ReviewFixture {
  return {
    id: REVIEW_ID,
    owned_by_user_id: USER_ID,
    owned_by_organization_id: null,
    platform_integration_id: REVIEW_INTEGRATION_ID,
    repo_full_name: 'owner/repo',
    pr_number: PR_NUMBER,
    pr_url: PR_URL,
    pr_author: PR_AUTHOR,
    head_ref: PR_BRANCH,
    platform: 'github',
    model: RESOLVED_USAGE_MODEL,
    ...overrides,
  };
}

function makeIntegration(overrides: Partial<IntegrationFixture> = {}): IntegrationFixture {
  return {
    id: REVIEW_INTEGRATION_ID,
    platform: 'github',
    owned_by_user_id: USER_ID,
    owned_by_organization_id: null,
    metadata: { model_slug: CONFIGURED_BOT_MODEL },
    ...overrides,
  };
}

function mockSuccessfulReview(overrides: Partial<ReviewFixture> = {}) {
  mockCodeReviewsGet.mockResolvedValue({
    success: true,
    review: makeReview(overrides),
    attempts: [],
  });
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  /** `null` omits the header, as a client that sends no `Origin` would. */
  origin?: string | null;
  host?: string | null;
  secFetchSite?: string | null;
};

function makeRequest(reviewId = REVIEW_ID, options: RequestOptions = {}): NextRequest {
  const { method = 'POST', origin = APP_ORIGIN, host = 'kilo.test', secFetchSite = null } = options;
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  if (host !== null) headers.set('host', host);
  if (secFetchSite !== null) headers.set('sec-fetch-site', secFetchSite);

  return new NextRequest(`${APP_ORIGIN}/cloud-agent-fork/review/${reviewId}`, { method, headers });
}

function makeContext(reviewId = REVIEW_ID): RouteContext {
  return { params: Promise.resolve({ reviewId }) };
}

async function openReviewLink(reviewId = REVIEW_ID, options: RequestOptions = {}) {
  return getRoute(makeRequest(reviewId, { ...options, method: 'GET' }), makeContext(reviewId));
}

async function submitFixSession(reviewId = REVIEW_ID, options: RequestOptions = {}) {
  return postRoute(makeRequest(reviewId, { ...options, method: 'POST' }), makeContext(reviewId));
}

function getRedirectUrl(response: Response): URL {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  // Redirects are relative so the dev server's bound origin cannot leak into the Location.
  return new URL(location ?? '', APP_ORIGIN);
}

function expectErrorRedirect(response: Response, error: string) {
  const redirectUrl = getRedirectUrl(response);
  expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(`/code-reviews?error=${error}`);
}

function expectConfirmationRedirect(response: Response, error?: string) {
  const redirectUrl = getRedirectUrl(response);
  const query = error ? `?error=${error}` : '';
  expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(
    `/cloud-agent-fork/review/${REVIEW_ID}/confirm${query}`
  );
}

function expectNoSessionCreation() {
  expect(mockPersonalPrepareSession).not.toHaveBeenCalled();
  expect(mockOrganizationPrepareSession).not.toHaveBeenCalled();
}

const SELECTED_COMMENT: FixReviewComment = {
  id: 4242,
  inReplyToId: null,
  authorLogin: 'kiloconnect[bot]',
  authorType: 'Bot',
  authorId: 240665456,
  path: 'src/widget.ts',
  line: 9,
  body: 'Handle the empty response before reading the body.',
};

function sessionPrompt(): string {
  const call =
    mockPersonalPrepareSession.mock.calls[0] ?? mockOrganizationPrepareSession.mock.calls[0];
  expect(call).toBeTruthy();
  return call?.[0].prompt ?? '';
}

describe('/cloud-agent-fork/review/[reviewId]', () => {
  beforeAll(async () => {
    ({ GET: getRoute, POST: postRoute } = await import('./route'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTRPCContext.mockResolvedValue({ user: { id: USER_ID } });
    mockSuccessfulReview();
    mockGetIntegrationById.mockResolvedValue(makeIntegration());
    mockIsSessionStartRateLimited.mockResolvedValue(false);
    mockSelectFixReviewCommentsForReview.mockResolvedValue({
      comments: [SELECTED_COMMENT],
      omittedCount: 0,
    });
    mockPersonalPrepareSession.mockResolvedValue({
      kiloSessionId: PERSONAL_KILO_SESSION_ID,
      cloudAgentSessionId: 'agent_personal',
    });
    mockOrganizationPrepareSession.mockResolvedValue({
      kiloSessionId: ORG_KILO_SESSION_ID,
      cloudAgentSessionId: 'agent_org',
    });
  });

  describe('GET', () => {
    it('opens the confirmation page without authenticating or preparing a session', async () => {
      const response = await openReviewLink();

      expect(response.status).toBe(302);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expectConfirmationRedirect(response);
      expect(mockCreateTRPCContext).not.toHaveBeenCalled();
      expect(mockCodeReviewsGet).not.toHaveBeenCalled();
      expect(mockIsSessionStartRateLimited).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it('opens the confirmation page for a link followed from a review comment', async () => {
      const response = await openReviewLink(REVIEW_ID, {
        origin: 'https://github.com',
        secFetchSite: 'cross-site',
      });

      expect(response.status).toBe(302);
      expectConfirmationRedirect(response);
      expectNoSessionCreation();
    });

    it('rejects invalid UUIDs without authenticating or preparing a session', async () => {
      const response = await openReviewLink('not-a-uuid');

      expectErrorRedirect(response, 'invalid_review_id');
      expect(mockCreateTRPCContext).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });
  });

  describe('POST', () => {
    it('returns the confirmation page unless the submission comes from the app origin', async () => {
      const response = await submitFixSession(REVIEW_ID, {
        origin: 'https://somewhere-else.test',
        secFetchSite: 'cross-site',
      });

      expect(response.status).toBe(303);
      expectConfirmationRedirect(response, 'invalid_origin');
      expect(mockCreateTRPCContext).not.toHaveBeenCalled();
      expect(mockCodeReviewsGet).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it.each(['cross-site', 'same-site'] as const)(
      'returns the confirmation page unless Sec-Fetch-Site reports this origin (%s)',
      async secFetchSite => {
        const response = await submitFixSession(REVIEW_ID, {
          origin: null,
          secFetchSite,
        });

        expect(response.status).toBe(303);
        expectConfirmationRedirect(response, 'invalid_origin');
        expect(mockCreateTRPCContext).not.toHaveBeenCalled();
        expectNoSessionCreation();
      }
    );

    it('accepts Sec-Fetch-Site as the origin signal when the Origin header is absent', async () => {
      const response = await submitFixSession(REVIEW_ID, {
        origin: null,
        secFetchSite: 'same-origin',
      });

      expect(mockPersonalPrepareSession).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(303);
    });

    it('rejects invalid UUIDs without authenticating, loading reviews, or creating sessions', async () => {
      const response = await submitFixSession('not-a-uuid');

      expectErrorRedirect(response, 'invalid_review_id');
      expect(mockCreateTRPCContext).not.toHaveBeenCalled();
      expect(mockCodeReviewsGet).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it('redirects signed-out submissions to sign in and back to the confirmation page', async () => {
      mockCreateTRPCContext.mockRejectedValue(
        new TRPCError({ code: 'UNAUTHORIZED', message: 'not signed in' })
      );

      const response = await submitFixSession();
      const redirectUrl = getRedirectUrl(response);

      expect(response.status).toBe(302);
      expect(redirectUrl.pathname).toBe('/users/sign_in');
      expect(redirectUrl.searchParams.get('callbackPath')).toBe(
        `/cloud-agent-fork/review/${REVIEW_ID}/confirm`
      );
      expect(mockCodeReviewsGet).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it('starts personal review fix sessions from the server-selected review comments', async () => {
      const response = await submitFixSession();
      const redirectUrl = getRedirectUrl(response);

      expect(mockCodeReviewsGet).toHaveBeenCalledWith({ reviewId: REVIEW_ID });
      expect(mockGetIntegrationById).toHaveBeenCalledWith(REVIEW_INTEGRATION_ID);
      expect(mockGetIntegrationById).toHaveBeenCalledTimes(1);
      expect(mockSelectFixReviewCommentsForReview).toHaveBeenCalledWith({
        repositoryFullName: 'owner/repo',
        pullNumber: PR_NUMBER,
        prAuthor: PR_AUTHOR,
        initiatorKiloUserId: USER_ID,
        integration: makeIntegration(),
      });
      expect(mockPersonalPrepareSession).toHaveBeenCalledWith({
        githubRepo: 'owner/repo',
        prompt: expect.any(String),
        mode: DEFAULT_CODE_REVIEW_MODE,
        model: CONFIGURED_BOT_MODEL,
        autoInitiate: true,
        autoCommit: false,
      });
      expect(mockOrganizationPrepareSession).not.toHaveBeenCalled();
      // This page has no environment picker, so it must not ask for a choice.
      expect(mockPersonalPrepareSession.mock.calls[0]?.[0]).not.toHaveProperty(
        'requireEnvironmentChoice'
      );

      const prompt = sessionPrompt();
      expect(prompt).toContain(`GitHub PR URL: ${PR_URL}`);
      expect(prompt).toContain('Repository: owner/repo');
      expect(prompt).toContain(`Pull request: #${PR_NUMBER}`);
      expect(prompt).toContain(`PR branch: ${PR_BRANCH}`);
      expect(prompt).toContain(`id: ${SELECTED_COMMENT.id}`);
      expect(prompt).toContain(SELECTED_COMMENT.body);

      expect(response.status).toBe(303);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(
        `/cloud/chat?sessionId=${PERSONAL_KILO_SESSION_ID}`
      );
    });

    it('starts organization review fix sessions with the exact linked integration bot model', async () => {
      mockSuccessfulReview({
        owned_by_user_id: null,
        owned_by_organization_id: ORG_ID,
        model: RESOLVED_USAGE_MODEL,
      });
      mockGetIntegrationById.mockResolvedValue(
        makeIntegration({ owned_by_user_id: null, owned_by_organization_id: ORG_ID })
      );

      const response = await submitFixSession();
      const redirectUrl = getRedirectUrl(response);

      expect(mockGetIntegrationById).toHaveBeenCalledWith(REVIEW_INTEGRATION_ID);
      expect(mockGetIntegrationById).toHaveBeenCalledTimes(1);
      expect(mockPersonalPrepareSession).not.toHaveBeenCalled();
      expect(mockOrganizationPrepareSession).toHaveBeenCalledWith({
        githubRepo: 'owner/repo',
        prompt: expect.any(String),
        mode: DEFAULT_CODE_REVIEW_MODE,
        model: CONFIGURED_BOT_MODEL,
        autoInitiate: true,
        autoCommit: false,
        organizationId: ORG_ID,
      });
      expect(sessionPrompt()).toContain(`id: ${SELECTED_COMMENT.id}`);

      expect(response.status).toBe(303);
      expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(
        `/organizations/${ORG_ID}/cloud/chat?sessionId=${ORG_KILO_SESSION_ID}`
      );
    });

    it('starts a no-op session when no review comment is in scope', async () => {
      mockSelectFixReviewCommentsForReview.mockResolvedValue({ comments: [], omittedCount: 0 });

      const response = await submitFixSession();

      expect(response.status).toBe(303);
      const prompt = sessionPrompt();
      expect(prompt).toContain('None. There are no review comments in scope for this run.');
      expect(prompt).toContain('Make no commit, push nothing, and reply to nothing.');
    });

    it('refuses to start a session when comment selection fails', async () => {
      mockSelectFixReviewCommentsForReview.mockRejectedValue(new Error('GitHub unavailable'));

      const response = await submitFixSession();

      expectErrorRedirect(response, 'fix_session_failed');
      expectNoSessionCreation();
    });

    it('counts each start against the acting user inside the review owner scope', async () => {
      await submitFixSession();

      expect(mockIsSessionStartRateLimited).toHaveBeenCalledWith({
        keyPrefix: 'review-fix-session',
        ownerScope: 'personal',
        userId: USER_ID,
        limit: REVIEW_FIX_SESSION_RATE_LIMIT,
        windowSeconds: REVIEW_FIX_SESSION_RATE_WINDOW_SECONDS,
      });
    });

    it('counts organization starts inside the organization scope', async () => {
      mockSuccessfulReview({
        owned_by_user_id: null,
        owned_by_organization_id: ORG_ID,
      });
      mockGetIntegrationById.mockResolvedValue(
        makeIntegration({ owned_by_user_id: null, owned_by_organization_id: ORG_ID })
      );

      await submitFixSession();

      expect(mockIsSessionStartRateLimited).toHaveBeenCalledWith(
        expect.objectContaining({ ownerScope: ORG_ID, userId: USER_ID })
      );
    });

    it('stops starting sessions once the acting user reaches the cap', async () => {
      mockIsSessionStartRateLimited.mockResolvedValue(true);

      const response = await submitFixSession();

      expect(response.status).toBe(303);
      expectConfirmationRedirect(response, 'rate_limited');
      expect(mockSelectFixReviewCommentsForReview).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it('consults the cap only after the review read proves access', async () => {
      mockCodeReviewsGet.mockRejectedValue(
        new TRPCError({ code: 'NOT_FOUND', message: 'review not found' })
      );

      const response = await submitFixSession();

      expectErrorRedirect(response, 'review_not_found');
      expect(mockIsSessionStartRateLimited).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it('redirects missing reviews to review_not_found without creating a session', async () => {
      mockCodeReviewsGet.mockRejectedValue(
        new TRPCError({ code: 'NOT_FOUND', message: 'review not found' })
      );

      const response = await submitFixSession();

      expectErrorRedirect(response, 'review_not_found');
      expectNoSessionCreation();
    });

    it.each(['UNAUTHORIZED', 'FORBIDDEN'] as const)(
      'redirects authenticated lookup %s errors to access_denied',
      async code => {
        mockCodeReviewsGet.mockRejectedValue(new TRPCError({ code, message: 'denied' }));

        const response = await submitFixSession();

        expectErrorRedirect(response, 'access_denied');
        expectNoSessionCreation();
      }
    );

    it('redirects failed review result envelopes without creating a session', async () => {
      mockCodeReviewsGet.mockResolvedValue({ success: false, error: 'lookup failed' });

      const response = await submitFixSession();

      expectErrorRedirect(response, 'fix_session_failed');
      expectNoSessionCreation();
    });

    it('rejects non-GitHub reviews without creating a session', async () => {
      mockSuccessfulReview({ platform: 'gitlab' });

      const response = await submitFixSession();

      expectErrorRedirect(response, 'unsupported_platform');
      expect(mockGetIntegrationById).not.toHaveBeenCalled();
      expectNoSessionCreation();
    });

    it('uses the default bot model for unlinked reviews without owner-wide fallback lookup', async () => {
      mockSuccessfulReview({ platform_integration_id: null });

      const response = await submitFixSession();

      expect(mockGetIntegrationById).not.toHaveBeenCalled();
      expect(mockSelectFixReviewCommentsForReview).toHaveBeenCalledWith({
        repositoryFullName: 'owner/repo',
        pullNumber: PR_NUMBER,
        prAuthor: PR_AUTHOR,
        initiatorKiloUserId: USER_ID,
        integration: null,
      });
      expect(mockPersonalPrepareSession).toHaveBeenCalledWith({
        githubRepo: 'owner/repo',
        prompt: expect.any(String),
        mode: DEFAULT_CODE_REVIEW_MODE,
        model: DEFAULT_BOT_MODEL,
        autoInitiate: true,
        autoCommit: false,
      });
      expect(response.status).toBe(303);
    });

    it('uses the default bot model when the linked integration was deleted', async () => {
      mockGetIntegrationById.mockResolvedValue(null);

      const response = await submitFixSession();

      expect(mockGetIntegrationById).toHaveBeenCalledWith(REVIEW_INTEGRATION_ID);
      expect(mockGetIntegrationById).toHaveBeenCalledTimes(1);
      expect(mockPersonalPrepareSession).toHaveBeenCalledWith({
        githubRepo: 'owner/repo',
        prompt: expect.any(String),
        mode: DEFAULT_CODE_REVIEW_MODE,
        model: DEFAULT_BOT_MODEL,
        autoInitiate: true,
        autoCommit: false,
      });
      expect(response.status).toBe(303);
    });

    it.each([
      {
        name: 'wrong platform',
        integrationOverrides: { platform: 'gitlab' },
      },
      {
        name: 'wrong personal owner',
        integrationOverrides: { owned_by_user_id: OTHER_USER_ID },
      },
      {
        name: 'wrong organization owner',
        reviewOverrides: { owned_by_user_id: null, owned_by_organization_id: ORG_ID },
        integrationOverrides: {
          owned_by_user_id: null,
          owned_by_organization_id: OTHER_ORG_ID,
        },
      },
    ] satisfies Array<{
      name: string;
      reviewOverrides?: Partial<ReviewFixture>;
      integrationOverrides: Partial<IntegrationFixture>;
    }>)('redirects invalid linked integrations with $name provenance', async testCase => {
      mockSuccessfulReview(testCase.reviewOverrides);
      mockGetIntegrationById.mockResolvedValue(makeIntegration(testCase.integrationOverrides));

      const response = await submitFixSession();

      expectErrorRedirect(response, 'fix_session_failed');
      expect(mockGetIntegrationById).toHaveBeenCalledWith(REVIEW_INTEGRATION_ID);
      expect(mockGetIntegrationById).toHaveBeenCalledTimes(1);
      expectNoSessionCreation();
    });

    it('redirects integration lookup failures without creating a session', async () => {
      mockGetIntegrationById.mockRejectedValue(new Error('integration unavailable'));

      const response = await submitFixSession();

      expectErrorRedirect(response, 'fix_session_failed');
      expect(mockGetIntegrationById).toHaveBeenCalledWith(REVIEW_INTEGRATION_ID);
      expect(mockGetIntegrationById).toHaveBeenCalledTimes(1);
      expectNoSessionCreation();
    });

    it('redirects generic preparation failures to fix_session_failed', async () => {
      mockPersonalPrepareSession.mockRejectedValue(new Error('worker unavailable'));

      const response = await submitFixSession();

      expectErrorRedirect(response, 'fix_session_failed');
      expect(mockPersonalPrepareSession).toHaveBeenCalledTimes(1);
      expect(mockOrganizationPrepareSession).not.toHaveBeenCalled();
    });
  });
});
