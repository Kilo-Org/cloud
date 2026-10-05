import { CodeReviewPublicationStatus } from '@kilocode/db/schema-types';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { findKiloReviewComment } from '@/lib/integrations/platforms/github/adapter';
import {
  claimCodeReviewAttemptPublicationOutcome,
  getCodeReviewAttemptPublicationStatus,
  type RecordPublicationOutcomeResult,
} from '../db/code-reviews';
import { classifyCodeReviewPublication } from './publication-status';

const PUBLICATION_LOOKUP_TIMEOUT_MS = 10_000;

export const CODE_REVIEW_PUBLICATION_MISSING_SENTENCE =
  'The review finished, but the summary was not published to GitHub.';
export const CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE =
  'The review finished, but GitHub publication could not be verified.';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('publication lookup timed out')), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Records the GitHub publication outcome for a completed review without
 * touching status, terminal reason, gate, council, analytics, or reactions.
 *
 * The attempt publication status and the review's sentence commit together, the
 * sentence is written only into a null review `error_message`, and a
 * compare-and-set that matched no row is distinguished from a failed write.
 * Every completion delivery that reaches an already-stored outcome still runs so
 * the row can be repaired. A read or write failure is `write_failed`, never a
 * thrown error: the caller must still run its completion effects before any 500.
 */
export async function recordCodeReviewPublicationOutcome(params: {
  attemptId: string;
  reviewId: string;
  platform: string;
  platformIntegrationId: string | null;
  repoFullName: string;
  prNumber: number;
  previousSummaryBody: string | null;
  previousSummaryObserved: boolean | null;
  shouldPublish: boolean;
}): Promise<RecordPublicationOutcomeResult> {
  try {
    const stored = await getCodeReviewAttemptPublicationStatus(params.attemptId);
    if (stored !== null) return 'already_recorded';
  } catch {
    return 'write_failed';
  }

  const claim = (status: CodeReviewPublicationStatus, sentence: string | null) =>
    claimCodeReviewAttemptPublicationOutcome({
      attemptId: params.attemptId,
      reviewId: params.reviewId,
      status,
      sentence,
    });

  if (!params.shouldPublish || params.platform !== 'github') {
    return claim(CodeReviewPublicationStatus.NotApplicable, null);
  }

  try {
    if (!params.platformIntegrationId) {
      return claim(CodeReviewPublicationStatus.Unknown, CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE);
    }
    const integration = await getIntegrationById(params.platformIntegrationId);
    const installationId = integration?.platform_installation_id;
    if (!installationId) {
      return claim(CodeReviewPublicationStatus.Unknown, CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE);
    }
    const [owner, repo] = params.repoFullName.split('/');
    const summary = await withTimeout(
      findKiloReviewComment(
        installationId,
        owner,
        repo,
        params.prNumber,
        integration.github_app_type ?? 'standard'
      ),
      PUBLICATION_LOOKUP_TIMEOUT_MS
    );
    const status = classifyCodeReviewPublication({
      kind: 'summary',
      summaryBody: summary?.body ?? null,
      previousSummaryBody: params.previousSummaryBody,
      previousSummaryObserved: params.previousSummaryObserved,
    });
    const sentence =
      status === CodeReviewPublicationStatus.Missing
        ? CODE_REVIEW_PUBLICATION_MISSING_SENTENCE
        : status === CodeReviewPublicationStatus.Unknown
          ? CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE
          : null;
    return claim(status, sentence);
  } catch {
    return claim(CodeReviewPublicationStatus.Unknown, CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE);
  }
}
