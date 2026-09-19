// The in-field clear glyph is 16pt, so the Pressable's own box must carry the
// tap target: `hitSlop` widens the touch area but not the accessibility node
// bounds the explorer's tap-target audit measures. The audit flags a control
// below 28dp on a side; the box targets the repo's 44pt minimum (WCAG 2.5.8 AA).

import { createRef, type ElementType } from 'react';
import { type TextInput } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { SessionListSearchHeader } from './session-list-search-header';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6f6a61' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** The minimum box a pressable's className declares, in px. */
function declaredBoxSize(className: string): { width: number; height: number } {
  const read = (axis: 'h' | 'w') => {
    const match = new RegExp(`(?:min-)?${axis}-\\[(\\d+)px\\]`).exec(className);
    return match ? Number(match[1]) : 0;
  };
  return { width: read('w'), height: read('h') };
}

let mounted: ReactTestRenderer | undefined = undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountHeader(hasText: boolean): ReactTestRenderer {
  act(() => {
    mounted = TestRenderer.create(
      <SessionListSearchHeader
        inputRef={createRef<TextInput>()}
        hasText={hasText}
        showSearchBusy={false}
        onChangeText={vi.fn<(text: string) => void>()}
        onClearSearch={vi.fn<() => void>()}
      />
    );
  });
  if (!mounted) {
    throw new Error('SessionListSearchHeader did not mount');
  }
  return mounted;
}

function clearPressable(renderer: ReactTestRenderer) {
  return renderer.root.find(
    node =>
      node.type === ('Pressable' as ElementType) &&
      node.props.accessibilityLabel === 'common.clearSearch'
  );
}

describe('SessionListSearchHeader clear-search tap target', () => {
  it('carries at least 28dp on both sides while the field holds text', () => {
    const box = declaredBoxSize(String(clearPressable(mountHeader(true)).props.className));
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
  });

  it('renders no clear control while the field is empty', () => {
    expect(
      mountHeader(false).root.findAll(
        node =>
          node.type === ('Pressable' as ElementType) &&
          node.props.accessibilityLabel === 'common.clearSearch'
      )
    ).toHaveLength(0);
  });
});
