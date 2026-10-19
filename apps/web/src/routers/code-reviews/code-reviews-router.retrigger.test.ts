import crypto from 'crypto';

// The plan gate short-circuits when local review development is on, and the shared
// test environment sets that flag. Force it off so the gate is exercised here.
const mockIsLocalCodeReviewDevelopmentEnabled = jest.fn<boolean, []>();
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  isLocalCodeReviewDevelopmentEnabled: () => mockIsLocalCodeReviewDevelopmentEnabled(),
}));

const mockDispatchReview = jest.fn();
const mockGetReviewStatus = jest.fn();
const mockPrepareReviewPayload = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    dispatchReview: (...args: unknown[]) => mockDispatchReview(...args),
    getReviewStatus: (...args: unknown[]) => mockGetReviewStatus(...args),
  },
}));

jest.mock('@/lib/code-reviews/triggers/prepare-review-payload', () => ({
  prepareReviewPayload: (...args: unknown[]) => mockPrepareReviewPayload(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  organization_memberships,
  organization_seats_purchases,
  organizations,
  platform_integrations,
  type User,
} from '@kilocode/db/schema';
import type { ManualCodeReviewConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';

const REPO = `test-org/retrigger-plan-gate-${Date.now()}`;

function manualProviderReviewConfig(): ManualCodeReviewConfig {
  return {
    agentConfig: {
      review_style: 'balanced',
      focus_areas: [],
      model_slug: 'anthropic/claude-sonnet-4.6',
    },
    instructions: null,
    outputMode: 'provider',
  };
}

describe('retrigger plan gate for council reviews', () => {
  let owner: User;
  let organizationId: string;
  let integrationId: string;
  let reviewSequence = 0;

  beforeAll(async () => {
    owner = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({
        name: `Retrigger Plan Gate ${Date.now()}`,
        plan: 'enterprise',
        require_seats: true,
        created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        free_trial_end_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .returning({ id: organizations.id });
    if (!organization) throw new Error('Expected plan gate organization');
    organizationId = organization.id;

    await db
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: owner.id, role: 'owner' });

    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organizationId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `retrigger-gate-${Date.now()}`,
        platform_account_id: 'retrigger-gate',
        platform_account_login: 'retrigger-gate',
        repository_access: 'all',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!integration) throw new Error('Expected plan gate integration');
    integrationId = integration.id;
  });

  beforeEach(() => {
    mockIsLocalCodeReviewDevelopmentEnabled.mockReturnValue(false);
    mockDispatchReview.mockResolvedValue(undefined);
    mockGetReviewStatus.mockResolvedValue(null);
    mockPrepareReviewPayload.mockImplementation((params: { reviewId: string }) => ({
      reviewId: params.reviewId,
      sessionInput: { prompt: 'Review this change.' },
    }));
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db
      .delete(organization_seats_purchases)
      .where(eq(organization_seats_purchases.organization_id, organizationId));
    mockIsLocalCodeReviewDevelopmentEnabled.mockReset();
    mockDispatchReview.mockReset();
    mockGetReviewStatus.mockReset();
    mockPrepareReviewPayload.mockReset();
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, owner.id));
  });

  async function addSeatPurchase(subscriptionStatus: 'active' | 'ended') {
    await db.insert(organization_seats_purchases).values({
      organization_id: organizationId,
      subscription_stripe_id: `sub_${crypto.randomUUID()}`,
      seat_count: 1,
      amount_usd: 100,
      starts_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      subscription_status: subscriptionStatus,
    });
  }

  async function insertFailedCouncilReview() {
    const sequence = reviewSequence++;
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: organizationId,
        platform_integration_id: integrationId,
        repo_full_name: REPO,
        pr_number: sequence + 1,
        pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
        pr_title: `Plan gate PR ${sequence + 1}`,
        pr_author: 'octocat',
        base_ref: 'main',
        head_ref: `feature/plan-gate-${sequence}`,
        head_sha: `sha-plan-gate-${sequence}`,
        review_type: 'council',
        trigger_source: 'manual',
        manual_config: manualProviderReviewConfig(),
        status: 'failed',
        error_message: 'Dispatch failed: worker unreachable',
      })
      .returning({ id: cloud_agent_code_reviews.id });
    if (!review) throw new Error('Expected council review to be inserted');
    return review.id;
  }

  async function getStoredReview(reviewId: string) {
    const [review] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        errorMessage: cloud_agent_code_reviews.error_message,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);
    return review;
  }

  it('ends the retry attempt for a council review when the plan is not met and keeps the review in its current state', async () => {
    const reviewId = await insertFailedCouncilReview();
    const caller = await createCallerForUser(owner.id);

    await expect(caller.codeReviews.retrigger({ reviewId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Council reviews require an Enterprise plan.',
    });

    const stored = await getStoredReview(reviewId);
    expect(stored).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Dispatch failed: worker unreachable',
      })
    );
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('retries a council review and dispatches it when the plan is met', async () => {
    const reviewId = await insertFailedCouncilReview();
    await addSeatPurchase('active');
    const caller = await createCallerForUser(owner.id);

    const result = await caller.codeReviews.retrigger({ reviewId });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    const stored = await getStoredReview(reviewId);
    expect(stored?.status).toBe('queued');
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId, skipBalanceCheck: true })
    );
  });
});
