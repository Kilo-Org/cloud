/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/pr-review/pending-review-provider.mounted.test.tsx */
// MergeSheetFormBody field contract (s6f): the Bitbucket merge arm passes
// showTitle=false because the provider merge takes only the message — no
// commit-title input may exist on that arm whose value would be silently
// dropped on submit. The GitLab and GitHub arms keep the field.

import * as React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { MergeSheetFormBody } from './pr-merge-sheet-parts';
import { type AllowedMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';

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

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetFooter: 'PrFormSheetFooter',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: (props: unknown) => props,
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

function formBodyProps(showTitle: boolean) {
  const titleRef = { current: 'Merge pull request #1 from Feature' };
  const messageRef = { current: '' };
  return {
    noMethodsAllowed: false,
    methodOptions: [{ value: 'merge' as AllowedMergeMethod, label: 'Merge', icon: 'merge' }],
    method: 'merge' as AllowedMergeMethod,
    isMutating: false,
    onMethodChange: vi.fn(),
    titleRef,
    titleInputRef: { current: null },
    titlePlaceholder: 'Merge pull request #1 from Feature',
    showTitle,
    messageRef,
    messageInputRef: { current: null },
    isHalfDetent: false,
    showDeleteBranchToggle: false,
    deleteBranch: false,
    onDeleteBranchChange: vi.fn(),
    inlineError: null,
    inlineErrorKind: null,
    submitLabel: 'Merge',
    onConfirm: vi.fn(),
    onDismiss: vi.fn(),
  };
}

function inputByA11yLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string
): TestRenderer.ReactTestInstance | null {
  const found = renderer.root.findAll(node => node.props.accessibilityLabel === label);
  return found[0] ?? null;
}

describe('MergeSheetFormBody commit-title field (s6f)', () => {
  it('renders no commit-title input when showTitle is false (Bitbucket arm)', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(<MergeSheetFormBody {...formBodyProps(false)} />);
    });
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the guard proves it, the cast cannot
    if (!renderer) {
      throw new Error('Failed to mount MergeSheetFormBody');
    }
    expect(inputByA11yLabel(renderer, 'Commit title')).toBeNull();
    // The message field stays: the Bitbucket merge takes the message.
    expect(inputByA11yLabel(renderer, 'Commit message')).not.toBeNull();
  });

  it('keeps the commit-title input when showTitle is true (GitLab and GitHub arms)', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(<MergeSheetFormBody {...formBodyProps(true)} />);
    });
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the guard proves it, the cast cannot
    if (!renderer) {
      throw new Error('Failed to mount MergeSheetFormBody');
    }
    const title = inputByA11yLabel(renderer, 'Commit title');
    if (!title) {
      throw new Error('Commit title input not found');
    }
    expect(title.props.defaultValue).toBe('Merge pull request #1 from Feature');
  });
});
