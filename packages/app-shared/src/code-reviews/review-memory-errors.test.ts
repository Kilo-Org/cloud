import { describe, expect, it } from 'vitest';

import {
  REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY,
  type ReviewMemoryChangeRequestErrorReason,
} from './review-memory-errors';

describe('review memory change request error copy', () => {
  // The app matches these sentences whole, so two reasons that share one
  // sentence can never be shown with different copy.
  it('gives every reason a distinct sentence', () => {
    const sentences = Object.values(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('keeps every sentence a complete user-facing line', () => {
    for (const sentence of Object.values(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY)) {
      expect(sentence.endsWith('.')).toBe(true);
      expect(sentence).toBe(sentence.trim());
      expect(sentence).not.toContain('  ');
    }
  });

  it('names the reasons the router and the change request throw', () => {
    const reasons: ReviewMemoryChangeRequestErrorReason[] = [
      'proposal_not_found',
      'change_request_in_progress',
      'proposal_not_actionable',
      'no_github_integration',
      'missing_github_app_permissions',
      'change_request_failed',
      'review_memory_disabled',
    ];
    expect(Object.keys(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY).sort()).toEqual(reasons.sort());
  });
});
