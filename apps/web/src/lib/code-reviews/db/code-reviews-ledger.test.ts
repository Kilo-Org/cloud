/**
 * @jest-environment node
 *
 * Coverage for the best-effort ledger contracts in `createCodeReview`
 * (P1-A-07c) and the cancel wrappers. `admitOperation` and `settleOperation`
 * are mocked so a rejected admit or settle can be exercised; the review insert
 * and cancel still run against the real test DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

const mockAdmitOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSettleOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@kilocode/db/operation-ledger', () => {
  const actual = jest.requireActual('@kilocode/db/operation-ledger');
  return {
    ...actual,
    admitOperation: (...args: unknown[]) => mockAdmitOperation(...args),
    settleOperation: (...args: unknown[]) => mockSettleOperation(...args),
  };
});

import { codeReviewTerminalOutcome } from '../code-review-ledger';
import { db } from '@/lib/drizzle';
import {
  agent_configs,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  cancelActiveCodeReviewsById,
  createCodeReview,
  disableBitbucketCodeReviewerForIntegration,
  updateCodeReviewStatus,
} from './code-reviews';

const REPO = `test-org/ledger-admit-reject-${Date.now()}`;

describe('createCodeReview ledger admit is best-effort', () => {
  let testUser: User;
  let githubIntegrationId: string;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [githubIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUser.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `ledger-admit-reject-${Date.now()}`,
        platform_account_id: 'ledger-admit-reject',
        platform_account_login: 'ledger-admit-reject',
        repository_access: 'all',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!githubIntegration) {
      throw new Error('Expected ledger admit reject integration');
    }
    githubIntegrationId = githubIntegration.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db.delete(platform_integrations).where(eq(platform_integrations.id, githubIntegrationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('still returns the review id when the ledger admit rejects', async () => {
    mockAdmitOperation.mockRejectedValue(new Error('database unavailable'));

    const reviewId = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId: githubIntegrationId,
      repoFullName: REPO,
      prNumber: 1,
      prUrl: `https://github.com/${REPO}/pull/1`,
      prTitle: 'ledger admit reject',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/ledger-admit-reject',
      headSha: 'ledger-admit-reject-head-sha',
      platform: 'github',
      triggerSource: 'manual',
    });
    createdReviewIds.push(reviewId);

    expect(reviewId).toEqual(expect.any(String));
    expect(mockAdmitOperation).toHaveBeenCalledTimes(1);
  });
});

describe('codeReviewTerminalOutcome', () => {
  it('maps superseded and user-cancelled cancellations to terminal outcomes', () => {
    expect(codeReviewTerminalOutcome('cancelled', 'superseded')).toBe('superseded');
    expect(codeReviewTerminalOutcome('cancelled', 'user_cancelled')).toBe('no_op');
    expect(codeReviewTerminalOutcome('cancelled', 'interrupted')).toBe('interrupted');
    expect(codeReviewTerminalOutcome('pending', null)).toBeNull();
  });
});

describe('cancel settle is best-effort', () => {
  let testUser: User;
  let organizationId: string;
  let githubIntegrationId: string;
  let bitbucketIntegrationId: string;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Ledger settle ${Date.now()}` })
      .returning({ id: organizations.id });
    if (!organization) {
      throw new Error('Expected ledger settle organization');
    }
    organizationId = organization.id;

    const [githubIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUser.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `ledger-settle-github-${Date.now()}`,
        platform_account_id: 'ledger-settle-github',
        platform_account_login: 'ledger-settle-github',
        repository_access: 'all',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!githubIntegration) {
      throw new Error('Expected ledger settle github integration');
    }
    githubIntegrationId = githubIntegration.id;

    const [bitbucketIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organizationId,
        platform: 'bitbucket',
        integration_type: 'oauth',
        platform_installation_id: `ledger-settle-bitbucket-${Date.now()}`,
        platform_account_id: 'ledger-settle-bitbucket',
        platform_account_login: 'ledger-settle-bitbucket',
        repository_access: 'selected',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!bitbucketIntegration) {
      throw new Error('Expected ledger settle bitbucket integration');
    }
    bitbucketIntegrationId = bitbucketIntegration.id;
  });

  afterAll(async () => {
    if (createdReviewIds.length > 0) {
      await db
        .delete(cloud_agent_code_reviews)
        .where(inArray(cloud_agent_code_reviews.id, createdReviewIds));
    }
    await db
      .delete(agent_configs)
      .where(eq(agent_configs.owned_by_organization_id, organizationId));
    await db
      .delete(platform_integrations)
      .where(inArray(platform_integrations.id, [githubIntegrationId, bitbucketIntegrationId]));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const actual = jest.requireActual('@kilocode/db/operation-ledger') as {
      admitOperation: (...args: unknown[]) => Promise<unknown>;
      settleOperation: (...args: unknown[]) => Promise<unknown>;
    };
    mockAdmitOperation.mockImplementation(actual.admitOperation);
    mockSettleOperation.mockRejectedValue(new Error('ledger unavailable'));
  });

  it('still cancels reviews when the ledger settle fails (cancelActiveCodeReviewsById)', async () => {
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId: githubIntegrationId,
      repoFullName: `${REPO}-settle-by-id`,
      prNumber: 1,
      prUrl: `https://github.com/${REPO}-settle-by-id/pull/1`,
      prTitle: 'ledger settle by id',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/ledger-settle-by-id',
      headSha: 'ledger-settle-by-id-head-sha',
      platform: 'github',
      triggerSource: 'manual',
    });
    createdReviewIds.push(reviewId);

    const cancelled = await cancelActiveCodeReviewsById([reviewId], 'Superseded by new push');

    expect(cancelled.map(row => row.id)).toContain(reviewId);
    expect(mockSettleOperation).toHaveBeenCalledTimes(1);
    const [review] = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    expect(review?.status).toBe('cancelled');
  });

  it('still disables and cancels when the ledger settle fails (disableBitbucketCodeReviewerForIntegration)', async () => {
    await db.insert(agent_configs).values({
      owned_by_organization_id: organizationId,
      agent_type: 'code_review',
      platform: 'bitbucket',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
        selected_repository_ids: ['22222222-2222-4222-8222-222222222222'],
      },
      is_enabled: true,
      created_by: testUser.id,
    });
    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organizationId, userId: testUser.id },
      platformIntegrationId: bitbucketIntegrationId,
      repoFullName: `${REPO}-settle-disable`,
      prNumber: 2,
      prUrl: `https://bitbucket.org/${REPO}-settle-disable/pull-requests/2`,
      prTitle: 'ledger settle disable',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/ledger-settle-disable',
      headSha: 'ledger-settle-disable-head-sha',
      platform: 'bitbucket',
      triggerSource: 'manual',
    });
    createdReviewIds.push(reviewId);
    await updateCodeReviewStatus(reviewId, 'queued');

    const cancelled = await disableBitbucketCodeReviewerForIntegration({
      organizationId,
      integrationId: bitbucketIntegrationId,
    });

    expect(cancelled.map(row => row.id)).toContain(reviewId);
    expect(mockSettleOperation).toHaveBeenCalledTimes(1);
    const [review] = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    expect(review?.status).toBe('cancelled');
    const [config] = await db
      .select({ isEnabled: agent_configs.is_enabled })
      .from(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_organization_id, organizationId),
          eq(agent_configs.platform, 'bitbucket')
        )
      );
    expect(config?.isEnabled).toBe(false);
  });
});
