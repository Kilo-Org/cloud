// Spot check e2-expand.png: the Finish review island floated over the
// unified diff with deleted-line text still visible around and below the
// button. The card was opaque but the bar's padding ring was not, so diff
// rows scrolled under it showed through. The bar container itself must
// carry the screen background and swallow touches in that ring.
// (Extracted from pr-diff-floating-actions.test.tsx to keep that file
// inside the max-lines budget.)

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { PrDiffFloatingActions } from './pr-diff-floating-actions';
import { type SelectionState } from '@/lib/pr-review/diff-selection';

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

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios' },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/icons', () => ({
  MessageCirclePlus: () => null,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#FFFFFF',
    foreground: '#000000',
    mutedForeground: '#6F6A61',
  }),
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({
  clearDiffSelection: vi.fn(),
}));

vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({
    items: [],
    addComment: vi.fn(() => undefined),
    updateComment: vi.fn(() => undefined),
    removeComment: vi.fn(() => undefined),
    clear: vi.fn(() => undefined),
  }),
}));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 7,
  viewMode: 'unified' as const,
  selection: null as SelectionState | null,
  onClearSelection: vi.fn(),
};

function renderBar(): React.ReactElement {
  // eslint-disable-next-line new-cap -- plain function component, no hooks state needed for the container props
  return PrDiffFloatingActions(baseProps);
}

describe('PrDiffFloatingActions opaque backdrop (spot check e2)', () => {
  it('paints the bar container with the screen background and swallows touches', () => {
    // With a transparent container the diff rows scrolled under the bar
    // stayed visible around and below the button. The container carries the
    // screen background, and the removed `pointerEvents="box-none"` means a
    // tap in the padding ring can never reach a diff row hidden behind it.
    const props = renderBar().props as { className?: string; pointerEvents?: string };
    expect(props.pointerEvents).toBeUndefined();
    expect((props.className ?? '').split(' ')).toContain('bg-background');
  });

  it('keeps the action card on the same background inside the bar', () => {
    const card = (renderBar().props as { children?: React.ReactElement }).children;
    if (!card) {
      throw new Error('floating action card not found');
    }
    const classes = (card.props as { className?: string }).className ?? '';
    expect(classes.split(' ')).toContain('bg-background');
  });
});
