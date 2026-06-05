/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { createCodeReview, getCodeReviewById } from '@/lib/code-reviews/db/code-reviews';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  agent_configs,
  cloud_agent_code_reviews,
  code_review_feedback_subjects,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { parseReviewFindingMetadata, syncFetchedReviewMemorySubjects } from './sync-subjects';

describe('review memory subject sync', () => {
  afterEach(async () => {
    await db.delete(code_review_feedback_subjects);
    await db.delete(cloud_agent_code_reviews);
    await db.delete(agent_configs);
    await db.delete(kilocode_users);
  });

  async function enableReviewMemory(userId: string, platform: 'github' | 'gitlab') {
    await db.insert(agent_configs).values({
      owned_by_user_id: userId,
      agent_type: 'code_review',
      platform,
      config: { review_memory_enabled: true },
      is_enabled: false,
      created_by: userId,
    });
  }

  it('syncs GitHub summary and likely Kilo inline subjects', async () => {
    const user = await insertTestUser();
    await enableReviewMemory(user.id, 'github');
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: user.id, userId: user.id },
      repoFullName: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prTitle: 'Review memory',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/review-memory',
      headSha: 'abc1234',
      platform: 'github',
    });
    const review = await getCodeReviewById(reviewId);
    if (!review) throw new Error('Expected review to be created');

    const result = await syncFetchedReviewMemorySubjects({
      review,
      platform: 'github',
      summary: {
        externalId: '1001',
        body: '<!-- kilo-review -->\n## Code Review Summary\n\n**Status:** 1 Issues Found',
      },
      inlineComments: [
        {
          externalId: '2001',
          filePath: 'src/example.ts',
          body: '**WARNING:** Missing error handling for failed requests.',
          isOutdated: false,
        },
        {
          externalId: 'human-comment',
          body: 'Can we rename this variable?',
          isOutdated: false,
        },
        {
          externalId: '2002',
          filePath: 'src/other.ts',
          body: '**CRITICAL:** Null pointer when the payload is empty.',
          isOutdated: true,
        },
      ],
    });

    expect(result).toEqual({ summarySynced: true, inlineSynced: 2 });

    const subjects = await db
      .select()
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.repo_full_name, 'owner/repo'));
    expect(subjects).toHaveLength(3);
    expect(subjects.find(subject => subject.subject_type === 'summary_comment')).toEqual(
      expect.objectContaining({ subject_type: 'summary_comment', state: 'active' })
    );
    expect(subjects.find(subject => subject.file_path === 'src/example.ts')).toEqual(
      expect.objectContaining({
        subject_type: 'inline_comment',
        file_path: 'src/example.ts',
        finding_title: 'Missing error handling for failed requests.',
        state: 'active',
      })
    );
    expect(subjects.find(subject => subject.file_path === 'src/other.ts')).toEqual(
      expect.objectContaining({
        finding_title: 'Null pointer when the payload is empty.',
        state: 'outdated',
      })
    );
    expect(subjects.map(subject => subject.external_id_hash)).not.toContain('human-comment');
  });

  it('updates existing GitLab discussion subjects when resolved state changes', async () => {
    const user = await insertTestUser();
    await enableReviewMemory(user.id, 'gitlab');
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: user.id, userId: user.id },
      repoFullName: 'group/project',
      prNumber: 7,
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      prTitle: 'Review memory',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/review-memory',
      headSha: 'def5678',
      platform: 'gitlab',
      platformProjectId: 123,
    });
    const review = await getCodeReviewById(reviewId);
    if (!review) throw new Error('Expected review to be created');

    await syncFetchedReviewMemorySubjects({
      review,
      platform: 'gitlab',
      summary: null,
      inlineComments: [
        {
          externalId: '3001',
          externalThreadId: 'discussion-1',
          filePath: 'src/gitlab.ts',
          body: '**SUGGESTION:** Prefer a narrower guard here.',
          isOutdated: false,
        },
      ],
    });
    await syncFetchedReviewMemorySubjects({
      review,
      platform: 'gitlab',
      summary: null,
      inlineComments: [
        {
          externalId: '3001',
          externalThreadId: 'discussion-1',
          filePath: 'src/gitlab.ts',
          body: '**SUGGESTION:** Prefer a narrower validation guard here.',
          isOutdated: true,
        },
      ],
    });

    const subjects = await db.select().from(code_review_feedback_subjects);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toEqual(
      expect.objectContaining({
        subject_type: 'discussion',
        external_thread_id_hash: expect.any(String),
        finding_title: 'Prefer a narrower validation guard here.',
        state: 'outdated',
      })
    );
  });

  it('does not sync subjects when review memory is disabled', async () => {
    const user = await insertTestUser();
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: user.id, userId: user.id },
      repoFullName: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prTitle: 'Review memory',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/review-memory',
      headSha: 'abc1234',
      platform: 'github',
    });
    const review = await getCodeReviewById(reviewId);
    if (!review) throw new Error('Expected review to be created');

    const result = await syncFetchedReviewMemorySubjects({
      review,
      platform: 'github',
      summary: {
        externalId: '1001',
        body: '<!-- kilo-review -->\n## Code Review Summary\n\n**Status:** 1 Issues Found',
      },
      inlineComments: [
        {
          externalId: '2001',
          body: '**WARNING:** Missing error handling for failed requests.',
        },
      ],
    });

    expect(result).toEqual({ summarySynced: false, inlineSynced: 0 });
    await expect(db.select().from(code_review_feedback_subjects)).resolves.toHaveLength(0);
  });

  it('parses severity, title, and stable fingerprints from review comment bodies', () => {
    const first = parseReviewFindingMetadata(
      '**WARNING:** Missing guard in `src/file.ts` at line 42 for commit abc1234'
    );
    const second = parseReviewFindingMetadata(
      '**WARNING:** Missing guard in `src/other.ts` at line 98 for commit def5678'
    );

    expect(first.severity).toBe('warning');
    expect(first.findingTitle).toContain('Missing guard');
    expect(first.findingFingerprint).toBe(second.findingFingerprint);
  });
});
