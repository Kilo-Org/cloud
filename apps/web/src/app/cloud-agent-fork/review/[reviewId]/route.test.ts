import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_CODE_REVIEW_MODE,
  DEFAULT_CODE_REVIEW_MODEL,
} from '@/lib/code-reviews/core/constants';
import { buildFixReviewPrompt } from '@/lib/code-reviews/prompts/fix-review-prompt';

type TrpcContextFixture = {
  user: {
    id: string;
  };
};

type ReviewFixture = {
  id: string;
  owned_by_organization_id: string | null;
  repo_full_name: string;
  pr_url: string;
  platform: string;
  model: string | null;
};

type ReviewResult =
  | {
      success: true;
      review: ReviewFixture;
      attempts: unknown[];
    }
  | {
      success: false;
      error: string;
    };

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

type RouteContext = {
  params: Promise<{ reviewId: string }>;
};

type RouteGet = (request: NextRequest, context: RouteContext) => Promise<Response>;

const mockCreateTRPCContext = jest.fn<() => Promise<TrpcContextFixture>>();
const mockCodeReviewsGet = jest.fn<(input: { reviewId: string }) => Promise<ReviewResult>>();
const mockPersonalPrepareSession =
  jest.fn<(input: PrepareSessionInput) => Promise<PrepareSessionOutput>>();
const mockOrganizationPrepareSession =
  jest.fn<
    (input: PrepareSessionInput & { organizationId: string }) => Promise<PrepareSessionOutput>
  >();

const mockCaller = {
  codeReviews: {
    get: mockCodeReviewsGet,
  },
  cloudAgentNext: {
    prepareSession: mockPersonalPrepareSession,
  },
  organizations: {
    cloudAgentNext: {
      prepareSession: mockOrganizationPrepareSession,
    },
  },
};
const mockCreateCaller = jest.fn((_: TrpcContextFixture) => mockCaller);
const mockCreateCallerFactory = jest.fn(() => mockCreateCaller);

jest.mock('@/lib/trpc/init', () => ({
  createTRPCContext: () => mockCreateTRPCContext(),
  createCallerFactory: () => mockCreateCallerFactory(),
}));

jest.mock('@/routers/root-router', () => ({
  rootRouter: {},
}));

let getRoute: RouteGet;

const REVIEW_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PR_URL = 'https://github.com/owner/repo/pull/123';
const PERSONAL_KILO_SESSION_ID = 'ses_12345678901234567890123456';
const ORG_KILO_SESSION_ID = 'ses_abcdefabcdefabcdefabcdefab';

function makeReview(overrides: Partial<ReviewFixture> = {}): ReviewFixture {
  return {
    id: REVIEW_ID,
    owned_by_organization_id: null,
    repo_full_name: 'owner/repo',
    pr_url: PR_URL,
    platform: 'github',
    model: 'anthropic/custom-model',
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

function makeRequest(reviewId = REVIEW_ID): NextRequest {
  return new NextRequest(`https://kilo.test/cloud-agent-fork/review/${reviewId}`);
}

function makeContext(reviewId = REVIEW_ID): RouteContext {
  return { params: Promise.resolve({ reviewId }) };
}

async function requestReview(reviewId = REVIEW_ID) {
  return getRoute(makeRequest(reviewId), makeContext(reviewId));
}

function getRedirectUrl(response: Response): URL {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  return new URL(location ?? '');
}

function expectErrorRedirect(response: Response, error: string) {
  const redirectUrl = getRedirectUrl(response);
  expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(`/code-reviews?error=${error}`);
}

function expectNoSessionCreation() {
  expect(mockPersonalPrepareSession).not.toHaveBeenCalled();
  expect(mockOrganizationPrepareSession).not.toHaveBeenCalled();
}

describe('GET /cloud-agent-fork/review/[reviewId]', () => {
  beforeAll(async () => {
    ({ GET: getRoute } = await import('./route'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTRPCContext.mockResolvedValue({ user: { id: 'user_1' } });
    mockSuccessfulReview();
    mockPersonalPrepareSession.mockResolvedValue({
      kiloSessionId: PERSONAL_KILO_SESSION_ID,
      cloudAgentSessionId: 'agent_personal',
    });
    mockOrganizationPrepareSession.mockResolvedValue({
      kiloSessionId: ORG_KILO_SESSION_ID,
      cloudAgentSessionId: 'agent_org',
    });
  });

  it('rejects invalid UUIDs without authenticating, loading reviews, or creating sessions', async () => {
    const response = await requestReview('not-a-uuid');

    expectErrorRedirect(response, 'invalid_review_id');
    expect(mockCreateTRPCContext).not.toHaveBeenCalled();
    expect(mockCodeReviewsGet).not.toHaveBeenCalled();
    expectNoSessionCreation();
  });

  it('redirects signed-out requests to sign in with the compatibility callback path', async () => {
    mockCreateTRPCContext.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'not signed in' })
    );

    const response = await requestReview();
    const redirectUrl = getRedirectUrl(response);

    expect(response.status).toBe(307);
    expect(redirectUrl.pathname).toBe('/users/sign_in');
    expect(redirectUrl.searchParams.get('callbackPath')).toBe(
      `/cloud-agent-fork/review/${REVIEW_ID}`
    );
    expect(mockCodeReviewsGet).not.toHaveBeenCalled();
    expectNoSessionCreation();
  });

  it('starts personal review fix sessions with a free-text Cloud Agent Next prompt', async () => {
    const response = await requestReview();
    const redirectUrl = getRedirectUrl(response);

    expect(mockCodeReviewsGet).toHaveBeenCalledWith({ reviewId: REVIEW_ID });
    expect(mockPersonalPrepareSession).toHaveBeenCalledWith({
      githubRepo: 'owner/repo',
      prompt: buildFixReviewPrompt(PR_URL),
      mode: DEFAULT_CODE_REVIEW_MODE,
      model: 'anthropic/custom-model',
      autoInitiate: true,
      autoCommit: false,
    });
    expect(mockOrganizationPrepareSession).not.toHaveBeenCalled();

    const input = mockPersonalPrepareSession.mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('upstreamBranch');
    expect(input).not.toHaveProperty('initialPayload');

    expect(response.status).toBe(303);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(
      `/cloud/chat?sessionId=${PERSONAL_KILO_SESSION_ID}`
    );
  });

  it('starts organization review fix sessions on the organization chat path with model fallback', async () => {
    mockSuccessfulReview({ owned_by_organization_id: ORG_ID, model: null });

    const response = await requestReview();
    const redirectUrl = getRedirectUrl(response);

    expect(mockPersonalPrepareSession).not.toHaveBeenCalled();
    expect(mockOrganizationPrepareSession).toHaveBeenCalledWith({
      githubRepo: 'owner/repo',
      prompt: buildFixReviewPrompt(PR_URL),
      mode: DEFAULT_CODE_REVIEW_MODE,
      model: DEFAULT_CODE_REVIEW_MODEL,
      autoInitiate: true,
      autoCommit: false,
      organizationId: ORG_ID,
    });

    const input = mockOrganizationPrepareSession.mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('upstreamBranch');
    expect(input).not.toHaveProperty('initialPayload');

    expect(response.status).toBe(303);
    expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(
      `/organizations/${ORG_ID}/cloud/chat?sessionId=${ORG_KILO_SESSION_ID}`
    );
  });

  it('expands the fix-review workflow into ordinary prompt text', () => {
    const prompt = buildFixReviewPrompt(PR_URL);

    expect(prompt).toContain(`GitHub PR URL: ${PR_URL}`);
    expect(prompt).toContain(`gh pr checkout "${PR_URL}"`);
    expect(prompt).toContain('gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate');
    expect(prompt).toContain('gh api user --jq');
    expect(prompt).toContain("reactions -f content='+1'");
    expect(prompt).toContain('Create one commit per fixed review comment');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('summary table');
    expect(prompt).toContain('in_reply_to');
    expect(prompt).not.toContain('$ARGUMENTS');
    expect(prompt).not.toContain('/fix-review');
  });

  it('redirects missing reviews to review_not_found without creating a session', async () => {
    mockCodeReviewsGet.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'review not found' })
    );

    const response = await requestReview();

    expectErrorRedirect(response, 'review_not_found');
    expectNoSessionCreation();
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN'] as const)(
    'redirects authenticated lookup %s errors to access_denied',
    async code => {
      mockCodeReviewsGet.mockRejectedValue(new TRPCError({ code, message: 'denied' }));

      const response = await requestReview();

      expectErrorRedirect(response, 'access_denied');
      expectNoSessionCreation();
    }
  );

  it('redirects failed review result envelopes without creating a session', async () => {
    mockCodeReviewsGet.mockResolvedValue({ success: false, error: 'lookup failed' });

    const response = await requestReview();

    expectErrorRedirect(response, 'fix_session_failed');
    expectNoSessionCreation();
  });

  it('rejects non-GitHub reviews without creating a session', async () => {
    mockSuccessfulReview({ platform: 'gitlab' });

    const response = await requestReview();

    expectErrorRedirect(response, 'unsupported_platform');
    expectNoSessionCreation();
  });

  it('redirects generic preparation failures to fix_session_failed', async () => {
    mockPersonalPrepareSession.mockRejectedValue(new Error('worker unavailable'));

    const response = await requestReview();

    expectErrorRedirect(response, 'fix_session_failed');
    expect(mockPersonalPrepareSession).toHaveBeenCalledTimes(1);
    expect(mockOrganizationPrepareSession).not.toHaveBeenCalled();
  });
});
