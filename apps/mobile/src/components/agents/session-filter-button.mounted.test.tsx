// The on-device accessibility explorer measures a control's laid-out bounds and
// `hitSlop` never widens them: an icon Pressable with no box of its own is read
// as its 20pt glyph and reported too small to tap. These assertions pin the
// compiled box the filter control actually lays out, and the badge anchor that
// must not drift when that box grows.

import { createElement } from 'react';
import { Pressable, View } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { compiledDimensions } from '@/test/native-dimensions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionFilterButton } from './session-filter-button';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#777777' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderFilter(activeCount: number) {
  act(() => {
    renderer = TestRenderer.create(
      createElement(SessionFilterButton, {
        activeCount,
        onPress: () => undefined,
        testID: 'agents-open-filters',
      })
    );
  });
  if (!renderer) {
    throw new Error('Missing filter renderer');
  }
  return renderer.root.findByType(Pressable);
}

async function boxOf(button: TestRenderer.ReactTestInstance) {
  const declarations = (await compiledDimensions(button.props.className as string)) as {
    height?: number;
    width?: number;
  }[];
  return Object.assign({}, ...declarations) as { height: number; width: number };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('SessionFilterButton touch target', () => {
  it('lays out a box at least 28dp on a side', async () => {
    const button = renderFilter(0);
    const box = await boxOf(button);

    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(box.width).toBeGreaterThanOrEqual(28);
  });

  it('reaches the 44pt minimum target with its slop', async () => {
    const button = renderFilter(2);
    const box = await boxOf(button);
    const slop = button.props.hitSlop as number;

    expect(box.height + 2 * slop).toBeGreaterThanOrEqual(44);
    expect(box.width + 2 * slop).toBeGreaterThanOrEqual(44);
  });

  it('keeps the count badge anchored to the icon, not the enlarged box', () => {
    const button = renderFilter(2);
    const badgeText = button.findByProps({ testID: 'session-filter-badge' });
    const badge = badgeText.parent;
    const anchor = badge?.parent;

    expect(badge?.props.className).toContain('-right-1.5');
    expect(badge?.props.className).toContain('-top-1.5');
    expect(anchor?.type).toBe(View);
    expect(anchor?.findAllByType('SlidersHorizontal')).toHaveLength(1);
  });
});
