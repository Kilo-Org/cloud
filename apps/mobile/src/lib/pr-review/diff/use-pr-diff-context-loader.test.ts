import { describe, expect, it, vi } from 'vitest';

import { githubPrRef } from '@/lib/pr-review/provider-pr-ref';

import { contextScopeForItem } from './use-pr-diff-context-loader';

// The loader module reaches the real tRPC client through `@/lib/trpc`;
// `contextScopeForItem` is pure, so only the module-load chain needs a mock.
vi.mock('@/lib/trpc', () => ({ useTRPC: vi.fn() }));

const fallback = { owner: 'octocat', repo: 'hello', headSha: 'headsha' };

describe('contextScopeForItem', () => {
  const github = { ref: githubPrRef('octocat', 'hello', 7), organizationId: null };

  it('reads a GitHub cross-repo row from the row own repository', () => {
    const target = contextScopeForItem(
      github,
      { owner: 'forker', repo: 'hello', ref: 'forksha' },
      fallback
    );
    expect(target.scope.ref).toEqual(githubPrRef('forker', 'hello', 7));
    expect(target.ref).toBe('forksha');
  });

  it('falls back to the screen repository and head sha when the row carries none', () => {
    const target = contextScopeForItem(github, { owner: '', repo: '', ref: '' }, fallback);
    expect(target.scope.ref).toEqual(githubPrRef('octocat', 'hello', 7));
    expect(target.ref).toBe('headsha');
  });

  it('keeps a GitLab merge request on its own project', () => {
    const scope = {
      ref: { platform: 'gitlab' as const, projectPath: 'group/sub/repo', mrIid: 12 },
      organizationId: null,
    };
    const target = contextScopeForItem(
      scope,
      { owner: 'forker', repo: 'hello', ref: '' },
      fallback
    );
    expect(target.scope).toBe(scope);
    expect(target.ref).toBe('headsha');
  });

  it('keeps a Bitbucket pull request on its own repository and organization', () => {
    const scope = {
      ref: { platform: 'bitbucket' as const, workspace: 'acme', repoSlug: 'api', prId: 42 },
      organizationId: 'org-1',
    };
    const target = contextScopeForItem(
      scope,
      { owner: 'other', repo: 'other', ref: 'sha2' },
      fallback
    );
    expect(target.scope.ref).toEqual(scope.ref);
    expect(target.scope.organizationId).toBe('org-1');
    expect(target.ref).toBe('sha2');
  });
});
