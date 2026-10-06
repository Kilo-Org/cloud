import { CodeReviewPublicationStatus } from '@kilocode/db/schema-types';
import {
  CODE_REVIEW_PUBLICATION_MISSING_SENTENCE,
  CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE,
  recordCodeReviewPublicationOutcome,
} from './record-publication-outcome';

const mockGetStatus = jest.fn();
const mockClaim = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockFindKiloReviewComment = jest.fn();

jest.mock('../db/code-reviews', () => ({
  getCodeReviewAttemptPublicationStatus: (...args: unknown[]) => mockGetStatus(...args),
  claimCodeReviewAttemptPublicationOutcome: (...args: unknown[]) => mockClaim(...args),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: (...args: unknown[]) => mockGetIntegrationById(...args),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  findKiloReviewComment: (...args: unknown[]) => mockFindKiloReviewComment(...args),
}));

const BASE = {
  attemptId: 'attempt-1',
  reviewId: 'review-1',
  platform: 'github',
  platformIntegrationId: 'integration-1',
  repoFullName: 'acme/widgets',
  prNumber: 42,
  previousSummaryBody: null,
  previousSummaryObserved: true,
  shouldPublish: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStatus.mockResolvedValue(null);
  mockClaim.mockResolvedValue('recorded');
  mockGetIntegrationById.mockResolvedValue({
    platform_installation_id: '123',
    github_app_type: 'standard',
  });
  mockFindKiloReviewComment.mockResolvedValue(null);
});

describe('recordCodeReviewPublicationOutcome', () => {
  it('records published with no sentence for an owned summary', async () => {
    mockFindKiloReviewComment.mockResolvedValue({
      commentId: 5,
      body: '<!-- kilo-review -->\n## Code Review Summary\nLooks good.',
    });

    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('recorded');
    expect(mockClaim).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      reviewId: 'review-1',
      status: CodeReviewPublicationStatus.Published,
      sentence: null,
    });
  });

  it('records missing with the missing sentence when no owned summary exists', async () => {
    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('recorded');
    expect(mockClaim).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      reviewId: 'review-1',
      status: CodeReviewPublicationStatus.Missing,
      sentence: CODE_REVIEW_PUBLICATION_MISSING_SENTENCE,
    });
  });

  it('records unknown with the unverifiable sentence when the lookup throws', async () => {
    mockFindKiloReviewComment.mockRejectedValue(new Error('github down'));

    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('recorded');
    expect(mockClaim).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      reviewId: 'review-1',
      status: CodeReviewPublicationStatus.Unknown,
      sentence: CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE,
    });
  });

  it('records unknown when the owned-comment lookup times out', async () => {
    jest.useFakeTimers();
    try {
      mockFindKiloReviewComment.mockReturnValue(new Promise(() => {}));
      const pending = recordCodeReviewPublicationOutcome(BASE);
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBe('recorded');
      expect(mockClaim).toHaveBeenCalledWith({
        attemptId: 'attempt-1',
        reviewId: 'review-1',
        status: CodeReviewPublicationStatus.Unknown,
        sentence: CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('records unknown when the integration is missing', async () => {
    mockGetIntegrationById.mockResolvedValue(null);

    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('recorded');
    expect(mockClaim).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      reviewId: 'review-1',
      status: CodeReviewPublicationStatus.Unknown,
      sentence: CODE_REVIEW_PUBLICATION_UNKNOWN_SENTENCE,
    });
  });

  it('records not_applicable for a non-provider review without a lookup', async () => {
    await expect(
      recordCodeReviewPublicationOutcome({ ...BASE, shouldPublish: false })
    ).resolves.toBe('recorded');
    expect(mockClaim).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      reviewId: 'review-1',
      status: CodeReviewPublicationStatus.NotApplicable,
      sentence: null,
    });
    expect(mockFindKiloReviewComment).not.toHaveBeenCalled();
  });

  it('returns already_recorded without a lookup when a status is stored', async () => {
    mockGetStatus.mockResolvedValue(CodeReviewPublicationStatus.Published);

    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('already_recorded');
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockFindKiloReviewComment).not.toHaveBeenCalled();
  });

  it('returns write_failed when the initial status read throws', async () => {
    mockGetStatus.mockRejectedValue(new Error('db down'));

    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('write_failed');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('returns write_failed when the claim fails', async () => {
    mockClaim.mockResolvedValue('write_failed');

    await expect(recordCodeReviewPublicationOutcome(BASE)).resolves.toBe('write_failed');
  });
});
