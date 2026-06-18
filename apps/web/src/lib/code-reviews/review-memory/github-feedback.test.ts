/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  agent_configs,
  code_review_feedback_events,
  kilocode_users,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import type { PullRequestReviewCommentPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { eq } from 'drizzle-orm';

import {
  handleGitHubReviewCommentReply,
  REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH,
  type FetchParentReviewComment,
  type FetchRepositoryPermission,
} from './github-feedback';
import { setReviewMemoryEnabled } from './settings';

describe('GitHub review memory feedback', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(code_review_feedback_events);
    await db.delete(agent_configs);
    await db.delete(kilocode_users);
  });

  it('records the first human reply with effective write access to a Kilo inline comment', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 101,
        body: 'This is intentional in generated code.',
        authorAssociation: 'CONTRIBUTOR',
        commentUserLogin: 'write-access-contributor',
      }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-1',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission: permissionFetcher('write'),
    });

    expect(result.recorded).toBe(true);
    const events = await db.select().from(code_review_feedback_events);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        owned_by_user_id: user.id,
        repo_full_name: 'acme/widgets',
        pr_number: 42,
        kilo_comment_id: '101',
        reply_excerpt: 'This is intentional in generated code.',
        kilo_comment_excerpt: 'Kilo review comment',
      })
    );
  });

  it('dedupes subsequent replies to the same Kilo comment', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });
    const integration = buildIntegration(user.id);
    const fetchParentComment = parentFetcher({ userLogin: 'kilo-code[bot]' });

    await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 202, body: 'First reply' }),
      integration,
      deliveryId: 'delivery-2',
      fetchParentComment,
      fetchRepositoryPermission: permissionFetcher('write'),
    });
    const second = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 202, body: 'Second reply' }),
      integration,
      deliveryId: 'delivery-3',
      fetchParentComment,
      fetchRepositoryPermission: permissionFetcher('write'),
    });

    expect(second.recorded).toBe(false);
    const events = await db
      .select()
      .from(code_review_feedback_events)
      .where(eq(code_review_feedback_events.kilo_comment_id, '202'));
    expect(events).toHaveLength(1);
    expect(events[0].reply_excerpt).toBe('First reply');
  });

  it('does not dedupe replies for different owners', async () => {
    const firstUser = await insertTestUser();
    const secondUser = await insertTestUser();
    const firstOwner = { type: 'user' as const, id: firstUser.id };
    const secondOwner = { type: 'user' as const, id: secondUser.id };
    await setReviewMemoryEnabled({
      owner: firstOwner,
      platform: 'github',
      enabled: true,
      createdBy: firstUser.id,
    });
    await setReviewMemoryEnabled({
      owner: secondOwner,
      platform: 'github',
      enabled: true,
      createdBy: secondUser.id,
    });

    const first = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 252, body: 'First owner reply' }),
      integration: buildIntegration(firstUser.id),
      deliveryId: 'delivery-3a',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission: permissionFetcher('write'),
    });
    const second = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 252, body: 'Second owner reply' }),
      integration: buildIntegration(secondUser.id),
      deliveryId: 'delivery-3b',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission: permissionFetcher('write'),
    });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(true);
    const events = await db
      .select()
      .from(code_review_feedback_events)
      .where(eq(code_review_feedback_events.kilo_comment_id, '252'));
    expect(events).toHaveLength(2);
  });

  it('truncates stored feedback excerpts', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });
    const longReply = 'r'.repeat(REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH + 50);
    const longParent = 'p'.repeat(REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH + 50);

    await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 272, body: longReply }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-3c',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]', body: longParent }),
      fetchRepositoryPermission: permissionFetcher('write'),
    });

    const events = await db
      .select()
      .from(code_review_feedback_events)
      .where(eq(code_review_feedback_events.kilo_comment_id, '272'));
    expect(events).toHaveLength(1);
    expect(events[0].reply_excerpt).toHaveLength(REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH);
    expect(events[0].kilo_comment_excerpt).toHaveLength(REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH);
  });

  it('skips replies when the parent is not authored by a Kilo bot', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });
    const permissionRequests: Array<Parameters<FetchRepositoryPermission>[0]> = [];

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 303, body: 'Looks wrong.' }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-4',
      fetchParentComment: parentFetcher({ userLogin: 'octocat' }),
      fetchRepositoryPermission: permissionFetcher('write', permissionRequests),
    });

    expect(result).toEqual({ recorded: false, reason: 'not-kilo-comment' });
    expect(permissionRequests).toHaveLength(0);
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });

  it.each([
    {
      label: 'read',
      permission: 'read' as const,
      expectedReason: 'insufficient-repository-permission',
    },
    {
      label: 'none',
      permission: 'none' as const,
      expectedReason: 'insufficient-repository-permission',
    },
    {
      label: 'unavailable',
      permission: null,
      expectedReason: 'repository-permission-unavailable',
    },
  ])('fails closed when repository permission is $label', async testCase => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 353,
        body: 'I do not think this applies.',
        authorAssociation: 'OWNER',
        commentUserLogin: `permission-${testCase.label}-user`,
        repoFullName: `acme/permission-${testCase.label}`,
      }),
      integration: buildIntegration(user.id),
      deliveryId: `delivery-4b-${testCase.label}`,
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission: permissionFetcher(testCase.permission),
    });

    expect(result).toEqual({ recorded: false, reason: testCase.expectedReason });
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });

  it('caches repository permission checks for 30 minutes by normalized repository user key', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });
    const integration = buildIntegration(user.id, { githubAppType: 'lite' });
    const permissionRequests: Array<Parameters<FetchRepositoryPermission>[0]> = [];
    const fetchRepositoryPermission = permissionFetcher('write', permissionRequests);
    const nowSpy = jest.spyOn(Date, 'now');
    const baseMs = new Date('2026-06-01T00:00:00.000Z').getTime();
    nowSpy.mockReturnValue(baseMs);

    await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 501,
        body: 'First cached reply',
        commentUserLogin: 'CacheUser',
        repoFullName: 'CacheOwner/CacheRepo',
      }),
      integration,
      deliveryId: 'delivery-cache-1',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission,
    });
    await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 502,
        body: 'Second cached reply',
        commentUserLogin: 'cacheuser',
        repoFullName: 'cacheowner/cacherepo',
      }),
      integration,
      deliveryId: 'delivery-cache-2',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission,
    });

    expect(permissionRequests).toEqual([
      {
        installationId: '123',
        appType: 'lite',
        owner: 'CacheOwner',
        repo: 'CacheRepo',
        username: 'CacheUser',
      },
    ]);

    nowSpy.mockReturnValue(baseMs + 30 * 60_000 + 1);
    await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 503,
        body: 'Third uncached reply',
        commentUserLogin: 'CACHEUSER',
        repoFullName: 'CACHEOWNER/CACHEREPO',
      }),
      integration,
      deliveryId: 'delivery-cache-3',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission,
    });

    expect(permissionRequests).toHaveLength(2);
  });

  it('skips replies while review memory is disabled', async () => {
    const user = await insertTestUser();
    const permissionRequests: Array<Parameters<FetchRepositoryPermission>[0]> = [];

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 404, body: 'Please stop flagging this.' }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-5',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
      fetchRepositoryPermission: permissionFetcher('write', permissionRequests),
    });

    expect(result).toEqual({ recorded: false, reason: 'review-memory-disabled' });
    expect(permissionRequests).toHaveLength(0);
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });
});

function buildIntegration(
  userId: string,
  input: { githubAppType?: PlatformIntegration['github_app_type'] } = {}
): PlatformIntegration {
  return {
    owned_by_user_id: userId,
    owned_by_organization_id: null,
    github_app_type: input.githubAppType ?? 'standard',
  } as PlatformIntegration;
}

function buildPayload(input: {
  parentCommentId: number;
  body: string;
  authorAssociation?: PullRequestReviewCommentPayload['comment']['author_association'];
  commentUserLogin?: string;
  installationId?: number;
  repoFullName?: string;
}): PullRequestReviewCommentPayload {
  const repoFullName = input.repoFullName ?? 'acme/widgets';
  const [repoOwner, repoName] = repoFullName.split('/');
  const commentUserLogin = input.commentUserLogin ?? 'maintainer';

  return {
    action: 'created',
    comment: {
      id: input.parentCommentId + 1,
      body: input.body,
      user: { login: commentUserLogin },
      in_reply_to_id: input.parentCommentId,
      created_at: '2026-06-01T00:00:00.000Z',
      html_url: `https://github.com/${repoFullName}/pull/42#discussion_r${input.parentCommentId + 1}`,
      path: 'src/widget.ts',
      line: 10,
      diff_hunk: '@@',
      author_association: input.authorAssociation ?? 'MEMBER',
    },
    pull_request: {
      number: 42,
      title: 'Test PR',
      html_url: `https://github.com/${repoFullName}/pull/42`,
      user: { login: 'contributor' },
      head: { sha: 'abc123', ref: 'feature' },
      base: { ref: 'main' },
    },
    repository: {
      id: 1,
      name: repoName ?? 'widgets',
      full_name: repoFullName,
      private: true,
      owner: { login: repoOwner ?? 'acme' },
    },
    installation: { id: input.installationId ?? 123 },
    sender: { login: commentUserLogin },
  };
}

function permissionFetcher(
  permission: Awaited<ReturnType<FetchRepositoryPermission>>,
  requests?: Array<Parameters<FetchRepositoryPermission>[0]>
): FetchRepositoryPermission {
  return async request => {
    requests?.push(request);
    return permission;
  };
}

function parentFetcher(input: {
  userLogin: string | null;
  body?: string;
}): FetchParentReviewComment {
  return async request => ({
    id: request.commentId,
    body: input.body ?? 'Kilo review comment',
    userLogin: input.userLogin,
  });
}
