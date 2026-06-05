/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import type {
  EmojiEventPayload,
  MergeRequestPayload,
  NoteEventPayload,
} from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_state,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  handleGitLabEmojiFeedback,
  handleGitLabMergeRequestFeedback,
  handleGitLabNoteFeedback,
} from './gitlab-feedback';
import { upsertFeedbackSubject, type ReviewMemoryOwner } from './db';

describe('GitLab review memory feedback', () => {
  afterEach(async () => {
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  async function seedIntegration() {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_installation_id: `gitlab-review-memory-${Date.now()}-${Math.random()}`,
        metadata: {
          gitlab_instance_url: 'https://gitlab.example.com',
          webhook_secret: 'secret',
        },
      })
      .returning();

    if (!integration) throw new Error('Failed to seed platform integration');
    return { user, owner: { type: 'user' as const, id: user.id }, integration };
  }

  function user() {
    return { id: 7, name: 'Maintainer', username: 'maintainer' };
  }

  function project() {
    return {
      id: 123,
      name: 'widgets',
      web_url: 'https://gitlab.example.com/acme/widgets',
      namespace: 'acme',
      path_with_namespace: 'acme/widgets',
      default_branch: 'main',
    };
  }

  function mergeRequestAttributes(
    overrides: Partial<MergeRequestPayload['object_attributes']> = {}
  ): MergeRequestPayload['object_attributes'] {
    return {
      id: 900,
      iid: 42,
      title: 'Add widgets',
      state: 'opened',
      action: 'update',
      source_branch: 'feature/widgets',
      target_branch: 'main',
      source_project_id: 123,
      target_project_id: 123,
      author_id: 7,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42',
      last_commit: {
        id: 'abc123',
        message: 'Add widgets',
      },
      ...overrides,
    };
  }

  async function seedDiscussionSubject(owner: ReviewMemoryOwner) {
    return await upsertFeedbackSubject({
      owner,
      platform: 'gitlab',
      repoFullName: 'acme/widgets',
      platformProjectId: 123,
      subjectType: 'discussion',
      externalId: '500',
      externalThreadId: 'discussion-1',
      externalUrl: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42#note_500',
      prNumber: 42,
      prUrl: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42',
      bodyExcerpt: '**WARNING**: Avoid this pattern',
      state: 'active',
    });
  }

  it('records corrective notes in Kilo discussions', async () => {
    const { owner, integration } = await seedIntegration();
    const subject = await seedDiscussionSubject(owner);
    const payload = {
      object_kind: 'note',
      event_type: 'note',
      user: user(),
      project_id: 123,
      project: project(),
      object_attributes: {
        id: 501,
        note: 'This is a false positive for this MR.',
        action: 'create',
        discussion_id: 'discussion-1',
        noteable_type: 'MergeRequest',
        author_id: 7,
        created_at: '2026-01-01T00:02:00.000Z',
        updated_at: '2026-01-01T00:02:00.000Z',
        project_id: 123,
        system: false,
        url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42#note_501',
      },
      merge_request: mergeRequestAttributes(),
    } satisfies NoteEventPayload;

    const result = await handleGitLabNoteFeedback({
      payload,
      integration,
      deliveryId: 'delivery-note-corrective',
    });

    expect(result.recorded).toBe(true);
    const [event] = await db.select().from(code_review_feedback_events);
    expect(event).toEqual(
      expect.objectContaining({
        subject_id: subject.id,
        signal_kind: 'corrective_reply',
        sentiment: 'negative',
        strength: 3,
      })
    );
  });

  it('records notes from maintainers with kilo in their username', async () => {
    const { owner, integration } = await seedIntegration();
    await seedDiscussionSubject(owner);
    const payload = {
      object_kind: 'note',
      event_type: 'note',
      user: { id: 8, name: 'Kilo Developer', username: 'kilodev' },
      project_id: 123,
      project: project(),
      object_attributes: {
        id: 502,
        note: 'This is a false positive for this MR.',
        action: 'create',
        discussion_id: 'discussion-1',
        noteable_type: 'MergeRequest',
        author_id: 8,
        created_at: '2026-01-01T00:02:00.000Z',
        updated_at: '2026-01-01T00:02:00.000Z',
        project_id: 123,
        system: false,
        url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42#note_502',
      },
      merge_request: mergeRequestAttributes(),
    } satisfies NoteEventPayload;

    const result = await handleGitLabNoteFeedback({
      payload,
      integration,
      deliveryId: 'delivery-note-kilodev',
    });

    expect(result.recorded).toBe(true);
  });

  it('records emoji reactions on Kilo notes', async () => {
    const { integration } = await seedIntegration();
    const payload = {
      object_kind: 'emoji',
      event_type: 'emoji',
      user: user(),
      project_id: 123,
      project: project(),
      object_attributes: {
        id: 777,
        name: 'thumbsdown',
        action: 'award',
        awardable_type: 'Note',
        awardable_id: 500,
        created_at: '2026-01-01T00:02:00.000Z',
      },
      merge_request: mergeRequestAttributes(),
      note: {
        id: 500,
        note: '**WARNING**: Avoid this pattern',
        url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42#note_500',
        noteable_type: 'MergeRequest',
        position: {
          new_path: 'src/widget.ts',
          new_line: 12,
        },
      },
    } satisfies EmojiEventPayload;

    const result = await handleGitLabEmojiFeedback({
      payload,
      integration,
      deliveryId: 'delivery-emoji-negative',
    });

    expect(result.recorded).toBe(true);
    const [event] = await db.select().from(code_review_feedback_events);
    expect(event).toEqual(
      expect.objectContaining({
        signal_kind: 'negative_reaction',
        sentiment: 'negative',
        strength: 3,
      })
    );

    const [subject] = await db.select().from(code_review_feedback_subjects);
    expect(subject.external_id).toBe('500');
    expect(subject.severity).toBe('warning');
  });

  it('records MR-level approval evidence and discussion resolution', async () => {
    const { owner, integration } = await seedIntegration();
    const subject = await seedDiscussionSubject(owner);
    const payload = {
      object_kind: 'merge_request',
      event_type: 'merge_request',
      user: user(),
      project: project(),
      object_attributes: mergeRequestAttributes({ action: 'approved' }),
      changes: {
        blocking_discussions_resolved: {
          previous: false,
          current: true,
        },
      },
    } satisfies MergeRequestPayload;

    const result = await handleGitLabMergeRequestFeedback({
      payload,
      integration,
      deliveryId: 'delivery-mr-approval-resolution',
    });

    expect(result.recorded).toBe(true);
    const events = await db.select().from(code_review_feedback_events);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal_kind: 'mr_approved', sentiment: 'positive', strength: 1 }),
        expect.objectContaining({
          subject_id: subject.id,
          signal_kind: 'thread_resolved',
          sentiment: 'positive',
          strength: 2,
        }),
      ])
    );

    const [updatedSubject] = await db
      .select()
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.id, subject.id));
    expect(updatedSubject.state).toBe('resolved');

    const [state] = await db.select().from(code_review_memory_aggregation_state);
    expect(state.fresh_event_count).toBe(2);
  });
});
