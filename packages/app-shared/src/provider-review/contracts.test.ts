import { describe, expect, it } from 'vitest';

import {
  gitlabInstanceOrigin,
  providerPrRefKey,
  type ProviderPrInboxItem,
  type ProviderPrRef,
} from './contracts';

const GITHUB: ProviderPrRef = { platform: 'github', owner: 'acme', repo: 'api', number: 7 };
const GITLAB: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'acme/api',
  mrIid: 7,
  instanceHint: 'gitlab.com',
};
const BITBUCKET: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'api',
  prId: 7,
};

describe('providerPrRefKey', () => {
  it('is deterministic and canonical for the same ref', () => {
    expect(providerPrRefKey(GITHUB)).toBe(providerPrRefKey({ ...GITHUB }));
    expect(providerPrRefKey(GITLAB)).toBe(providerPrRefKey({ ...GITLAB }));
    expect(providerPrRefKey(BITBUCKET)).toBe(providerPrRefKey({ ...BITBUCKET }));
  });

  // The same repo name on three providers is exactly the collision the key
  // must prevent: identity is carried everywhere.
  it('never collides across providers for same-named repositories', () => {
    expect(
      new Set([providerPrRefKey(GITHUB), providerPrRefKey(GITLAB), providerPrRefKey(BITBUCKET)])
        .size
    ).toBe(3);
  });

  it('never collides across GitLab instances or against a missing hint', () => {
    const saas = providerPrRefKey(GITLAB);
    const selfHosted = providerPrRefKey({ ...GITLAB, instanceHint: 'gitlab.example.com' });
    const noHint = providerPrRefKey({ platform: 'gitlab', projectPath: 'acme/api', mrIid: 7 });
    expect(new Set([saas, selfHosted, noHint]).size).toBe(3);
    // A missing hint is its own bucket, never equal to the SaaS host.
    expect(noHint).not.toBe(saas);
  });

  it('folds a GitLab instanceHint URL to its origin', () => {
    const selfHosted = providerPrRefKey({ ...GITLAB, instanceHint: 'gitlab.example.com' });
    expect(
      providerPrRefKey({ ...GITLAB, instanceHint: 'https://GitLab.example.com/acme/api' })
    ).toBe(selfHosted);
    // A different port is a different instance.
    expect(providerPrRefKey({ ...GITLAB, instanceHint: 'gitlab.example.com:8443' })).not.toBe(
      selfHosted
    );
  });

  it('keeps nested GitLab project paths unambiguous', () => {
    // A path segment can never bleed into the instance or the iid: JSON
    // escaping keeps array elements apart.
    expect(providerPrRefKey({ ...GITLAB, projectPath: 'group/sub/repo' })).not.toBe(
      providerPrRefKey({ ...GITLAB, projectPath: 'group' })
    );
    expect(
      providerPrRefKey({
        platform: 'gitlab',
        projectPath: 'a","b',
        mrIid: 1,
        instanceHint: 'x',
      })
    ).not.toBe(
      providerPrRefKey({
        platform: 'gitlab',
        projectPath: 'b',
        mrIid: 1,
        instanceHint: `x","a`,
      })
    );
  });

  it('folds Bitbucket workspace and repository identity apart', () => {
    const otherWorkspace = providerPrRefKey({ ...BITBUCKET, workspace: 'other' });
    const otherRepo = providerPrRefKey({ ...BITBUCKET, repoSlug: 'web' });
    expect(new Set([providerPrRefKey(BITBUCKET), otherWorkspace, otherRepo]).size).toBe(3);
  });

  it('separates pull request numbers', () => {
    expect(providerPrRefKey({ ...GITHUB, number: 8 })).not.toBe(providerPrRefKey(GITHUB));
    expect(providerPrRefKey({ ...GITLAB, mrIid: 8 })).not.toBe(providerPrRefKey(GITLAB));
    expect(providerPrRefKey({ ...BITBUCKET, prId: 8 })).not.toBe(providerPrRefKey(BITBUCKET));
  });
});

describe('gitlabInstanceOrigin', () => {
  it('normalizes scheme, case, path, and query but keeps the port', () => {
    expect(gitlabInstanceOrigin()).toBe('');
    expect(gitlabInstanceOrigin('  ')).toBe('');
    expect(gitlabInstanceOrigin('GitLab.Example.com')).toBe('gitlab.example.com');
    expect(gitlabInstanceOrigin('https://gitlab.example.com/group/repo')).toBe(
      'gitlab.example.com'
    );
    expect(gitlabInstanceOrigin('gitlab.example.com:8443')).toBe('gitlab.example.com:8443');
    expect(gitlabInstanceOrigin('gitlab.example.com/?x=1')).toBe('gitlab.example.com');
  });
});

describe('contract shapes', () => {
  // The inbox row must always carry its ref: the type below only compiles
  // because `ref` is required on ProviderPrInboxItem.
  it('carries the ref on every inbox item', () => {
    const item: ProviderPrInboxItem = {
      ref: GITLAB,
      title: 'Add retry',
      author: { login: 'octocat', avatarUrl: null },
      state: 'open',
      draft: false,
      updatedAt: '2026-09-06T00:00:00Z',
    };
    expect(providerPrRefKey(item.ref)).toBe(providerPrRefKey(GITLAB));
  });
});
