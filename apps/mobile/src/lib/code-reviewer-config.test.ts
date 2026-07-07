import { describe, expect, it } from 'vitest';

import { buildSaveConfigInput, type ReviewConfigData } from '@/lib/code-reviewer-config';

const config: ReviewConfigData = {
  isEnabled: true,
  reviewStyle: 'balanced',
  focusAreas: ['bugs', 'security'],
  customInstructions: null,
  modelSlug: 'anthropic/claude-sonnet-5',
  thinkingEffort: null,
  gateThreshold: 'off',
  repositorySelectionMode: 'all',
  selectedRepositoryIds: [],
  disableReviewMd: true,
};

describe('buildSaveConfigInput', () => {
  it('carries the full current config for an untouched field', () => {
    const input = buildSaveConfigInput(config, { reviewStyle: 'strict' });
    expect(input).toEqual({
      platform: 'github',
      reviewStyle: 'strict',
      focusAreas: ['bugs', 'security'],
      customInstructions: undefined,
      modelSlug: 'anthropic/claude-sonnet-5',
      thinkingEffort: null,
      gateThreshold: 'off',
      repositorySelectionMode: 'all',
      selectedRepositoryIds: [],
      disableReviewMd: true,
    });
  });

  it('applies patches over current values', () => {
    const input = buildSaveConfigInput(config, {
      focusAreas: ['performance'],
      customInstructions: 'be nice',
    });
    expect(input.focusAreas).toEqual(['performance']);
    expect(input.customInstructions).toBe('be nice');
    expect(input.reviewStyle).toBe('balanced');
  });
});
