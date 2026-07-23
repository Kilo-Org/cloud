// P0-B-08 wiring test for `PrMergeSheet` success/partial/incomplete handling.
//
// The implementation is already verified; this test only proves that the
// sheet's `performSubmit` path writes the partial-success banner, fires the
// success haptic, and dismisses for clean/partial results, and does NONE of
// those for a `merged:false` (incomplete) result. The component is rendered
// under a minimal React mock (no React Native renderer is installed) so we can
// call it as a function and traverse the returned JSX tree to find the submit
// button and trigger its onPress.

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { PrMergeSheet } from './pr-merge-sheet';
import {
  __resetMergePartialSuccessStoreForTests,
  consumeMergePartialSuccess,
} from '@/lib/pr-review/merge/merge-result-banner-store';
import type { PrOverviewRepoSettings } from '@/lib/pr-review/merge/merge-blocked-reasons';

const trpcMocks = vi.hoisted(() => ({
  mergeMutate: vi.fn<() => Promise<unknown>>(),
}));

const mutationMockState = vi.hoisted(() => ({
  lastMutationOptions: null as { mutationFn?: (vars: unknown) => Promise<unknown> } | null,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(<T,>(initial: T) => [initial, vi.fn()] as [T, React.Dispatch<T>]),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    useRef: vi.fn(<T,>(initial: T) => ({ current: initial }) as React.MutableRefObject<T>),
    useEffect: vi.fn((effect: React.EffectCallback) => {
      effect();
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
  };
});

vi.mock('react-native', () => ({
  Alert: {
    alert: vi.fn(
      (
        title: string,
        message: string,
        buttons: readonly { style?: string; onPress?: () => void }[]
      ) => {
        const destructive = buttons.find(b => b.style === 'destructive');
        destructive?.onPress?.();
      }
    ),
  },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: { mutationFn?: (vars: unknown) => Promise<unknown> }) => {
    mutationMockState.lastMutationOptions = opts;
    return {
      mutateAsync: async (vars: unknown) => opts.mutationFn?.(vars),
      mutate: vi.fn(),
      isPending: false,
      error: null,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      getPullRequest: { queryKey: () => ['githubPrReview', 'getPullRequest'] },
      listChecks: { pathFilter: () => ['githubPrReview', 'listChecks'] },
      listFiles: { pathFilter: () => ['githubPrReview', 'listFiles'] },
      enableAutoMerge: { mutationOptions: () => ({}) },
    },
  }),
  trpcClient: {
    githubPrReview: {
      mergePullRequest: { mutate: trpcMocks.mergeMutate },
    },
  },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/pr-review/merge/pr-merge-icons', () => ({
  defaultMergeMethodOptionFor: () => 'squash',
  mergeMethodOptionsFor: () => [
    { value: 'merge', label: 'Merge', icon: 'merge' },
    { value: 'squash', label: 'Squash', icon: 'squash' },
    { value: 'rebase', label: 'Rebase', icon: 'rebase' },
  ],
}));
vi.mock('@/components/pr-review/merge/pr-merge-sheet-parts', () => ({
  CommitMessageField: 'CommitMessageField',
  CommitTitleField: 'CommitTitleField',
  DeleteBranchToggle: 'DeleteBranchToggle',
  MethodPicker: 'MethodPicker',
}));
vi.mock('@/lib/pr-review/merge/merge-commit-defaults', () => ({
  defaultCommitTitle: (title: string, number: number) =>
    `Merge pull request #${number} from ${title}`,
  defaultCommitMessage: () => '',
}));

const REF = { owner: 'octocat', repo: 'hello', number: 1 };

const baseProps = {
  owner: 'octocat',
  repoName: 'hello',
  number: 1,
  headSha: 'a'.repeat(40),
  headRef: 'feature/x',
  isCrossRepo: false,
  prNodeId: 'pr-node-1',
  title: 'Feature',
  bodyMarkdown: null,
  baseRef: 'main',
  repo: { deleteBranchOnMerge: true } as PrOverviewRepoSettings,
  initialMethod: 'squash' as const,
  mode: 'merge' as const,
  onRefetch: vi.fn(async () => {}),
  onDismiss: vi.fn(),
};

function findElement(
  node: unknown,
  type: string,
  prop: string,
  value: unknown
): React.ReactElement | null {
  if (React.isValidElement(node)) {
    const element = node as React.ReactElement;
    const props = element.props as Record<string, unknown>;
    if (element.type === type && props[prop] === value) {
      return element;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findElement(child, type, prop, value);
        if (found) return found;
      }
    } else if (children !== undefined && children !== null) {
      const found = findElement(children, type, prop, value);
      if (found) return found;
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type, prop, value);
      if (found) return found;
    }
  }
  return null;
}

function pressMerge(props: typeof baseProps) {
  const element = PrMergeSheet(props);
  const submitButton = findElement(element, 'Button', 'accessibilityLabel', 'Merge');
  if (!submitButton) {
    throw new Error('Merge button not found in rendered tree');
  }
  const onPress = (submitButton.props as { onPress?: () => void }).onPress;
  onPress?.();
  return element;
}

async function flushMicrotasks() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('PrMergeSheet performSubmit wiring (P0-B-08)', () => {
  beforeEach(() => {
    __resetMergePartialSuccessStoreForTests();
    mutationMockState.lastMutationOptions = null;
    vi.clearAllMocks();
  });

  it('partial success (merged:true + branchDeleteError) writes the banner, fires haptic, and dismisses', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn(async () => {});
    const props = { ...baseProps, onDismiss, onRefetch };

    trpcMocks.mergeMutate.mockResolvedValueOnce({
      merged: true,
      sha: 'mergedsha',
      branchDeleted: false,
      branchDeleteError: 'Reference does not exist',
    });

    pressMerge(props);
    await flushMicrotasks();

    expect(consumeMergePartialSuccess(REF)).toEqual({ reason: 'Reference does not exist' });
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clean success (merged:true + branchDeleted:true) fires haptic and dismisses without writing a banner', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn(async () => {});
    const props = { ...baseProps, onDismiss, onRefetch };

    trpcMocks.mergeMutate.mockResolvedValueOnce({
      merged: true,
      sha: 'mergedsha',
      branchDeleted: true,
    });

    pressMerge(props);
    await flushMicrotasks();

    expect(consumeMergePartialSuccess(REF)).toBeNull();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('incomplete result (merged:false) does not fire haptic, dismiss, or write a banner', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn(async () => {});
    const props = { ...baseProps, onDismiss, onRefetch };

    trpcMocks.mergeMutate.mockResolvedValueOnce({
      merged: false,
      sha: 'mergedsha',
      branchDeleted: false,
    });

    pressMerge(props);
    await flushMicrotasks();

    expect(consumeMergePartialSuccess(REF)).toBeNull();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(onRefetch).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// Touch the Alert import so the linter doesn't strip it as unused.
void Alert;
