const mockPull = jest.fn();
const mockCompare = jest.fn();
const mockComment = jest.fn();
const mockSummary = jest.fn();
const mockListComments = jest.fn();
const mockHead = jest.fn();
const mockInstructions = jest.fn();
const mockInference = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { get: mockPull },
    repos: { compareCommits: mockCompare },
    issues: { getComment: mockComment, listComments: mockListComments },
  })),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn().mockResolvedValue({ token: 'fixture-token' }),
  findKiloReviewComment: (...args: unknown[]) => mockSummary(...args),
  fetchPRInlineComments: jest.fn().mockResolvedValue([]),
  getPRHeadCommit: (...args: unknown[]) => mockHead(...args),
  fetchGitHubRootTextFileAtRef: (...args: unknown[]) => mockInstructions(...args),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '123' }),
  getGitHubAppName: () => 'KiloConnect',
}));
jest.mock('../isolate-review-model', () => ({
  resolveIsolateReviewInference: (...args: unknown[]) => mockInference(...args),
}));

import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_reviews,
  cloud_agent_code_review_attempts,
  organizations,
  organization_memberships,
  platform_integrations,
  kilocode_users,
  type User,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import { createDefaultCodeReviewConfig } from '../core/default-config';
import { admitCodeReviewAttemptForDispatch } from '../db/code-reviews';
import { acquireIsolatePublicationFence } from '../db/publication-fences';
import { hashIsolateReviewText } from '../isolate-review-prompt';
import { Octokit } from '@octokit/rest';
import {
  findQueuedIsolateReviewSummary,
  prepareIsolateReviewPayload,
} from './prepare-isolate-review-payload';
import type { QueuedIsolateIdentity } from '../queued-isolate-contract';
import { IsolateReviewRequestSchema } from '@/lib/isolate-review-worker-client';

const worker: { StartReviewRequestSchema: typeof IsolateReviewRequestSchema } = jest.requireActual(
  '../../../../../../services/isolate-review/src/types'
);
const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
const repo = 'acme/widget';
const oldBody =
  '<!-- kilo-review -->\nPrevious finding\n\n---\n<!-- kilo-usage -->\n<sub>Old usage</sub>';
const summary = {
  id: 22,
  body: oldBody,
  issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
  user: { id: 456, login: 'kiloconnect[bot]', type: 'Bot' },
  performed_via_github_app: { id: 123 },
  updated_at: '2026-09-01T00:00:00Z',
};

describe('queued summary selection', () => {
  const findSummary = () =>
    findQueuedIsolateReviewSummary({
      octokit: new Octokit(),
      owner: 'acme',
      repo: 'widget',
      pullNumber: 42,
      appId: 123,
      authorLogin: 'kiloconnect[bot]',
    });

  beforeEach(() => {
    mockListComments.mockReset().mockResolvedValue({ data: [] });
  });

  it.each([
    { user: { id: 999, login: 'human', type: 'User' } },
    { user: { id: 999, login: 'foreign[bot]', type: 'Bot' } },
    { user: { id: 999, login: 'kiloconnect[bot]', type: 'User' } },
    { performed_via_github_app: { id: 999 } },
    { performed_via_github_app: null },
    { issue_url: 'https://api.github.com/repos/acme/widget/issues/43' },
    { body: 'A quoted marker: <!-- kilo-review -->' },
  ])('ignores foreign summary markers before selecting the latest candidate: %j', async changed => {
    const foreign = {
      ...summary,
      id: 99,
      updated_at: '2026-09-02T00:00:00Z',
      ...changed,
    };
    mockListComments.mockResolvedValue({ data: [summary, foreign] });
    expect(await findSummary()).toEqual({ commentId: summary.id, body: oldBody });
    mockListComments.mockResolvedValue({ data: [foreign] });
    expect(await findSummary()).toBeNull();
  });

  it('selects the latest verified summary across bounded comment pages', async () => {
    const latest = {
      ...summary,
      id: 44,
      updated_at: '2026-09-02T00:00:00Z',
      body: '<!-- kilo-review -->\nLatest verified summary',
    };
    mockListComments
      .mockResolvedValueOnce({
        data: [
          summary,
          ...Array.from({ length: 99 }, (_, index) => ({
            ...summary,
            id: 100 + index,
            user: { id: 999, login: 'human', type: 'User' },
          })),
        ],
      })
      .mockResolvedValueOnce({ data: [latest] });
    expect(await findSummary()).toEqual({ commentId: latest.id, body: latest.body });
    expect(mockListComments).toHaveBeenNthCalledWith(2, {
      owner: 'acme',
      repo: 'widget',
      issue_number: 42,
      per_page: 100,
      page: 2,
    });
  });

  it('does not authorize a candidate when comment traversal is incomplete', async () => {
    mockListComments.mockResolvedValue({ data: Array.from({ length: 100 }, () => summary) });
    await expect(findSummary()).rejects.toThrow('safe issue-comment scan limit');
    expect(mockListComments).toHaveBeenCalledTimes(5);
  });

  it('propagates failed reads instead of treating them as no existing summary', async () => {
    mockListComments.mockRejectedValue(new Error('Comment read failed'));
    await expect(findSummary()).rejects.toThrow('Comment read failed');
  });
});

describe('canonical queued isolate preparation', () => {
  let user: User;
  let organizationId: string;
  let integration: PlatformIntegration;
  let identity: QueuedIsolateIdentity;
  let reservation: string;
  const reviewIds: string[] = [];
  const saved = () => ({
    ...createDefaultCodeReviewConfig(),
    model_slug: 'global-model',
    review_style: 'strict' as const,
    focus_areas: ['security'],
    custom_instructions: 'Saved policy',
    disable_review_md: false,
    gate_threshold: 'warning' as const,
    repository_model_overrides: [
      { repository_id: 1, repo_full_name: repo, model_slug: 'repo-model', thinking_effort: 'high' },
    ],
  });
  const prepare = (config = saved()) =>
    prepareIsolateReviewPayload({
      identity,
      owner: { type: 'org', id: organizationId, userId: user.id },
      dispatchReservationId: reservation,
      agentConfig: { config },
    });

  beforeAll(async () => {
    user = await insertTestUser({ id: `oauth/github/preparation-${crypto.randomUUID()}` });
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Queued preparation tests' })
      .returning();
    organizationId = org.id;
    await db
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: user.id, role: 'member' });
    [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organizationId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '12345',
        platform_account_id: '23456',
        platform_account_login: 'acme',
        repository_access: 'all',
        integration_status: 'active',
        github_app_type: 'standard',
      })
      .returning();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected external network request'));
    mockPull.mockResolvedValue({
      data: {
        number: 42,
        state: 'open',
        draft: false,
        head: { sha: snapshot.headSha },
        base: { sha: snapshot.baseTipSha, repo: { full_name: repo } },
      },
    });
    mockCompare.mockResolvedValue({
      data: {
        base_commit: { sha: snapshot.baseTipSha },
        merge_base_commit: { sha: snapshot.mergeBaseSha },
      },
    });
    mockSummary.mockResolvedValue(null);
    mockListComments.mockReset().mockResolvedValue({ data: [] });
    mockHead.mockResolvedValue(snapshot.headSha);
    mockComment.mockResolvedValue({ data: summary });
    mockInstructions.mockResolvedValue('Repository policy');
    mockInference.mockImplementation(async ({ model, thinkingEffort }) => ({
      modelId: model,
      thinkingEffort: thinkingEffort ?? null,
      provider: 'openai-compatible',
      variant: null,
      reasoningSupported: true,
      maxOutputTokens: 8192,
    }));
    reservation = crypto.randomUUID();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: organizationId,
        platform_integration_id: integration.id,
        repo_full_name: repo,
        pr_number: 42,
        pr_url: 'https://github.com/acme/widget/pull/42',
        pr_title: 'Preparation test',
        pr_author: 'author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: snapshot.headSha,
        status: 'queued',
        dispatch_reservation_id: reservation,
      })
      .returning();
    reviewIds.push(review.id);
    const attempt = await admitCodeReviewAttemptForDispatch({
      codeReviewId: review.id,
      dispatchReservationId: reservation,
      previousStatus: 'pending',
    });
    identity = {
      reviewId: review.id,
      attemptId: attempt.id,
      generation: crypto.randomUUID(),
      organizationId,
      integrationId: integration.id,
      executionUserId: user.id,
      target: { host: 'github.com', repoFullName: repo, prNumber: 42 },
      snapshot,
    };
    await acquireIsolatePublicationFence({ identity, dispatchReservationId: reservation });
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ analytics_enabled_at_dispatch: true })
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db
      .delete(cloud_agent_code_reviews)
      .where(inArray(cloud_agent_code_reviews.id, reviewIds));
    reviewIds.length = 0;
    await db
      .update(platform_integrations)
      .set({ integration_status: 'active', github_app_type: 'standard', auth_invalid_at: null })
      .where(eq(platform_integrations.id, integration.id));
    await db
      .update(kilocode_users)
      .set({ blocked_at: null, blocked_reason: null })
      .where(eq(kilocode_users.id, user.id));
  });

  afterAll(async () => {
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  });

  it('uses the canonical attempt, exact snapshot, saved policy, model override and one-hour organization bearer without another admission', async () => {
    const result = await prepare();
    expect(result.admission.identity).toEqual(identity);
    expect(result.admission.runId).toBe(identity.attemptId);
    expect(result.review.preparation).toMatchObject({
      executionUserId: user.id,
      organizationId,
      snapshot,
      settings: {
        model: 'repo-model',
        thinkingEffort: 'high',
        modelSource: 'repository',
        reviewStyle: 'strict',
        analyticsEnabled: true,
      },
      queued: { identity, gateThreshold: 'warning', summaryHistory: '' },
      reviewInstructions: {
        sha: snapshot.baseTipSha,
        hash: hashIsolateReviewText('Repository policy'),
      },
    });
    expect(result.review.userPrompt).toContain('Saved policy');
    expect(result.review.userPrompt).toContain('Repository policy');
    expect(result.review.userPrompt).toContain(identity.reviewId);
    expect(result.review.userPrompt).toContain(identity.attemptId);
    expect(result.review.userPrompt).toContain('gateResult');
    expect(result.review.userPrompt).not.toContain('No canonical review row');
    expect(mockInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ ref: snapshot.baseTipSha })
    );
    const claims = jwt.verify(result.authToken, NEXTAUTH_SECRET);
    expect(claims).toMatchObject({
      kiloUserId: user.id,
      organizationId,
      tokenSource: 'isolate-review',
      botId: 'reviewer',
    });
    if (typeof claims === 'string') throw new Error('Expected JWT claims');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);
    const workerRequest = worker.StartReviewRequestSchema.parse(result.review);
    expect(hashIsolateReviewText(JSON.stringify(workerRequest))).toBe(
      result.admission.preparationHash
    );
    expect(
      await db
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId))
    ).toHaveLength(1);
  });

  it('preserves explicit manual model/effort and instructions rather than applying repository overrides', async () => {
    await db
      .update(cloud_agent_code_reviews)
      .set({
        manual_config: {
          agentConfig: { ...saved(), model_slug: 'manual-model', thinking_effort: null },
          outputMode: 'provider',
          instructions: 'Manual policy',
        },
      })
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
    const result = await prepare();
    expect(result.review.preparation?.settings).toMatchObject({
      model: 'manual-model',
      thinkingEffort: null,
      modelSource: 'explicit',
      manualInstructions: 'Manual policy',
    });
    expect(result.review.userPrompt).toContain('Manual policy');
  });

  it.each([9_999, 10_000, 10_001, 20_000])(
    'preserves REVIEW.md policy and bounded metadata for %i characters',
    async characterCount => {
      mockInstructions.mockResolvedValue('x'.repeat(characterCount));
      const truncated = characterCount > 10_000;
      const content =
        'x'.repeat(Math.min(characterCount, 10_000)) +
        (truncated ? '\n\n[REVIEW.md truncated after 10000 characters.]' : '');

      const result = await prepare();
      const request = IsolateReviewRequestSchema.parse(result.review);
      expect(request.preparation?.reviewInstructions).toEqual({
        path: 'REVIEW.md',
        sha: snapshot.baseTipSha,
        hash: hashIsolateReviewText(content),
        characterCount: Math.min(characterCount, 10_000),
        truncated,
      });
      expect(request.userPrompt).toContain(content);
      if (truncated) expect(request.userPrompt).not.toContain('x'.repeat(10_001));
      const workerRequest = worker.StartReviewRequestSchema.parse(request);
      expect(workerRequest).toEqual(request);
      expect(hashIsolateReviewText(JSON.stringify(workerRequest))).toBe(
        result.admission.preparationHash
      );
    }
  );

  it('uses the global fallback and disables REVIEW.md without reading it', async () => {
    const result = await prepare({
      ...saved(),
      model_slug: '',
      repository_model_overrides: [],
      disable_review_md: true,
    });
    expect(result.review.preparation?.settings.modelSource).toBe('global');
    expect(result.review.model).not.toBe('');
    expect(mockInstructions).not.toHaveBeenCalled();
    expect(result.review.preparation?.reviewInstructions).toBeUndefined();
  });

  it('adopts only the exact server-authorized legacy summary and builds history without old usage', async () => {
    mockListComments.mockResolvedValue({ data: [summary] });
    const result = await prepare();
    expect(result.review.preparation?.queued?.summaryTarget).toEqual({
      commentId: 22,
      bodyHash: hashIsolateReviewText(oldBody),
      authorId: 456,
      authorLogin: summary.user.login,
      appId: 123,
    });
    expect(result.review.preparation?.queued?.summaryHistory).toContain('Previous finding');
    expect(result.review.preparation?.queued?.summaryHistory).not.toContain('Old usage');
    expect(result.review.existingSummaryCommentId).toBeUndefined();
    expect(result.review.previousRunId).toBeUndefined();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('does not let a newer human marker replace the canonical Kilo summary', async () => {
    const foreign = {
      ...summary,
      id: 99,
      body: '<!-- kilo-review -->\nForeign summary',
      updated_at: '2026-09-02T00:00:00Z',
      user: { id: 999, login: 'human', type: 'User' },
    };
    mockListComments.mockResolvedValue({ data: [summary, foreign] });
    const result = await prepare();
    expect(result.review.preparation?.queued?.summaryTarget).toMatchObject({
      commentId: summary.id,
      bodyHash: hashIsolateReviewText(oldBody),
    });
    expect(mockComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widget',
      comment_id: summary.id,
    });
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it.each([
    { id: 99 },
    { body: 'edited' },
    { issue_url: 'https://api.github.com/repos/acme/widget/issues/43' },
    { performed_via_github_app: { id: 999 } },
    { user: { id: 456, login: 'foreign[bot]', type: 'Bot' } },
    { user: { id: 456, login: 'kiloconnect[bot]', type: 'User' } },
  ])('rejects altered or foreign summary metadata: %j', async changed => {
    mockListComments.mockResolvedValue({ data: [summary] });
    mockComment.mockResolvedValue({ data: { ...summary, ...changed } });
    await expect(prepare()).rejects.toThrow();
  });

  it.each(['head', 'base', 'merge-base', 'context-head', 'repository', 'closed', 'draft'])(
    'rejects changed %s before dispatch',
    async change => {
      if (change === 'context-head') mockHead.mockResolvedValue('d'.repeat(40));
      else if (change === 'merge-base')
        mockCompare.mockResolvedValue({
          data: {
            base_commit: { sha: snapshot.baseTipSha },
            merge_base_commit: { sha: 'd'.repeat(40) },
          },
        });
      else
        mockPull.mockResolvedValue({
          data: {
            number: 42,
            state: change === 'closed' ? 'closed' : 'open',
            draft: change === 'draft',
            head: { sha: change === 'head' ? 'd'.repeat(40) : snapshot.headSha },
            base: {
              sha: change === 'base' ? 'd'.repeat(40) : snapshot.baseTipSha,
              repo: { full_name: change === 'repository' ? 'other/repo' : repo },
            },
          },
        });
      await expect(prepare()).rejects.toThrow();
    }
  );

  it.each(['cancelled', 'reservation', 'generation', 'owner', 'backend'])(
    'rejects stale canonical %s',
    async change => {
      if (change === 'cancelled')
        await db
          .update(cloud_agent_code_reviews)
          .set({ status: 'cancelled' })
          .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
      if (change === 'reservation') reservation = crypto.randomUUID();
      if (change === 'generation') identity = { ...identity, generation: crypto.randomUUID() };
      if (change === 'owner') identity = { ...identity, organizationId: crypto.randomUUID() };
      if (change === 'backend')
        await db
          .update(cloud_agent_code_review_attempts)
          .set({ reviewer_backend: 'legacy', publication_state: null })
          .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
      await expect(prepare()).rejects.toThrow('current canonical attempt');
      expect(mockInference).not.toHaveBeenCalled();
    }
  );

  it('rechecks canonical ownership after awaited preparation', async () => {
    mockInference.mockImplementation(async ({ model, thinkingEffort }) => {
      await db
        .update(cloud_agent_code_reviews)
        .set({ status: 'cancelled' })
        .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
      return {
        modelId: model,
        thinkingEffort,
        provider: 'openai-compatible',
        variant: null,
        reasoningSupported: true,
        maxOutputTokens: 8192,
      };
    });
    await expect(prepare()).rejects.toThrow('current canonical attempt');
  });

  it.each(['blocked', 'inactive', 'lite', 'auth-invalid', 'model'])(
    'fails closed for unavailable %s',
    async change => {
      if (change === 'blocked')
        await db
          .update(kilocode_users)
          .set({ blocked_reason: 'test-block' })
          .where(eq(kilocode_users.id, user.id));
      if (change === 'inactive')
        await db
          .update(platform_integrations)
          .set({ integration_status: 'suspended' })
          .where(eq(platform_integrations.id, integration.id));
      if (change === 'lite')
        await db
          .update(platform_integrations)
          .set({ github_app_type: 'lite' })
          .where(eq(platform_integrations.id, integration.id));
      if (change === 'auth-invalid')
        await db
          .update(platform_integrations)
          .set({ auth_invalid_at: new Date().toISOString() })
          .where(eq(platform_integrations.id, integration.id));
      if (change === 'model') mockInference.mockRejectedValue(new Error('Model is unavailable'));
      await expect(prepare()).rejects.toThrow();
    }
  );
});
