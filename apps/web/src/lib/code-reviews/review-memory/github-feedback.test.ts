/* eslint-disable drizzle/enforce-delete-with-where */
import { createFixTicket, getFixTicketById } from '@/lib/auto-fix/db/fix-tickets';
import { db } from '@/lib/drizzle';
import type {
  PullRequestReviewCommentPayload,
  PullRequestReviewPayload,
  PullRequestReviewThreadPayload,
} from '@/lib/integrations/platforms/github/webhook-schemas';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  auto_fix_tickets,
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
  recordGitHubAutoFixFeedback,
} from './github-feedback';
import { upsertFeedbackSubject, type ReviewMemoryOwner } from './db';

describe('GitHub review memory feedback', () => {
  afterEach(async () => {
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(auto_fix_tickets);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  async function seedIntegration() {
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
      prUrl: 'https://github.com/acme/widgets/pull/42',
      bodyExcerpt: '**WARNING**: Avoid this pattern',
      state: 'active',
    });
  }

  it('records corrective and supportive replies to Kilo inline comments', async () => {
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

    await handleGitHubReviewCommentFeedback({
      payload: correctivePayload,
      integration,
      deliveryId: 'delivery-corrective-reply',
    });
    await handleGitHubReviewCommentFeedback({
      payload: supportivePayload,
      integration,
      deliveryId: 'delivery-supportive-reply',
    });

    const events = await db.select().from(code_review_feedback_events);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_id: subject.id,
          signal_kind: 'corrective_reply',
          sentiment: 'negative',
        }),
        expect.objectContaining({
          subject_id: subject.id,
          signal_kind: 'supportive_reply',
          sentiment: 'positive',
        }),
      ])
    );
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
      .where(eq(code_review_feedback_subjects.external_id, 'thread-1'));
    expect(threadSubject.state).toBe('resolved');
  });

  it('records Auto Fix completion and operational failure evidence', async () => {
    const { owner, integration } = await seedIntegration();
    await seedInlineSubject(owner, '800');
    const successTicketId = await createFixTicket({
      owner: { type: 'user', id: owner.id, userId: owner.id },
      platformIntegrationId: integration.id,
      repoFullName: 'acme/widgets',
      issueNumber: 42,
      issueUrl: 'https://github.com/acme/widgets/pull/42',
      issueTitle: 'Add widgets',
      issueBody: null,
      issueAuthor: 'author',
      issueLabels: [],
      triggerSource: 'review_comment',
      reviewCommentId: 800,
      reviewCommentBody: '@kilo fix this',
      filePath: 'src/widget.ts',
      lineNumber: 12,
      diffHunk: '@@ -1 +1 @@',
    });
    const failedTicketId = await createFixTicket({
      owner: { type: 'user', id: owner.id, userId: owner.id },
      platformIntegrationId: integration.id,
      repoFullName: 'acme/widgets',
      issueNumber: 43,
      issueUrl: 'https://github.com/acme/widgets/pull/43',
      issueTitle: 'Add more widgets',
      issueBody: null,
      issueAuthor: 'author',
      issueLabels: [],
      triggerSource: 'review_comment',
      reviewCommentId: 801,
      reviewCommentBody: '@kilo fix this',
      filePath: 'src/widget.ts',
      lineNumber: 14,
      diffHunk: '@@ -1 +1 @@',
    });
    const successTicket = await getFixTicketById(successTicketId);
    const failedTicket = await getFixTicketById(failedTicketId);
    if (!successTicket || !failedTicket) throw new Error('Failed to read seeded fix tickets');

    await recordGitHubAutoFixFeedback({ ticket: successTicket, outcome: 'success' });
    await recordGitHubAutoFixFeedback({
      ticket: failedTicket,
      outcome: 'failed',
      errorMessage: 'The auto-fix run timed out.',
    });

    const events = await db.select().from(code_review_feedback_events);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal_kind: 'autofix_completed', sentiment: 'positive' }),
        expect.objectContaining({ signal_kind: 'autofix_failed', sentiment: 'neutral' }),
      ])
    );
  });
});
