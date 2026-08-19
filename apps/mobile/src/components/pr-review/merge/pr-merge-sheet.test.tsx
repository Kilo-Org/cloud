import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Haptics from 'expo-haptics';
import { PrMergeSheet } from './pr-merge-sheet';
import {
  __resetMergePartialSuccessStoreForTests,
  consumeMergePartialSuccess,
} from '@/lib/pr-review/merge/merge-result-banner-store';
import { type PrOverviewRepoSettings } from '@/lib/pr-review/merge/merge-blocked-reasons';
import { MergeNotCompletedError } from '@/lib/pr-review/merge/merge-result-error';
import { clearDraft } from '@/lib/persist/drafts';

const mergeMutationMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn<() => Promise<unknown>>(),
  isPending: false,
  error: null as Error | null,
}));

const autoMergeMutationMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn<() => Promise<unknown>>(),
  isPending: false,
  error: null as Error | null,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(
      <T,>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]
    ),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    useRef: vi.fn(<T,>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
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
        _title: string,
        _message: string,
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
  Switch: 'Switch',
  Platform: { OS: 'ios' },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'Success' },
}));

// `pr-merge-sheet` imports the ledger helpers, which import `expo-crypto`
// (and transitively expo-modules-core). Mock it so this suite stays
// node-only, same as the other ledger pure tests.
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used-in-pure-tests',
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/pr-review/merge/use-pr-merge-mutations', () => ({
  useMergePullRequestMutation: () => ({
    mutateAsync: mergeMutationMocks.mutateAsync,
    isPending: mergeMutationMocks.isPending,
    error: mergeMutationMocks.error,
  }),
  useEnableAutoMergeMutation: () => ({
    mutateAsync: autoMergeMutationMocks.mutateAsync,
    isPending: autoMergeMutationMocks.isPending,
    error: autoMergeMutationMocks.error,
  }),
  useUpdateBranchMutation: () => ({}),
  useDisableAutoMergeMutation: () => ({}),
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
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
  MergeSheetFormBody: 'MergeSheetFormBody',
  MethodPicker: 'MethodPicker',
}));
vi.mock('@/lib/pr-review/merge/merge-commit-defaults', () => ({
  defaultCommitTitle: (title: string, number: number) =>
    `Merge pull request #${number} from ${title}`,
  defaultCommitMessage: () => '',
}));

// The sheet imports the durable-draft chain, which pulls in the native
// encrypted-kv → expo-secure-store → expo-modules-core chain that the node
// test environment cannot resolve. Mock the persist chain and the identity
// hook so this suite stays node-only.
vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  isMergeDraft: vi.fn(),
  prMergeDraftKey: vi.fn(
    (owner: string, repo: string, number: number) => `pr-merge:${owner}/${repo}#${number}`
  ),
  prReplyDraftKey: vi.fn(),
  prCommentDraftKey: vi.fn(),
}));

vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({
  useDraftFlushOnBackground: () => {},
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));

const REF = { owner: 'octocat', repo: 'hello', number: 1 };

const repoSettings: PrOverviewRepoSettings = {
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
  allowAutoMerge: true,
  deleteBranchOnMerge: true,
  allowUpdateBranch: true,
  viewerCanPush: true,
  viewerCanAdmin: true,
};

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
  repo: repoSettings,
  initialMethod: 'squash' as const,
  mode: 'merge' as const,
  sheetTitle: 'Merge pull request',
  eyebrow: 'octocat/hello#1',
  onRefetch: vi.fn().mockResolvedValue(undefined),
  onDismiss: vi.fn(),
};

type FindElementArgs = {
  node: unknown;
  type: string;
  prop: string;
  value: unknown;
};

function findElement({ node, type, prop, value }: FindElementArgs): React.ReactElement | null {
  if (React.isValidElement(node)) {
    const element = node;
    const props = element.props as Record<string, unknown>;
    if (element.type === type && props[prop] === value) {
      return element;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findElement({ node: child, type, prop, value });
        if (found) {
          return found;
        }
      }
    } else if (children !== undefined && children !== null) {
      const found = findElement({ node: children, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement({ node: child, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function pressMerge(props: typeof baseProps) {
  // eslint-disable-next-line new-cap
  const element = PrMergeSheet(props);
  // The submit CTA lives inside MergeSheetFormBody (mocked as a string
  // element); the sheet wires its confirm handler as the `onConfirm` prop.
  // Invoking it drives the same Alert → destructive-confirm → performSubmit
  // path the production Merge button press takes.
  const formBody = findElement({
    node: element,
    type: 'MergeSheetFormBody',
    prop: 'submitLabel',
    value: 'Merge',
  });
  if (!formBody) {
    throw new Error('MergeSheetFormBody not found in rendered tree');
  }
  const onConfirm = (formBody.props as { onConfirm?: () => void }).onConfirm;
  onConfirm?.();
  return element;
}

async function flushMicrotasks() {
  await new Promise(resolve => {
    setTimeout(() => {
      resolve(undefined);
    }, 0);
  });
}

describe('PrMergeSheet performSubmit wiring (P0-B-08)', () => {
  beforeEach(() => {
    __resetMergePartialSuccessStoreForTests();
    mergeMutationMocks.mutateAsync.mockReset();
    mergeMutationMocks.error = null;
    autoMergeMutationMocks.mutateAsync.mockReset();
    autoMergeMutationMocks.error = null;
    vi.clearAllMocks();
  });

  it('partial success (merged:true + branchDeleteError) writes the banner, fires haptic, and dismisses', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const props = { ...baseProps, onDismiss, onRefetch };

    mergeMutationMocks.mutateAsync.mockResolvedValueOnce({
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
    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-merge:octocat/hello#1');
  });

  it('clean success (merged:true + branchDeleted:true) fires haptic and dismisses without writing a banner', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const props = { ...baseProps, onDismiss, onRefetch };

    mergeMutationMocks.mutateAsync.mockResolvedValueOnce({
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
    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-merge:octocat/hello#1');
  });

  it('rejected mutation (merged:false) does not fire haptic, refetch, dismiss, or write a banner', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const props = { ...baseProps, onDismiss, onRefetch };

    mergeMutationMocks.mutateAsync.mockRejectedValueOnce(new MergeNotCompletedError({ sha: 's1' }));

    pressMerge(props);
    await flushMicrotasks();

    expect(consumeMergePartialSuccess(REF)).toBeNull();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(onRefetch).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it('confirmed cancel clears the draft and dismisses', () => {
    const onDismiss = vi.fn();
    const props = { ...baseProps, onDismiss };
    // eslint-disable-next-line new-cap
    const element = PrMergeSheet(props);
    const formBody = findElement({
      node: element,
      type: 'MergeSheetFormBody',
      prop: 'submitLabel',
      value: 'Merge',
    });
    if (!formBody) {
      throw new Error('MergeSheetFormBody not found in rendered tree');
    }
    const onDismissProp = (formBody.props as { onDismiss?: () => void }).onDismiss;
    onDismissProp?.();
    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-merge:octocat/hello#1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('auto-merge enable success clears the draft and dismisses', async () => {
    const onDismiss = vi.fn();
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const props = { ...baseProps, mode: 'enable-auto-merge' as const, onDismiss, onRefetch };

    autoMergeMutationMocks.mutateAsync.mockResolvedValueOnce({});

    // eslint-disable-next-line new-cap
    const element = PrMergeSheet(props);
    const formBody = findElement({
      node: element,
      type: 'MergeSheetFormBody',
      prop: 'submitLabel',
      value: 'Enable auto-merge',
    });
    if (!formBody) {
      throw new Error('MergeSheetFormBody not found in rendered tree');
    }
    const onConfirm = (formBody.props as { onConfirm?: () => void }).onConfirm;
    onConfirm?.();
    await flushMicrotasks();

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-merge:octocat/hello#1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
