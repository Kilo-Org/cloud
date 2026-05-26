import { describe, expect, it } from '@jest/globals';
import {
  getGitLabStatusDescription,
  mapStatusToCheckRun,
  mapStatusToGitLabState,
} from './gate-sync';

describe('code review gate sync mappings', () => {
  it('maps completed gate failures to failing GitHub and GitLab gates', () => {
    expect(mapStatusToCheckRun('completed', undefined, undefined, 'fail')).toEqual(
      expect.objectContaining({
        status: 'completed',
        conclusion: 'failure',
        title: 'Kilo Code Review found issues',
      })
    );
    expect(mapStatusToGitLabState('completed', 'fail')).toBe('failed');
    expect(getGitLabStatusDescription('completed', undefined, undefined, 'fail')).toBe(
      'Kilo Code Review found issues that require attention'
    );
  });

  it('maps billing failures to action-required provider output', () => {
    expect(mapStatusToCheckRun('failed', 'Insufficient credits', 'billing')).toEqual(
      expect.objectContaining({
        status: 'completed',
        conclusion: 'action_required',
        title: 'Insufficient credits to run review',
        summary: 'Review could not start because the account has insufficient credits.',
      })
    );
    expect(getGitLabStatusDescription('failed', 'Insufficient credits', 'billing')).toBe(
      'Insufficient credits to run review'
    );
  });

  it('maps model-not-found cancellations to actionable platform copy', () => {
    expect(mapStatusToCheckRun('cancelled', 'Model not found: retired', 'model_not_found')).toEqual(
      expect.objectContaining({
        conclusion: 'cancelled',
        title: 'Selected model is no longer available',
        summary: expect.stringContaining('https://app.kilo.ai/code-reviews'),
      })
    );
    expect(
      getGitLabStatusDescription('cancelled', 'Model not found: retired', 'model_not_found')
    ).toContain('https://app.kilo.ai/code-reviews');
  });
});
