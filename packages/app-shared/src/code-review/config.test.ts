import { describe, expect, it } from 'vitest';

import { buildSaveConfigInput, type CodeReviewConfigInput } from './config';

// Moved from apps/mobile/src/lib/code-reviewer-config.test.ts — assertions
// kept identical, only the imported type name changed (ReviewConfigData ->
// CodeReviewConfigInput, this module's structural equivalent).
const config: CodeReviewConfigInput = {
  reviewStyle: 'balanced',
  focusAreas: ['bugs', 'security'],
  customInstructions: null,
  modelSlug: 'anthropic/claude-sonnet-5',
  thinkingEffort: null,
  gateThreshold: 'off',
  repositorySelectionMode: 'all',
  selectedRepositoryIds: [],
  repositoryModelOverrides: [],
  disableReviewMd: true,
};

describe('buildSaveConfigInput', () => {
  it('carries the full current config for an untouched field', () => {
    const input = buildSaveConfigInput('github', config, { reviewStyle: 'strict' });
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
      repositoryModelOverrides: [],
      disableReviewMd: true,
    });
  });

  it('preserves repository model overrides across an unrelated patch', () => {
    const overrides = [
      {
        repositoryId: 123,
        repoFullName: 'acme/api',
        modelSlug: 'anthropic/claude-opus-4.8',
        thinkingEffort: null,
      },
    ];
    const input = buildSaveConfigInput(
      'github',
      { ...config, repositoryModelOverrides: overrides },
      { reviewStyle: 'strict' }
    );
    expect(input.repositoryModelOverrides).toEqual(overrides);
  });

  it('applies patches over current values', () => {
    const input = buildSaveConfigInput('github', config, {
      focusAreas: ['performance'],
      customInstructions: 'be nice',
    });
    expect(input.focusAreas).toEqual(['performance']);
    expect(input.customInstructions).toBe('be nice');
    expect(input.reviewStyle).toBe('balanced');
  });

  it('includes autoConfigureWebhooks for gitlab', () => {
    const input = buildSaveConfigInput('gitlab', config, {});
    expect(input.platform).toBe('gitlab');
    expect(input.autoConfigureWebhooks).toBe(true);
  });

  it('carries string repository ids for bitbucket', () => {
    const input = buildSaveConfigInput('bitbucket', config, {
      selectedRepositoryIds: ['uuid-1'],
    });
    expect(input.platform).toBe('bitbucket');
    expect(input.selectedRepositoryIds).toEqual(['uuid-1']);
  });

  it('forces selected repository mode for gitlab even when config default is all', () => {
    const input = buildSaveConfigInput('gitlab', config, {});
    expect(input.repositorySelectionMode).toBe('selected');
  });

  it('forces selected repository mode for bitbucket even when config default is all', () => {
    const input = buildSaveConfigInput('bitbucket', config, {});
    expect(input.repositorySelectionMode).toBe('selected');
  });
});
