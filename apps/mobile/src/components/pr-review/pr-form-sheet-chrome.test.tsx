import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrFormSheetFooter, PrFormSheetHeader } from './pr-form-sheet-chrome';

const platformState = vi.hoisted(() => ({ OS: 'ios' as string }));
const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const statusBarState = vi.hoisted(() => ({ currentHeight: null as number | null }));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platformState,
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
  StatusBar: {
    get currentHeight() {
      return statusBarState.currentHeight;
    },
  },
  useWindowDimensions: () => ({ width: 411.43, height: 914.29 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));

function mountFooter(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrFormSheetFooter, null, 'CTAs'));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function footerStyleProp(
  renderer: TestRenderer.ReactTestRenderer,
  key: 'paddingBottom' | 'paddingLeft' | 'paddingRight'
): number | undefined {
  const views = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'View'
  );
  const footer = views[0];
  if (!footer) {
    throw new Error('footer View not found');
  }
  return (footer.props.style as Record<string, number | undefined> | undefined)?.[key];
}

function mountHeader(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(PrFormSheetHeader, {
        title: 'Merge pull request',
        eyebrow: 'octocat/hello-world#1',
        onBack: () => undefined,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The header container is the element react-native-screens keeps at index 0. */
function headerPaddingTop(renderer: TestRenderer.ReactTestRenderer): number | undefined {
  const container = renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.collapsable === false
  );
  return (container.props.style as Record<string, number | undefined> | undefined)?.paddingTop;
}

describe('PrFormSheetFooter bottom inset (plan §6)', () => {
  beforeEach(() => {
    platformState.OS = 'ios';
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
  });

  it('keeps the 16-point base padding on iOS at a nonzero inset', () => {
    insetsState.bottom = 34;
    const renderer = mountFooter();

    expect(footerStyleProp(renderer, 'paddingBottom')).toBe(16);
  });

  it('keeps the 16-point base padding on Android at a zero inset', () => {
    platformState.OS = 'android';
    insetsState.bottom = 0;
    const renderer = mountFooter();

    expect(footerStyleProp(renderer, 'paddingBottom')).toBe(16);
  });

  it('adds the Android system inset to the 16-point base padding', () => {
    platformState.OS = 'android';
    insetsState.bottom = 34;
    const renderer = mountFooter();

    expect(footerStyleProp(renderer, 'paddingBottom')).toBe(50);
  });
});

describe('PrFormSheetFooter side insets (landscape)', () => {
  beforeEach(() => {
    platformState.OS = 'ios';
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
  });

  it('keeps the 24-point gutter at zero portrait insets', () => {
    const renderer = mountFooter();

    expect(footerStyleProp(renderer, 'paddingLeft')).toBe(24);
    expect(footerStyleProp(renderer, 'paddingRight')).toBe(24);
    expect(footerStyleProp(renderer, 'paddingBottom')).toBe(16);
  });

  it('widens the gutter by the landscape side insets on iOS', () => {
    insetsState.left = 59;
    insetsState.right = 59;
    const renderer = mountFooter();

    expect(footerStyleProp(renderer, 'paddingLeft')).toBe(83);
    expect(footerStyleProp(renderer, 'paddingRight')).toBe(83);
    expect(footerStyleProp(renderer, 'paddingBottom')).toBe(16);
  });

  it('widens the gutter by the landscape side insets on Android too', () => {
    platformState.OS = 'android';
    insetsState.left = 24;
    insetsState.right = 24;
    const renderer = mountFooter();

    expect(footerStyleProp(renderer, 'paddingLeft')).toBe(48);
    expect(footerStyleProp(renderer, 'paddingRight')).toBe(48);
    // Side insets are independent of the Android bottom-inset rule.
    expect(footerStyleProp(renderer, 'paddingBottom')).toBe(16);
  });
});

/**
 * The sheet surface reaches the window top on Android, so the header clears
 * the status bar itself — from the window inset the app boots with, so its
 * first frame is the settled one. A nested safe-area provider measured the
 * header instead, reported 0 before the sheet presented and the inset after,
 * and moved the whole header by the status-bar height once it landed.
 */
describe('PrFormSheetHeader top clearance', () => {
  beforeEach(() => {
    platformState.OS = 'android';
    insetsState.top = 0;
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    statusBarState.currentHeight = 51.81;
  });

  it('reserves the status-bar height before the window inset resolves', () => {
    const renderer = mountHeader();

    expect(headerPaddingTop(renderer)).toBe(51.81);
  });

  it('keeps the resolved window inset instead of flipping the reserve', () => {
    insetsState.top = 51.81;
    const renderer = mountHeader();

    expect(headerPaddingTop(renderer)).toBe(51.81);
  });

  it('leaves the iOS sheet, which presents below the status bar, with no reserve', () => {
    platformState.OS = 'ios';
    insetsState.top = 59;
    const renderer = mountHeader();

    expect(headerPaddingTop(renderer)).toBeUndefined();
  });

  it('paints one container whose header stays the screen content index 0', () => {
    const renderer = mountHeader();
    const containers = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'View'
    );

    expect(containers).toHaveLength(1);
    expect(containers[0]?.props.collapsable).toBe(false);
    expect(containers[0]?.props.className).toContain('border-b');
  });
});
