/**
 * @jest-environment node
 *
 * Coverage for the best-effort admit-on-create contract in `createCodeReview`
 * (P1-A-07c). `admitOperation` is mocked so a rejected admit can be exercised;
 * the review insert still runs against the real test DB.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { createCodeReview as createCodeReviewType } from './code-reviews';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

const mockAdmitOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mockAdmitOperation,
  settleOperation: jest.fn(),
  isTerminalOperationStatus: (status: string) =>
    ['completed', 'failed', 'no_op', 'interrupted', 'superseded'].includes(status),
}));

let createCodeReview: typeof createCodeReviewType;

const REPO = `test-org/ledger-admit-reject-${Date.now()}`;

describe('createCodeReview ledger admit is best-effort', () => {
  let testUser: User;
  let githubIntegrationId: string;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    ({ createCodeReview } = await import('./code-reviews'));
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
