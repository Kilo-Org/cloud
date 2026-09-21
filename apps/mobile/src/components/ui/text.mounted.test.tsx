import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing Text renderer');
  }
  return renderer.root;
}

function hostText(root: TestRenderer.ReactTestInstance) {
  return root.find(node => Object.is(node.type, 'Text'));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('Text mounted letter spacing', () => {
  it.each([false, true])('clears the tracking for Arabic children with isRTL=%s', isRTL => {
    i18nManager.isRTL = isRTL;
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'الجلسات الجارية الآن'))
    );

    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('leaves Latin children untouched and keeps LTR style undefined', () => {
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toBeUndefined();
  });

  it('clears the tracking of the eyebrow variant for Arabic children', () => {
    const text = hostText(mount(createElement(Text, { variant: 'eyebrow' }, 'عرض الكل')));

    expect(text.props.className as string).toContain('tracking-[1.5px]');
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('clears the tab label tracking for Arabic children', () => {
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[0.2px]' }, 'الرئيسية'))
    );

    expect(text.props.className as string).toContain('tracking-[0.2px]');
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('keeps the RTL paragraph direction for Latin children', () => {
    i18nManager.isRTL = true;
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toContainEqual({ writingDirection: 'rtl' });
    expect(text.props.style).not.toContainEqual({ letterSpacing: 0 });
  });
});
