import { describe, expect, it } from 'vitest';

import {
  PROVIDER_REVIEW_CAPABILITIES,
  providerPrTerm,
  type ProviderReviewCapabilities,
} from './capabilities';

const PLATFORMS = ['github', 'gitlab', 'bitbucket'] as const;

function unsupported(capabilities: ProviderReviewCapabilities) {
  return [capabilities.autoMerge, capabilities.reactions, capabilities.reviewStatus].filter(
    capability => !capability.supported
  );
}

describe('PROVIDER_REVIEW_CAPABILITIES', () => {
  it('gives every unsupported capability a human-readable provider reason', () => {
    for (const platform of PLATFORMS) {
      const capabilities = PROVIDER_REVIEW_CAPABILITIES[platform];
      for (const capability of unsupported(capabilities)) {
        expect(capability.reason.length).toBeGreaterThan(0);
        expect(capability.reason[0]).toBe(capability.reason[0]?.toUpperCase());
      }
    }
    // The example from the requirement: Bitbucket Cloud auto-merge.
    expect(PROVIDER_REVIEW_CAPABILITIES.bitbucket.autoMerge.supported).toBe(false);
    expect(PROVIDER_REVIEW_CAPABILITIES.bitbucket.autoMerge.reason).toBe(
      'Bitbucket Cloud does not expose auto-merge in its API'
    );
    expect(PROVIDER_REVIEW_CAPABILITIES.bitbucket.reactions.supported).toBe(false);
    expect(PROVIDER_REVIEW_CAPABILITIES.bitbucket.reactions.reason.length).toBeGreaterThan(0);
  });

  it('keeps supported capabilities free of a reason string', () => {
    for (const platform of PLATFORMS) {
      const capabilities = PROVIDER_REVIEW_CAPABILITIES[platform];
      for (const capability of [
        capabilities.autoMerge,
        capabilities.reactions,
        capabilities.reviewStatus,
      ]) {
        if (capability.supported) expect(capability.reason).toBe('');
      }
    }
  });

  it('lists only the review events the contract allows', () => {
    for (const platform of PLATFORMS) {
      for (const event of PROVIDER_REVIEW_CAPABILITIES[platform].reviewEvents) {
        expect(['approve', 'request_changes', 'comment']).toContain(event);
      }
    }
  });
});

describe('providerPrTerm', () => {
  it('calls a GitLab review object a merge request and the others pull requests', () => {
    expect(providerPrTerm('gitlab')).toBe('merge request');
    expect(providerPrTerm('github')).toBe('pull request');
    expect(providerPrTerm('bitbucket')).toBe('pull request');
  });
});
