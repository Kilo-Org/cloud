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

describe('diff-selection-bridge', () => {
  beforeEach(() => {
    clearDiffSelection();
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
    clearDiffSelection();

    expect(getDiffSelection(PR_A)).toBeNull();
  });
});

describe('file-navigator-bridge', () => {
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
