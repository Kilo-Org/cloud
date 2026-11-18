import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearDiffSelection, getDiffSelection, setDiffSelection } from './diff-selection-bridge';
import {
  type FileNavigatorRequest,
  requestScrollToFile,
  subscribeFileNavigatorRequest,
} from './file-navigator-bridge';

type NavListener = (request: FileNavigatorRequest) => void;

const PR_A = { owner: 'octocat', repo: 'hello', number: 1 };
const PR_B = { owner: 'octocat', repo: 'hello', number: 2 };
// The provider surface hands the bridges its ref alongside the same
// GitHub-shaped triple every provider ref maps to, so the bridge resolves
// its slot under the full provider identity (identity rule 17).
const GITLAB_REF_A = {
  platform: 'gitlab',
  projectPath: 'octocat/hello',
  mrIid: 1,
} as const;
const GITLAB_REF_A_OTHER_INSTANCE = {
  platform: 'gitlab',
  projectPath: 'octocat/hello',
  mrIid: 1,
  instanceHint: 'https://gitlab.example.com',
} as const;
const BITBUCKET_REF_A = {
  platform: 'bitbucket',
  workspace: 'octocat',
  repoSlug: 'hello',
  prId: 1,
} as const;

describe('diff-selection-bridge', () => {
  beforeEach(() => {
    clearDiffSelection(PR_A);
    clearDiffSelection(PR_B);
  });

  it('returns the selection only to the PR that produced it', () => {
    setDiffSelection({ ...PR_A, path: 'a.ts', side: 'RIGHT', line: 3, selectedText: 'x' });

    expect(getDiffSelection(PR_A)?.path).toBe('a.ts');
    expect(getDiffSelection(PR_B)).toBeNull();
  });

  it('matches PR identity case-insensitively on owner/repo', () => {
    setDiffSelection({ ...PR_A, path: 'a.ts', side: 'RIGHT', line: 3, selectedText: 'x' });

    expect(getDiffSelection({ owner: 'OCTOCAT', repo: 'Hello', number: 1 })).not.toBeNull();
  });

  it('clears the selection so it never leaks into the next visit', () => {
    setDiffSelection({ ...PR_A, path: 'a.ts', side: 'RIGHT', line: 3, selectedText: 'x' });
    clearDiffSelection(PR_A);

    expect(getDiffSelection(PR_A)).toBeNull();
  });

  it('clears only the requested PR when two PRs hold a selection', () => {
    setDiffSelection({ ...PR_A, path: 'a.ts', side: 'RIGHT', line: 3, selectedText: 'x' });
    setDiffSelection({ ...PR_B, path: 'b.ts', side: 'LEFT', line: 9, selectedText: 'y' });

    clearDiffSelection(PR_A);

    expect(getDiffSelection(PR_A)).toBeNull();
    expect(getDiffSelection(PR_B)?.path).toBe('b.ts');
  });

  it('resolves the provider-scoped key for a provider ref with the same triple', () => {
    setDiffSelection({ ...PR_A, path: 'gh.ts', side: 'RIGHT', line: 3, selectedText: 'gh' });
    setDiffSelection({
      ...PR_A,
      ref: GITLAB_REF_A,
      path: 'gl.ts',
      side: 'RIGHT',
      line: 5,
      selectedText: 'gl',
    });

    expect(getDiffSelection({ ...PR_A, ref: GITLAB_REF_A })?.path).toBe('gl.ts');
    expect(getDiffSelection(PR_A)?.path).toBe('gh.ts');
    expect(getDiffSelection({ ...PR_A, ref: BITBUCKET_REF_A })).toBeNull();
  });

  it('resolves distinct keys for two GitLab instances with the same project path and MR', () => {
    setDiffSelection({
      ...PR_A,
      ref: GITLAB_REF_A,
      path: 'saas.ts',
      side: 'RIGHT',
      line: 2,
      selectedText: 'saas',
    });
    setDiffSelection({
      ...PR_A,
      ref: GITLAB_REF_A_OTHER_INSTANCE,
      path: 'self.ts',
      side: 'RIGHT',
      line: 4,
      selectedText: 'self',
    });

    expect(getDiffSelection({ ...PR_A, ref: GITLAB_REF_A })?.path).toBe('saas.ts');
    expect(getDiffSelection({ ...PR_A, ref: GITLAB_REF_A_OTHER_INSTANCE })?.path).toBe('self.ts');
  });

  it('clears the provider-scoped slot without touching the GitHub slot', () => {
    setDiffSelection({ ...PR_A, path: 'gh.ts', side: 'RIGHT', line: 3, selectedText: 'gh' });
    setDiffSelection({
      ...PR_A,
      ref: GITLAB_REF_A,
      path: 'gl.ts',
      side: 'RIGHT',
      line: 5,
      selectedText: 'gl',
    });

    clearDiffSelection({ ...PR_A, ref: GITLAB_REF_A });

    expect(getDiffSelection({ ...PR_A, ref: GITLAB_REF_A })).toBeNull();
    expect(getDiffSelection(PR_A)?.path).toBe('gh.ts');
  });
});

describe('file-navigator-bridge', () => {
  it('resolves the provider-scoped key for a provider ref with the same triple', () => {
    const listenerGh = vi.fn<NavListener>();
    const listenerGl = vi.fn<NavListener>();
    const unsubGh = subscribeFileNavigatorRequest(PR_A, listenerGh);
    const unsubGl = subscribeFileNavigatorRequest({ ...PR_A, ref: GITLAB_REF_A }, listenerGl);

    requestScrollToFile({ ...PR_A, path: 'gh.ts' });
    requestScrollToFile({ ...PR_A, ref: GITLAB_REF_A, path: 'gl.ts' });

    expect(listenerGh).toHaveBeenCalledTimes(1);
    expect(listenerGl).toHaveBeenCalledTimes(1);
    expect(listenerGh).toHaveBeenCalledWith({ ...PR_A, path: 'gh.ts' });
    expect(listenerGl).toHaveBeenCalledWith({ ...PR_A, ref: GITLAB_REF_A, path: 'gl.ts' });

    unsubGh();
    unsubGl();
  });

  it('resolves distinct keys for two GitLab instances with the same project path and MR', () => {
    const listenerSaas = vi.fn<NavListener>();
    const listenerSelf = vi.fn<NavListener>();
    const unsubSaas = subscribeFileNavigatorRequest({ ...PR_A, ref: GITLAB_REF_A }, listenerSaas);
    const unsubSelf = subscribeFileNavigatorRequest(
      { ...PR_A, ref: GITLAB_REF_A_OTHER_INSTANCE },
      listenerSelf
    );

    requestScrollToFile({ ...PR_A, ref: GITLAB_REF_A, path: 'saas.ts' });

    expect(listenerSaas).toHaveBeenCalledTimes(1);
    expect(listenerSelf).not.toHaveBeenCalled();

    unsubSaas();
    unsubSelf();
  });

  it('delivers a scroll request only to listeners of the same PR', () => {
    const listenerA = vi.fn<NavListener>();
    const listenerB = vi.fn<NavListener>();
    const unsubA = subscribeFileNavigatorRequest(PR_A, listenerA);
    const unsubB = subscribeFileNavigatorRequest(PR_B, listenerB);

    requestScrollToFile({ ...PR_A, path: 'a.ts' });

    expect(listenerA).toHaveBeenCalledWith({ ...PR_A, path: 'a.ts' });
    expect(listenerB).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn<NavListener>();
    const unsub = subscribeFileNavigatorRequest(PR_A, listener);
    unsub();

    requestScrollToFile({ ...PR_A, path: 'a.ts' });

    expect(listener).not.toHaveBeenCalled();
  });
});
