// The Discussion tab carries a comment-count badge so an empty discussion is
// visible without opening the tab. No count (the PR query is still loading) and
// a zero count both draw nothing — a "0" badge is noise, not information.

/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import { type PrReviewTabId, PrReviewTabSelector } from './pr-review-tab-selector';

vi.mock('react-native', () => ({
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
