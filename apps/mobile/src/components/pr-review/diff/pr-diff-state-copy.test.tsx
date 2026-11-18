// The file list's terminal/empty copy switches on the provider: GitLab says
// "merge request", GitHub and Bitbucket say "pull request", and only GitHub
// can blame the missing Kilo GitHub App — Bitbucket Cloud has no such App.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ProviderPrRefModule from '@/lib/pr-review/provider-pr-ref';
import { usePrDiffStateCopy } from './pr-diff-state-copy';

const scopeState = vi.hoisted(() => ({ platform: 'github' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/pr-review/provider-pr-ref', async importOriginal => {
  const actual = await importOriginal<typeof ProviderPrRefModule>();
  return {
    ...actual,
    useProviderPrScope: () => ({ ref: { platform: scopeState.platform }, organizationId: null }),
  };
});

function copyFor(platform: string): ReturnType<typeof usePrDiffStateCopy> {
  scopeState.platform = platform;
  const captured: { current: ReturnType<typeof usePrDiffStateCopy> | null } = { current: null };
  function Probe() {
    captured.current = usePrDiffStateCopy({ owner: 'octocat', repo: 'hello', number: 7 });
    return null;
  }
  act(() => {
    TestRenderer.create(createElement(Probe));
  });
  if (!captured.current) {
    throw new Error('copy was not captured');
  }
  return captured.current;
}

describe('usePrDiffStateCopy', () => {
  it('names the missing Kilo GitHub App for GitHub alone', () => {
    expect(copyFor('github').unavailableMessage).toBe('prReview.pullRequestUnavailableDescription');
    // GitLab and Bitbucket share the neutral provider description.
    expect(copyFor('gitlab').unavailableMessage).toBe('prReview.terms.unavailableDescription');
    expect(copyFor('bitbucket').unavailableMessage).toBe('prReview.terms.unavailableDescription');
  });

  it('keeps each provider noun: pull request for Bitbucket, merge request for GitLab', () => {
    expect(copyFor('bitbucket').unavailableTitle).toBe('prReview.pullRequestUnavailable');
    expect(copyFor('gitlab').unavailableTitle).toBe('prReview.terms.mergeRequestUnavailable');
  });
});
