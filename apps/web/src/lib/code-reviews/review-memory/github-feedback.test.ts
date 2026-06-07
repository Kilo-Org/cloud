/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import type {
  PullRequestReviewCommentPayload,
  PullRequestReviewPayload,
  PullRequestReviewThreadPayload,
} from '@/lib/integrations/platforms/github/webhook-schemas';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  agent_configs,
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_state,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  handleGitHubReviewCommentFeedback,
  handleGitHubReviewFeedback,
  handleGitHubReviewThreadFeedback,
} from './github-feedback';
import { upsertFeedbackSubject, type ReviewMemoryOwner } from './db';

describe('GitHub review memory feedback', () => {
  afterEach(async () => {
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(agent_configs);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  async function seedIntegration({ enableMemory = true }: { enableMemory?: boolean } = {}) {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `review-memory-${Date.now()}-${Math.random()}`,
        github_app_type: 'standard',
      })
      .returning();

    if (!integration) throw new Error('Failed to seed platform integration');
    if (enableMemory) {
      await db.insert(agent_configs).values({
        owned_by_user_id: user.id,
        agent_type: 'code_review',
        platform: 'github',
        config: { review_memory_enabled: true },
        is_enabled: false,
        created_by: user.id,
      });
    }
    return { user, owner: { type: 'user' as const, id: user.id }, integration };
  }

  function repository() {
    return {
      id: 123,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    };
  }

  function pullRequest() {
    return {
      number: 42,
      html_url: 'https://github.com/acme/widgets/pull/42',
      head: { sha: 'abc123', ref: 'feature/widgets' },
    };
  }

  async function seedInlineSubject(owner: ReviewMemoryOwner, externalId = '500') {
    return await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      subjectType: 'inline_comment',
      externalId,
      prNumber: 42,
      state: 'active',
    });
  }

  it('records only the first reply to a Kilo inline comment', async () => {
    const { owner, integration } = await seedIntegration();
    const subject = await seedInlineSubject(owner);

    const correctivePayload = {
      action: 'created',
      comment: {
        id: 501,
        in_reply_to_id: 500,
        body: 'This is a false positive in this repository.',
        user: { login: 'maintainer', type: 'User' },
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r501',
        path: 'src/widget.ts',
        line: 12,
        diff_hunk: '@@ -1 +1 @@',
        author_association: 'MEMBER',
      },
      pull_request: {
        ...pullRequest(),
        title: 'Add widgets',
        user: { login: 'author' },
        base: { ref: 'main' },
      },
      repository: repository(),
      installation: { id: 98765 },
      sender: { login: 'maintainer' },
    } satisfies PullRequestReviewCommentPayload;

    const supportivePayload = {
      ...correctivePayload,
      comment: {
        ...correctivePayload.comment,
        id: 502,
        body: 'Good catch, fixed this now.',
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r502',
      },
    } satisfies PullRequestReviewCommentPayload;

    const correctiveResult = await handleGitHubReviewCommentFeedback({
      payload: correctivePayload,
      integration,
      deliveryId: 'delivery-corrective-reply',
    });
    const supportiveResult = await handleGitHubReviewCommentFeedback({
      payload: supportivePayload,
      integration,
      deliveryId: 'delivery-supportive-reply',
    });

    expect(correctiveResult.recorded).toBe(true);
    expect(supportiveResult).toEqual({
      recorded: false,
      reason: 'subject-already-has-reply-feedback',
    });
    const events = await db.select().from(code_review_feedback_events);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        subject_id: subject.id,
        signal_kind: 'corrective_reply',
        sentiment: 'negative',
        evidence_excerpt: 'This is a false positive in this repository.',
      })
    );
  });

  it('skips feedback without writing events when review memory is disabled', async () => {
    const { owner, integration } = await seedIntegration({ enableMemory: false });
    await seedInlineSubject(owner);
    const payload = {
      action: 'created',
      comment: {
        id: 509,
        in_reply_to_id: 500,
        body: 'This is a false positive in this repository.',
        user: { login: 'maintainer', type: 'User' },
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r509',
        path: 'src/widget.ts',
        line: 12,
        diff_hunk: '@@ -1 +1 @@',
        author_association: 'MEMBER',
      },
      pull_request: {
        ...pullRequest(),
        title: 'Add widgets',
        user: { login: 'author' },
        base: { ref: 'main' },
      },
      repository: repository(),
      installation: { id: 98765 },
      sender: { login: 'maintainer' },
    } satisfies PullRequestReviewCommentPayload;

    await expect(
      handleGitHubReviewCommentFeedback({
        payload,
        integration,
        deliveryId: 'delivery-disabled-reply',
      })
    ).resolves.toEqual({ recorded: false, reason: 'review-memory-disabled' });
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });

  it('records replies from maintainers with kilo in their login', async () => {
    const { owner, integration } = await seedIntegration();
    await seedInlineSubject(owner);
    const payload = {
      action: 'created',
      comment: {
        id: 503,
        in_reply_to_id: 500,
        body: 'This is a false positive in this repository.',
        user: { login: 'kilodev', type: 'User' },
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r503',
        path: 'src/widget.ts',
        line: 12,
        diff_hunk: '@@ -1 +1 @@',
        author_association: 'MEMBER',
      },
      pull_request: {
        ...pullRequest(),
        title: 'Add widgets',
        user: { login: 'author' },
        base: { ref: 'main' },
      },
      repository: repository(),
      installation: { id: 98765 },
      sender: { login: 'kilodev' },
    } satisfies PullRequestReviewCommentPayload;

    const result = await handleGitHubReviewCommentFeedback({
      payload,
      integration,
      deliveryId: 'delivery-kilodev-reply',
    });

    expect(result.recorded).toBe(true);
  });

  it('skips unmatched inline replies even when they mention @kilo fix', async () => {
    const { integration } = await seedIntegration();
    const payload = {
      action: 'created',
      comment: {
        id: 504,
        in_reply_to_id: 999,
        body: '@kilo fix this false positive',
        user: { login: 'maintainer', type: 'User' },
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r504',
        path: 'src/widget.ts',
        line: 12,
        diff_hunk: '@@ -1 +1 @@',
        author_association: 'MEMBER',
      },
      pull_request: {
        ...pullRequest(),
        title: 'Add widgets',
        user: { login: 'author' },
        base: { ref: 'main' },
      },
      repository: repository(),
      installation: { id: 98765 },
      sender: { login: 'maintainer' },
    } satisfies PullRequestReviewCommentPayload;

    await expect(
      handleGitHubReviewCommentFeedback({
        payload,
        integration,
        deliveryId: 'delivery-unmatched-inline-reply',
      })
    ).resolves.toEqual({ recorded: false, reason: 'not-kilo-subject' });
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(0);
  });

  it('records @kilo fix replies as normal inline feedback for Kilo subjects', async () => {
    const { owner, integration } = await seedIntegration();
    const subject = await seedInlineSubject(owner);
    const payload = {
      action: 'created',
      comment: {
        id: 505,
        in_reply_to_id: 500,
        body: '@kilo fix this',
        user: { login: 'maintainer', type: 'User' },
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r505',
        path: 'src/widget.ts',
        line: 12,
        diff_hunk: '@@ -1 +1 @@',
        author_association: 'MEMBER',
      },
      pull_request: {
        ...pullRequest(),
        title: 'Add widgets',
        user: { login: 'author' },
        base: { ref: 'main' },
      },
      repository: repository(),
      installation: { id: 98765 },
      sender: { login: 'maintainer' },
    } satisfies PullRequestReviewCommentPayload;

    const result = await handleGitHubReviewCommentFeedback({
      payload,
      integration,
      deliveryId: 'delivery-kilo-fix-inline-reply',
    });

    expect(result.recorded).toBe(true);
    const events = await db.select().from(code_review_feedback_events);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        subject_id: subject.id,
        signal_kind: 'supportive_reply',
        sentiment: 'neutral',
        strength: 1,
        evidence_excerpt: '@kilo fix this',
      })
    );
  });

  it('records Kilo review dismissals and review-thread resolution', async () => {
    const { integration } = await seedIntegration();
    const dismissedReview = {
      action: 'dismissed',
      review: {
        id: 700,
        state: 'dismissed',
        user: { login: 'kilo-code[bot]' },
      },
      pull_request: {
        number: 42,
        state: 'open',
        merged: false,
        html_url: 'https://github.com/acme/widgets/pull/42',
        title: 'Add widgets',
        head: {
          sha: 'abc123',
          ref: 'feature/widgets',
          repo: {
            full_name: 'acme/widgets',
            clone_url: 'https://github.com/acme/widgets.git',
            html_url: 'https://github.com/acme/widgets',
          },
        },
      },
      repository: repository(),
      installation: { id: 98765 },
    } satisfies PullRequestReviewPayload;
    const resolvedThread = {
      action: 'resolved',
      thread: {
        id: 'thread-1',
        is_resolved: true,
        comments: [
          {
            id: 500,
            body: '**WARNING**: Avoid this pattern',
            html_url: 'https://github.com/acme/widgets/pull/42#discussion_r500',
            path: 'src/widget.ts',
            line: 12,
            diff_hunk: '@@ -1 +1 @@',
          },
        ],
      },
      pull_request: pullRequest(),
      repository: repository(),
      installation: { id: 98765 },
      sender: { login: 'maintainer', type: 'User' },
    } satisfies PullRequestReviewThreadPayload;

    await handleGitHubReviewFeedback({
      payload: dismissedReview,
      integration,
      deliveryId: 'delivery-review-dismissed',
    });
    await handleGitHubReviewThreadFeedback({
      payload: resolvedThread,
      integration,
      deliveryId: 'delivery-thread-resolved',
    });

    const events = await db.select().from(code_review_feedback_events);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal_kind: 'review_dismissed', sentiment: 'negative' }),
        expect.objectContaining({ signal_kind: 'thread_resolved', sentiment: 'positive' }),
      ])
    );

    const [threadSubject] = await db
      .select()
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.file_path, 'src/widget.ts'));
    expect(threadSubject.state).toBe('resolved');
  });
});
