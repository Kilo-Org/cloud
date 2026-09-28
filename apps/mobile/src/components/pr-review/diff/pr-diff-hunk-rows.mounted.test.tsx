import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { HunkHeaderRow } from './pr-diff-hunk-rows';
import { Text } from '@/components/ui/text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  File: 'File',
  GitCommit: 'GitCommit',
  X: 'X',
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/lib/format', () => ({ formatNumber: (value: number) => `${value}` }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

/** The style the host `Text` ended up with, flattened the way RN flattens it. */
function renderedTextStyle(element: ReactElement): Record<string, unknown> {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('the text did not render');
  }
  const host = renderer.root.find(
    node => Object.is(node.type, 'Text') && node.props.style !== undefined
  );
  return Object.assign({}, ...([host.props.style] as Record<string, unknown>[]).flat());
}

describe('HunkHeaderRow in an RTL interface', () => {
  // The header is a code literal, so the LTR direction it passes must survive
  // the shared Text's own RTL writing direction: the caller's style is the later
  // entry in the component's `[rtl, caller]` array, which RN flattens last.
  it('keeps the header left to right', () => {
    i18nManager.isRTL = true;
    const style = renderedTextStyle(createElement(HunkHeaderRow, { header: '@@ -0,0 +1,82 @@' }));
    expect(style).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
  });

  // The component does name the interface direction when the caller has none,
  // so the header's own direction is the only thing changing it.
  it('leaves a text with no direction of its own under the interface direction', () => {
    i18nManager.isRTL = true;
    const style = renderedTextStyle(createElement(Text, { style: { color: '#000000' } }, 'plain'));
    expect(style.writingDirection).toBe('rtl');
  });
});
