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
} from './github-feedback';
import { setReviewMemoryEnabled } from './settings';

describe('GitHub review memory feedback', () => {
  afterEach(async () => {
    await db.delete(code_review_feedback_events);
    await db.delete(agent_configs);
    await db.delete(kilocode_users);
  });

  it('records the first human reply to a Kilo inline comment', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 101,
        body: 'This is intentional in generated code.',
      }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-1',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
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
    });
    const second = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 202, body: 'Second reply' }),
      integration,
      deliveryId: 'delivery-3',
      fetchParentComment,
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
    });
    const second = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 252, body: 'Second owner reply' }),
      integration: buildIntegration(secondUser.id),
      deliveryId: 'delivery-3b',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
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

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 303, body: 'Looks wrong.' }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-4',
      fetchParentComment: parentFetcher({ userLogin: 'octocat' }),
    });

    expect(result).toEqual({ recorded: false, reason: 'not-kilo-comment' });
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });

  it('skips contributor replies to Kilo inline comments', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({
        parentCommentId: 353,
        body: 'I do not think this applies.',
        authorAssociation: 'CONTRIBUTOR',
      }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-4b',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
    });

    expect(result).toEqual({ recorded: false, reason: 'not-maintainer-reply' });
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });

  it('skips replies while review memory is disabled', async () => {
    const user = await insertTestUser();

    const result = await handleGitHubReviewCommentReply({
      payload: buildPayload({ parentCommentId: 404, body: 'Please stop flagging this.' }),
      integration: buildIntegration(user.id),
      deliveryId: 'delivery-5',
      fetchParentComment: parentFetcher({ userLogin: 'kilo-code[bot]' }),
    });

    expect(result).toEqual({ recorded: false, reason: 'review-memory-disabled' });
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });
});

function buildIntegration(userId: string): PlatformIntegration {
  return {
    owned_by_user_id: userId,
    owned_by_organization_id: null,
    github_app_type: 'standard',
  } as PlatformIntegration;
}

function buildPayload(input: {
  parentCommentId: number;
  body: string;
  authorAssociation?: PullRequestReviewCommentPayload['comment']['author_association'];
}): PullRequestReviewCommentPayload {
  return {
    action: 'created',
    comment: {
      id: input.parentCommentId + 1,
      body: input.body,
      user: { login: 'maintainer' },
      in_reply_to_id: input.parentCommentId,
      created_at: '2026-06-01T00:00:00.000Z',
      html_url: `https://github.com/acme/widgets/pull/42#discussion_r${input.parentCommentId + 1}`,
      path: 'src/widget.ts',
      line: 10,
      diff_hunk: '@@',
      author_association: input.authorAssociation ?? 'MEMBER',
    },
    pull_request: {
      number: 42,
      title: 'Test PR',
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { login: 'contributor' },
      head: { sha: 'abc123', ref: 'feature' },
      base: { ref: 'main' },
    },
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      private: true,
      owner: { login: 'acme' },
    },
    installation: { id: 123 },
    sender: { login: 'maintainer' },
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
