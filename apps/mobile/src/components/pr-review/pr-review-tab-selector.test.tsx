// The Discussion tab carries a comment-count badge so an empty discussion is
// visible without opening the tab. No count (the PR query is still loading) and
// a zero count both draw nothing — a "0" badge is noise, not information.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import { type PrReviewTabId, PrReviewTabSelector } from './pr-review-tab-selector';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
  useColorScheme: () => 'light',
}));

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

function badges(discussionCount: number | undefined) {
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    rendered.current = TestRenderer.create(
      createElement(PrReviewTabSelector, {
        activeTab: 'overview',
        onChange: vi.fn<(tab: PrReviewTabId) => void>(),
        discussionCount,
      })
    );
  });
  if (!rendered.current) {
    throw new Error('render produced no tree');
  }
  return rendered.current.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => node.props.children)
    .filter(child => typeof child === 'string' && !child.startsWith('prReview.'));
}

describe('PrReviewTabSelector', () => {
  it('shows the comment count on the Discussion tab', () => {
    expect(badges(12)).toEqual(['12']);
  });

  it('draws no badge while the count is unknown or zero', () => {
    expect(badges(undefined)).toEqual([]);
    expect(badges(0)).toEqual([]);
  });
});

type Pill = {
  readonly props: {
    readonly disabled?: boolean;
    readonly accessibilityState?: { readonly selected: boolean; readonly disabled?: boolean };
    readonly onPress?: () => void;
  };
};

function renderSelector({
  activeTab,
  disabledTabs,
}: {
  activeTab: PrReviewTabId;
  disabledTabs?: readonly PrReviewTabId[];
}) {
  const onChange = vi.fn<(tab: PrReviewTabId) => void>();
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    rendered.current = TestRenderer.create(
      createElement(PrReviewTabSelector, { activeTab, onChange, disabledTabs })
    );
  });
  if (!rendered.current) {
    throw new Error('render produced no tree');
  }
  const pills = rendered.current.root.findAll(
    node => String(node.type) === 'Pressable'
  ) as unknown as Pill[];
  if (pills.length !== 3) {
    throw new Error(`expected three tabs, found ${pills.length}`);
  }
  return { onChange, pills };
}

describe('PrReviewTabSelector failure states', () => {
  it('leaves the tab that hosts the failure pressable', () => {
    // A reader parked on a tab whose reads cannot succeed still needs the way
    // back to the surface that explains the failure and offers its recovery.
    const { onChange, pills } = renderSelector({
      activeTab: 'files',
      disabledTabs: ['files', 'discussion'],
    });
    const [overview, files, discussion] = pills;
    if (!overview || !files || !discussion) {
      throw new Error('expected three tabs');
    }
    expect(overview.props).toEqual(expect.objectContaining({ disabled: false }));
    expect(overview.props.accessibilityState).toEqual({ selected: false, disabled: false });
    expect(files.props).toEqual(expect.objectContaining({ disabled: true }));
    expect(files.props.accessibilityState).toEqual({ selected: true, disabled: true });
    expect(discussion.props).toEqual(expect.objectContaining({ disabled: true }));

    overview.props.onPress?.();
    expect(onChange).toHaveBeenCalledWith('overview');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps every tab pressable without disabledTabs', () => {
    const { pills } = renderSelector({ activeTab: 'overview' });
    for (const pill of pills) {
      expect(pill.props).toEqual(expect.objectContaining({ disabled: false }));
    }
  });
});
