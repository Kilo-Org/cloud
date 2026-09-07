/* eslint-disable max-lines -- cohesive suite for merge draft save, restore, clear, and settle-gate contracts */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Haptics from 'expo-haptics';

import '@/i18n';
import {
  type ProviderPrMergeState,
  type ProviderReviewCapability,
} from '@kilocode/app-shared/provider-review';
import type * as ReactI18next from 'react-i18next';
import {
  MergeRestrictionsList,
  PrMergeSheet,
  ProviderAutoMergeBody,
  staleHeadRejectionMessage,
} from './pr-merge-sheet';
import { PrReviewCapabilityBanner } from '../pr-review-capability-banner';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import {
  __resetMergePartialSuccessStoreForTests,
  consumeMergePartialSuccess,
} from '@/lib/pr-review/merge/merge-result-banner-store';
import { type PrOverviewRepoSettings } from '@/lib/pr-review/merge/merge-blocked-reasons';
import { MergeNotCompletedError } from '@/lib/pr-review/merge/merge-result-error';
import { clearDraft } from '@/lib/persist/drafts';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

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

// Every useState setter the mocked hook primitives hand out, in call order.
// The error effect writes its inline copy through one of them, so a test can
// observe the state write even though the no-op mock never re-renders.
const stateSetters = vi.hoisted(() => [] as { mock: { calls: unknown[][] } }[]);

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(<T,>(initial: T) => {
      const setter = vi.fn();
      stateSetters.push(setter);
      return [initial, setter as () => void] as [T, (value: T) => void];
    }),
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

const alertCalls = vi.hoisted(() => [] as { title: string; message: string }[]);

vi.mock('react-native', () => ({
  Alert: {
    alert: vi.fn(
      (
        title: string,
        message: string,
        buttons: readonly { style?: string; onPress?: () => void }[]
      ) => {
        alertCalls.push({ title, message });
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

// The capability banner fades in as conditional content (AGENTS.md); this
// suite builds element trees without mounting, so the animated host only
// needs to resolve in the node environment.
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
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
  PrFormSheetFooter: 'PrFormSheetFooter',
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
  useDraftFlushOnBackground: () => undefined,
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

function pressMerge(props: Parameters<typeof PrMergeSheet>[0]) {
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

// ── Provider arms (s6) ───────────────────────────────────────────────

/** Find an element whose type is a real (unmocked) component — by identity. */
function findComponent(node: unknown, component: unknown): React.ReactElement | null {
  if (React.isValidElement(node)) {
    if (node.type === component) {
      return node;
    }
    const children = (node.props as Record<string, unknown>).children;
    const found = findComponent(children, component);
    if (found) {
      return found;
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findComponent(child, component);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/** findComponent, but fails the test loudly when the component is absent. */
function requireComponent(node: unknown, component: unknown): React.ReactElement {
  const found = findComponent(node, component);
  if (!found) {
    throw new Error(`component ${(component as { name?: string }).name ?? '?'} not found`);
  }
  return found;
}

/** Every string a directly-invoked component function rendered, in order. */
function collectTexts(node: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      walk((value.props as Record<string, unknown>).children);
    }
  };
  walk(node);
  return out;
}

const GITLAB_REF: ProviderPrRef = { platform: 'gitlab', projectPath: 'octocat/hello', mrIid: 1 };
const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'hello',
  prId: 1,
};

function mergeState(overrides: Partial<ProviderPrMergeState> = {}): ProviderPrMergeState {
  return {
    canMerge: true,
    approvalsRequired: 0,
    pipelineMustSucceed: false,
    conflicts: false,
    blockedReasons: [],
    ...overrides,
  };
}

const AUTO_MERGE_SUPPORTED: ProviderReviewCapability = { supported: true, reason: '' };
const AUTO_MERGE_UNSUPPORTED: ProviderReviewCapability = {
  supported: false,
  reason: 'Bitbucket Cloud does not expose auto-merge in its API',
};

describe('PrMergeSheet provider merge arm (s6)', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    __resetMergePartialSuccessStoreForTests();
    mergeMutationMocks.mutateAsync.mockReset();
    mergeMutationMocks.isPending = false;
    mergeMutationMocks.error = null;
    autoMergeMutationMocks.mutateAsync.mockReset();
    autoMergeMutationMocks.isPending = false;
    autoMergeMutationMocks.error = null;
    vi.clearAllMocks();
  });

  it('fences the merge on the head and folds the method into squash for GitLab', () => {
    mergeMutationMocks.mutateAsync.mockResolvedValueOnce({
      merged: true,
      sha: 'mergedsha',
      branchDeleted: true,
    });
    pressMerge({ ...baseProps, prRef: GITLAB_REF, mergeState: mergeState() });

    // The confirm dialog speaks the connected provider's noun, in sentence
    // form: "Merge merge request?", never "Merge Merge request?".
    expect(alertCalls[0]).toEqual({
      title: 'Merge merge request?',
      message: 'This will merge your changes into the base branch.',
    });
    expect(mergeMutationMocks.mutateAsync).toHaveBeenCalledWith({
      expectedHeadSha: 'a'.repeat(40),
      squash: true,
      deleteBranch: true,
      // The commit-title field rides the merge: GitLab takes the title the
      // user sees (here the mocked default).
      commitTitle: 'Merge pull request #1 from Feature',
    });
  });

  it('keeps the GitHub arm confirm copy and full input unchanged', () => {
    mergeMutationMocks.mutateAsync.mockResolvedValueOnce({
      merged: true,
      sha: 'mergedsha',
      branchDeleted: true,
    });
    pressMerge(baseProps);

    expect(alertCalls[0]?.title).toBe('Merge pull request?');
    expect(mergeMutationMocks.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        method: 'squash',
        expectedHeadSha: 'a'.repeat(40),
      })
    );
  });

  it('folds the provider ref identity into the durable merge draft key', async () => {
    mergeMutationMocks.mutateAsync.mockResolvedValueOnce({
      merged: true,
      sha: 'mergedsha',
      branchDeleted: true,
    });
    pressMerge({ ...baseProps, prRef: GITLAB_REF, mergeState: mergeState() });
    await flushMicrotasks();

    expect(clearDraft).toHaveBeenCalledWith(
      'u1',
      `pr-merge:octocat/hello#1@${providerPrRefKey(GITLAB_REF)}`
    );
  });

  it('shows the restrictions list above the form when the merge is allowed', () => {
    // eslint-disable-next-line new-cap
    const element = PrMergeSheet({
      ...baseProps,
      prRef: GITLAB_REF,
      mergeState: mergeState({ approvalsRequired: 2, pipelineMustSucceed: true }),
    });
    expect(
      findElement({
        node: element,
        type: 'MergeSheetFormBody',
        prop: 'submitLabel',
        value: 'Merge',
      })
    ).not.toBeNull();
    expect(findComponent(element, MergeRestrictionsList)).not.toBeNull();
  });

  it('replaces the form with the restrictions list when the merge is blocked', () => {
    // eslint-disable-next-line new-cap
    const element = PrMergeSheet({
      ...baseProps,
      prRef: GITLAB_REF,
      mergeState: mergeState({
        canMerge: false,
        blockedReasons: [{ code: 'failing_pipeline', message: 'Pipeline #123 failed' }],
      }),
    });
    // Nothing to submit: the form is gone and only Cancel remains.
    expect(
      findElement({
        node: element,
        type: 'MergeSheetFormBody',
        prop: 'submitLabel',
        value: 'Merge',
      })
    ).toBeNull();
    expect(findComponent(element, MergeRestrictionsList)).not.toBeNull();
    expect(
      findElement({ node: element, type: 'Button', prop: 'accessibilityLabel', value: 'Cancel' })
    ).not.toBeNull();
  });
});

// ── s6f: reviewer blocking findings ──────────────────────────────────

function forbiddenError(): Error {
  return Object.assign(new Error('403 Forbidden'), { data: { code: 'FORBIDDEN' } });
}

/** True when the error effect wrote `value` into any state slot. */
function stateValueWritten(value: string): boolean {
  return stateSetters.some(setter => setter.mock.calls.some(call => call[0] === value));
}

describe('PrMergeSheet commit-title arm (s6f)', () => {
  beforeEach(() => {
    stateSetters.length = 0;
    mergeMutationMocks.mutateAsync.mockReset();
    mergeMutationMocks.isPending = false;
    mergeMutationMocks.error = null;
    vi.clearAllMocks();
  });

  function formBodyProps(props: Parameters<typeof PrMergeSheet>[0]) {
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
    return formBody.props as { showTitle?: boolean };
  }

  it('hides the commit-title field on the Bitbucket arm (the provider takes only the message)', () => {
    expect(
      formBodyProps({ ...baseProps, prRef: BITBUCKET_REF, mergeState: mergeState() }).showTitle
    ).toBe(false);
  });

  it('keeps the commit-title field on the GitLab and GitHub arms', () => {
    expect(
      formBodyProps({ ...baseProps, prRef: GITLAB_REF, mergeState: mergeState() }).showTitle
    ).toBe(true);
    expect(formBodyProps(baseProps).showTitle).toBe(true);
  });

  it('never carries a commitTitle on the Bitbucket merge input', () => {
    mergeMutationMocks.mutateAsync.mockResolvedValueOnce({
      merged: true,
      sha: 'mergedsha',
      branchDeleted: true,
    });
    pressMerge({ ...baseProps, prRef: BITBUCKET_REF, mergeState: mergeState() });
    expect(mergeMutationMocks.mutateAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({ commitTitle: expect.anything() })
    );
  });
});

describe('PrMergeSheet refused-merge wording (s6f)', () => {
  beforeEach(() => {
    stateSetters.length = 0;
    mergeMutationMocks.mutateAsync.mockReset();
    mergeMutationMocks.isPending = false;
    mergeMutationMocks.error = null;
    vi.clearAllMocks();
  });

  it('words a refused GitLab merge after the merge-request noun', () => {
    mergeMutationMocks.error = forbiddenError();
    // eslint-disable-next-line new-cap
    PrMergeSheet({ ...baseProps, prRef: GITLAB_REF, mergeState: mergeState() });
    // The provider 403 must never read "pull request" on a merge request.
    expect(stateValueWritten("You don't have permission to merge this merge request.")).toBe(true);
    expect(stateValueWritten("You don't have permission to merge this pull request.")).toBe(false);
  });

  it('keeps the exact pre-s6 forbidden copy on the GitHub arm', () => {
    mergeMutationMocks.error = forbiddenError();
    // eslint-disable-next-line new-cap
    PrMergeSheet(baseProps);
    expect(stateValueWritten("You don't have permission to merge this pull request.")).toBe(true);
  });
});

describe('PrMergeSheet provider auto-merge arms (s6)', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    __resetMergePartialSuccessStoreForTests();
    mergeMutationMocks.mutateAsync.mockReset();
    autoMergeMutationMocks.mutateAsync.mockReset();
    autoMergeMutationMocks.isPending = false;
    autoMergeMutationMocks.error = null;
    vi.clearAllMocks();
  });

  function autoMergeProps(ref: ProviderPrRef, capability: ProviderReviewCapability) {
    return {
      ...baseProps,
      mode: 'enable-auto-merge' as const,
      prRef: ref,
      mergeState: mergeState({ approvalsRequired: 2 }),
      autoMergeCapability: capability,
    };
  }

  function pressSubmit(element: React.ReactElement): () => void {
    const submit = findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Enable auto-merge',
    });
    if (!submit) {
      throw new Error('auto-merge submit button not found');
    }
    const onPress = (submit.props as { onPress?: () => void }).onPress;
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the guard above proves it, the cast cannot
    if (!onPress) {
      throw new Error('auto-merge submit has no onPress');
    }
    return onPress;
  }

  it('arms GitLab auto-merge through the head fence with the provider confirm copy', () => {
    autoMergeMutationMocks.mutateAsync.mockResolvedValueOnce({ supported: true, reason: '' });
    // eslint-disable-next-line new-cap
    const element = PrMergeSheet(autoMergeProps(GITLAB_REF, AUTO_MERGE_SUPPORTED));
    expect(findComponent(element, ProviderAutoMergeBody)).not.toBeNull();

    pressSubmit(element)();
    expect(alertCalls[0]?.message).toBe(
      'The merge request will merge automatically once its pipeline succeeds.'
    );
    expect(autoMergeMutationMocks.mutateAsync).toHaveBeenCalledWith({
      expectedHeadSha: 'a'.repeat(40),
    });
  });

  it('shows the capability banner with the provider reason for Bitbucket, with nothing to submit', () => {
    // eslint-disable-next-line new-cap
    const element = PrMergeSheet(autoMergeProps(BITBUCKET_REF, AUTO_MERGE_UNSUPPORTED));
    // The banner carries the server's explicit reason; no submit CTA exists.
    const banner = requireComponent(element, PrReviewCapabilityBanner);
    expect((banner.props as { capability?: ProviderReviewCapability }).capability).toBe(
      AUTO_MERGE_UNSUPPORTED
    );
    expect(
      findElement({
        node: element,
        type: 'Button',
        prop: 'accessibilityLabel',
        value: 'Enable auto-merge',
      })
    ).toBeNull();
    expect(autoMergeMutationMocks.mutateAsync).not.toHaveBeenCalled();
  });
});

describe('MergeRestrictionsList (s6)', () => {
  it('lists the policy flags in localized copy', () => {
    // eslint-disable-next-line new-cap
    const tree = MergeRestrictionsList({
      mergeState: mergeState({
        canMerge: false,
        approvalsRequired: 2,
        pipelineMustSucceed: true,
        conflicts: true,
      }),
      term: 'merge request',
    });
    const texts = collectTexts(tree);
    expect(texts).toContain('Merge restrictions');
    expect(texts).toContain('Resolve the merge conflicts on this branch before merging.');
    expect(texts).toContain('2 approvals required');
    expect(texts).toContain('The pipeline must succeed before merging.');
  });

  it('localizes known provider reasons and keeps the server message for `other`', () => {
    // eslint-disable-next-line new-cap
    const tree = MergeRestrictionsList({
      mergeState: mergeState({
        canMerge: false,
        blockedReasons: [
          { code: 'failing_pipeline', message: 'Pipeline #123 failed' },
          { code: 'pending_pipeline', message: 'Pipeline #124 running' },
          { code: 'permission', message: '403 Forbidden' },
          { code: 'other', message: 'A merge is already running' },
        ],
      }),
      term: 'merge request',
    });
    const texts = collectTexts(tree);
    expect(texts).toContain('The pipeline is failing on the latest commit.');
    expect(texts).toContain('The pipeline is still running on the latest commit.');
    expect(texts).toContain("You don't have permission to merge this merge request.");
    // The `other` code keeps the provider's own message verbatim.
    expect(texts).toContain('A merge is already running');
  });

  it('does not repeat a flag the reasons list already carries', () => {
    // eslint-disable-next-line new-cap
    const tree = MergeRestrictionsList({
      mergeState: mergeState({
        canMerge: false,
        approvalsRequired: 3,
        pipelineMustSucceed: true,
        conflicts: true,
        blockedReasons: [
          { code: 'conflicts', message: 'conflicts exist' },
          { code: 'failing_pipeline', message: 'Pipeline #123 failed' },
        ],
      }),
      term: 'merge request',
    });
    const texts = collectTexts(tree);
    const conflictRows = texts.filter(
      text => text === 'Resolve the merge conflicts on this branch before merging.'
    );
    expect(conflictRows).toHaveLength(1);
    // The pipeline flag row is suppressed: the failing-pipeline reason says it.
    expect(texts).not.toContain('The pipeline must succeed before merging.');
    expect(texts).toContain('3 approvals required');
  });

  it('maps the draft reason onto the provider noun', () => {
    // eslint-disable-next-line new-cap
    const tree = MergeRestrictionsList({
      mergeState: mergeState({
        canMerge: false,
        blockedReasons: [{ code: 'draft', message: 'Draft status' }],
      }),
      term: 'merge request',
    });
    expect(collectTexts(tree)).toContain(
      'Mark the merge request as ready for review before merging.'
    );
  });

  it('renders nothing when no restriction applies', () => {
    // eslint-disable-next-line new-cap
    expect(MergeRestrictionsList({ mergeState: mergeState(), term: 'merge request' })).toBeNull();
  });
});

describe('ProviderAutoMergeBody (s6)', () => {
  it('explains the arm in the provider noun and repeats the restrictions', () => {
    // eslint-disable-next-line new-cap
    const tree = ProviderAutoMergeBody({
      mergeState: mergeState({ approvalsRequired: 2 }),
      term: 'merge request',
    });
    // The restrictions render as a mounted MergeRestrictionsList child.
    const restrictions = requireComponent(tree, MergeRestrictionsList);
    expect(
      (restrictions.props as { mergeState?: ProviderPrMergeState }).mergeState?.approvalsRequired
    ).toBe(2);
    expect(collectTexts(tree)).toContain(
      'GitLab merges this merge request automatically once its pipeline succeeds.'
    );
  });

  it('renders just the explanation while the merge state has not loaded', () => {
    // eslint-disable-next-line new-cap
    const tree = ProviderAutoMergeBody({ mergeState: null, term: 'merge request' });
    expect(collectTexts(tree)).toEqual([
      'GitLab merges this merge request automatically once its pipeline succeeds.',
    ]);
  });
});

function conflictError(message: string): Error {
  return Object.assign(new Error(message), { data: { code: 'CONFLICT' } });
}

describe('staleHeadRejectionMessage (s6)', () => {
  it('returns the provider reason for a moved head', () => {
    const message =
      'The merge request changed since it was loaded. Reload the merge request and try again.';
    expect(staleHeadRejectionMessage(conflictError(message))).toBe(message);
  });

  it('returns the reason for a target closed without merging', () => {
    const message = 'The merge request was closed without merging.';
    expect(staleHeadRejectionMessage(conflictError(message))).toBe(message);
  });

  it('leaves other conflicts to the generic classification', () => {
    expect(staleHeadRejectionMessage(conflictError('A merge is already running'))).toBeNull();
  });

  it('ignores errors that are not conflicts', () => {
    expect(
      staleHeadRejectionMessage(
        Object.assign(new Error('The merge request changed since it was loaded.'), {
          data: { code: 'FORBIDDEN' },
        })
      )
    ).toBeNull();
  });
});
