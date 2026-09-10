/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrFormSheetFooter } from './pr-form-sheet-chrome';

const platformState = vi.hoisted(() => ({ OS: 'ios' as string }));
const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platformState,
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
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
