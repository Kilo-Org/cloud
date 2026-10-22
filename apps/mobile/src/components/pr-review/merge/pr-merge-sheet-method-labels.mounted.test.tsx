import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { PrMergeSheet } from './pr-merge-sheet';
import { type PrOverviewRepoSettings } from '@/lib/pr-review/merge/merge-blocked-reasons';

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  View: 'View',
  Pressable: 'Pressable',
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

vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used-in-this-suite' }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  GitBranch: 'GitBranch',
  GitPullRequest: 'GitPullRequest',
  ShieldAlert: 'ShieldAlert',
  XCircle: 'XCircle',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/pr-review-capability-banner', () => ({
  PrReviewCapabilityBanner: 'PrReviewCapabilityBanner',
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/lib/pr-review/merge/use-pr-merge-mutations', () => ({
  useMergePullRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useEnableAutoMergeMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));
vi.mock('@/lib/persist/drafts', () => ({
  clearDraft: vi.fn(),
  isMergeDraft: vi.fn(),
  prMergeDraftKey: (owner: string, repo: string, number: number) =>
    `pr-merge:${owner}/${repo}#${number}`,
  saveDraft: vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: () => undefined }));

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

const sheetProps = {
  owner: 'octocat',
  repoName: 'hello',
  number: 1,
  headSha: 'a'.repeat(40),
  isCrossRepo: false,
  prNodeId: 'pr-node-1',
  title: 'Feature',
  bodyMarkdown: null,
  repo: repoSettings,
  initialMethod: 'squash' as const,
  mode: 'merge' as const,
  sheetTitle: 'Merge pull request',
  eyebrow: 'octocat/hello#1',
  onRefetch: () => Promise.resolve(),
  onDismiss: vi.fn(),
};

type Chip = { announced: string; visible: string };

/** The method radios in render order: the spoken label and the drawn label. */
function methodChips(renderer: TestRenderer.ReactTestRenderer): Chip[] {
  return renderer.root
    .findAll(node => {
      const state = node.props.accessibilityState as { selected?: boolean } | undefined;
      return node.props.accessibilityRole === 'button' && state?.selected !== undefined;
    })
    .map(chip => {
      const text = chip.findAll(node => String(node.type) === 'Text')[0];
      return {
        announced: String(chip.props.accessibilityLabel),
        visible: String(text?.props.children),
      };
    });
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(async () => {
  renderer?.unmount();
  renderer = undefined;
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en');
  }
});

describe('PrMergeSheet method chips', () => {
  it('renders the active language after a live language change', async () => {
    act(() => {
      renderer = TestRenderer.create(createElement(PrMergeSheet, sheetProps));
    });
    const mounted = renderer;
    if (!mounted) {
      throw new Error('the merge sheet did not mount');
    }
    expect(methodChips(mounted)).toEqual([
      { announced: 'Create a merge commit', visible: 'Merge' },
      { announced: 'Squash and merge', visible: 'Squash' },
      { announced: 'Rebase and merge', visible: 'Rebase' },
    ]);

    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(methodChips(mounted)).toEqual([
      { announced: 'Merge-Commit erstellen', visible: 'Zusammenführen' },
      { announced: 'Commits bündeln und zusammenführen', visible: 'Bündeln' },
      { announced: 'Commits neu aufsetzen und zusammenführen', visible: 'Neu aufsetzen' },
    ]);
  });
});
