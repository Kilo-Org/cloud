import { describe, expect, it } from 'vitest';

import {
  CODE_REVIEW_ACTION_REQUIRED_REASONS,
  getCodeReviewActionRequiredCopy,
} from './action-required';

describe('getCodeReviewActionRequiredCopy', () => {
  it('returns a non-empty title, description, and recovery label for every reason', () => {
    for (const reason of CODE_REVIEW_ACTION_REQUIRED_REASONS) {
      const copy = getCodeReviewActionRequiredCopy(reason);
      expect(copy.title).toBeTruthy();
      expect(copy.description).toBeTruthy();
      expect(copy.recoveryLabel).toBeTruthy();
    }
  });

  it('maps each reason to its recovery label', () => {
    expect(getCodeReviewActionRequiredCopy('github_installation_required').recoveryLabel).toBe(
      'Update GitHub App'
    );
    expect(getCodeReviewActionRequiredCopy('github_ip_allow_list').recoveryLabel).toBe(
      'Contact support'
    );
    expect(getCodeReviewActionRequiredCopy('gitlab_project_access_required').recoveryLabel).toBe(
      'Update GitLab integration'
    );
    expect(getCodeReviewActionRequiredCopy('byok_invalid_key').recoveryLabel).toBe(
      'Update BYOK settings'
    );
    expect(getCodeReviewActionRequiredCopy('selected_model_unavailable').recoveryLabel).toBe(
      'Update Code Reviewer settings'
    );
    expect(getCodeReviewActionRequiredCopy('repeated_repository_clone_timeout').recoveryLabel).toBe(
      'Contact support'
    );
  });
});
