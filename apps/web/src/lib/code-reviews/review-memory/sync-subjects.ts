import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  fetchPRInlineComments,
  findKiloReviewComment,
} from '@/lib/integrations/platforms/github/adapter';
import {
  fetchMRInlineComments,
  findKiloReviewNote,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { logExceptInTest } from '@/lib/utils.server';
import {
  createReviewMemoryDedupeHash,
  type ReviewMemoryDatabase,
  type ReviewMemoryOwner,
  upsertFeedbackSubject,
} from './db';
import { isReviewMemoryEnabled } from './settings';

type ReviewSubjectSyncReview = Pick<
  CloudAgentCodeReview,
  | 'id'
  | 'owned_by_organization_id'
  | 'owned_by_user_id'
  | 'repo_full_name'
  | 'platform_project_id'
  | 'pr_number'
>;

export type FetchedReviewSummarySubject = {
  externalId: string;
  body: string;
};

export type FetchedInlineReviewSubject = {
  externalId: string;
  externalThreadId?: string | null;
  filePath?: string | null;
  body: string;
  isOutdated?: boolean;
};

export type SyncFetchedReviewMemorySubjectsInput = {
  review: ReviewSubjectSyncReview;
  platform: 'github' | 'gitlab';
  summary?: FetchedReviewSummarySubject | null;
  inlineComments: FetchedInlineReviewSubject[];
  database?: ReviewMemoryDatabase;
};

export type SyncReviewMemorySubjectsResult = {
  summarySynced: boolean;
  inlineSynced: number;
};

const KILO_REVIEW_MARKER = '<!-- kilo-review -->';

function ownerFromReview(review: ReviewSubjectSyncReview): ReviewMemoryOwner | null {
  if (review.owned_by_organization_id) {
    return { type: 'org', id: review.owned_by_organization_id };
  }
  if (review.owned_by_user_id) {
    return { type: 'user', id: review.owned_by_user_id };
  }
  return null;
}

function normalizeFingerprintText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, '`code`')
    .replace(/[a-f0-9]{7,40}/g, '<sha>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseReviewFindingMetadata(body: string): {
  severity: string | null;
  findingTitle: string | null;
  findingFingerprint: string | null;
} {
  const firstMeaningfulLine = body
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!firstMeaningfulLine) {
    return { severity: null, findingTitle: null, findingFingerprint: null };
  }

  const severityMatch = firstMeaningfulLine.match(
    /^\*\*(CRITICAL|WARNING|SUGGESTION|NITPICK|ERROR|INFO)\s*:?\*\*:?\s*(.*)$/i
  );
  const fallbackSeverityMatch = firstMeaningfulLine.match(
    /^(CRITICAL|WARNING|SUGGESTION|NITPICK|ERROR|INFO):\s*(.*)$/i
  );
  const matchedSeverity = severityMatch?.[1] ?? fallbackSeverityMatch?.[1] ?? null;
  const remainingTitle = severityMatch?.[2] ?? fallbackSeverityMatch?.[2] ?? firstMeaningfulLine;
  const findingTitle = remainingTitle.replace(/^[-:]+\s*/, '').trim() || firstMeaningfulLine;
  const fingerprint = createReviewMemoryDedupeHash([
    matchedSeverity?.toLowerCase() ?? 'unknown',
    normalizeFingerprintText(findingTitle),
  ]);

  return {
    severity: matchedSeverity?.toLowerCase() ?? null,
    findingTitle,
    findingFingerprint: fingerprint,
  };
}

export function isLikelyKiloInlineReviewBody(body: string): boolean {
  if (body.includes(KILO_REVIEW_MARKER)) return true;
  const { severity } = parseReviewFindingMetadata(body);
  if (severity) return true;
  return /```suggestion/.test(body) && /\b(CRITICAL|WARNING|SUGGESTION|NITPICK)\b/i.test(body);
}

export async function syncFetchedReviewMemorySubjects(
  input: SyncFetchedReviewMemorySubjectsInput
): Promise<SyncReviewMemorySubjectsResult> {
  const owner = ownerFromReview(input.review);
  if (!owner) return { summarySynced: false, inlineSynced: 0 };
  if (!(await isReviewMemoryEnabled({ owner, platform: input.platform }))) {
    return { summarySynced: false, inlineSynced: 0 };
  }

  let summarySynced = false;
  if (input.summary?.body.includes(KILO_REVIEW_MARKER)) {
    await upsertFeedbackSubject({
      owner,
      platform: input.platform,
      subjectType: 'summary_comment',
      externalId: input.summary.externalId,
      repoFullName: input.review.repo_full_name,
      platformProjectId: input.review.platform_project_id,
      prNumber: input.review.pr_number,
      state: 'active',
      database: input.database,
    });
    summarySynced = true;
  }

  let inlineSynced = 0;
  for (const comment of input.inlineComments) {
    if (!isLikelyKiloInlineReviewBody(comment.body)) continue;
    const metadata = parseReviewFindingMetadata(comment.body);
    await upsertFeedbackSubject({
      owner,
      platform: input.platform,
      subjectType: input.platform === 'gitlab' ? 'discussion' : 'inline_comment',
      externalId: comment.externalId,
      externalThreadId: comment.externalThreadId ?? null,
      repoFullName: input.review.repo_full_name,
      platformProjectId: input.review.platform_project_id,
      prNumber: input.review.pr_number,
      filePath: comment.filePath ?? null,
      findingTitle: metadata.findingTitle,
      findingFingerprint: metadata.findingFingerprint,
      state: comment.isOutdated ? 'outdated' : 'active',
      database: input.database,
    });
    inlineSynced += 1;
  }

  return { summarySynced, inlineSynced };
}

export async function syncGitHubReviewMemorySubjects(input: {
  review: ReviewSubjectSyncReview;
  installationId: string;
  appType: GitHubAppType;
  database?: ReviewMemoryDatabase;
}): Promise<SyncReviewMemorySubjectsResult> {
  const [repoOwner, repoName] = input.review.repo_full_name.split('/');
  if (!repoOwner || !repoName) {
    return { summarySynced: false, inlineSynced: 0 };
  }

  const [summaryComment, inlineComments] = await Promise.all([
    findKiloReviewComment(
      input.installationId,
      repoOwner,
      repoName,
      input.review.pr_number,
      input.appType
    ),
    fetchPRInlineComments(
      input.installationId,
      repoOwner,
      repoName,
      input.review.pr_number,
      input.appType
    ),
  ]);

  const result = await syncFetchedReviewMemorySubjects({
    review: input.review,
    platform: 'github',
    summary: summaryComment
      ? {
          externalId: String(summaryComment.commentId),
          body: summaryComment.body,
        }
      : null,
    inlineComments: inlineComments.map(comment => ({
      externalId: String(comment.id),
      filePath: comment.path,
      body: comment.body,
      isOutdated: comment.isOutdated,
    })),
    database: input.database,
  });

  logExceptInTest('[review-memory] Synced GitHub review subjects', {
    reviewId: input.review.id,
    repoFullName: input.review.repo_full_name,
    prNumber: input.review.pr_number,
    result,
  });

  return result;
}

export async function syncGitLabReviewMemorySubjects(input: {
  review: ReviewSubjectSyncReview;
  accessToken: string;
  instanceUrl: string;
  database?: ReviewMemoryDatabase;
}): Promise<SyncReviewMemorySubjectsResult> {
  const [summaryNote, inlineComments] = await Promise.all([
    findKiloReviewNote(
      input.accessToken,
      input.review.repo_full_name,
      input.review.pr_number,
      input.instanceUrl
    ),
    fetchMRInlineComments(
      input.accessToken,
      input.review.repo_full_name,
      input.review.pr_number,
      input.instanceUrl
    ),
  ]);

  const result = await syncFetchedReviewMemorySubjects({
    review: input.review,
    platform: 'gitlab',
    summary: summaryNote
      ? {
          externalId: String(summaryNote.noteId),
          body: summaryNote.body,
        }
      : null,
    inlineComments: inlineComments.map(comment => ({
      externalId: String(comment.id),
      externalThreadId: comment.discussionId,
      filePath: comment.path,
      body: comment.body,
      isOutdated: comment.isOutdated,
    })),
    database: input.database,
  });

  logExceptInTest('[review-memory] Synced GitLab review subjects', {
    reviewId: input.review.id,
    repoFullName: input.review.repo_full_name,
    prNumber: input.review.pr_number,
    result,
  });

  return result;
}
