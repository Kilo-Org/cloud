import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from '@/components/ui/eyebrow';
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

describe('Text RTL letter-spacing reset', () => {
  it('resets the tracking of an Arabic run in an LTR interface', () => {
    const text = hostText(mount(createElement(Text, { variant: 'eyebrow' }, 'المظهر')));
    expect(text.props.style).toEqual([{ letterSpacing: 0 }]);
  });

  it('keeps the RTL paragraph direction behind the Arabic reset', () => {
    i18nManager.isRTL = true;
    const text = hostText(mount(createElement(Text, { variant: 'eyebrow' }, 'المظهر')));
    expect(text.props.style).toEqual([{ letterSpacing: 0 }, { writingDirection: 'rtl' }]);
  });

  it('keeps a Latin run tracked in an RTL interface', () => {
    i18nManager.isRTL = true;
    const text = hostText(mount(createElement(Text, { variant: 'eyebrow' }, 'Appearance')));
    expect(text.props.style).toEqual([{ writingDirection: 'rtl' }]);
    expect(text.props.style).not.toContainEqual({ letterSpacing: 0 });
    expect((text.props.className as string).split(' ')).toContain('tracking-[1.5px]');
  });

  it('keeps a caller letter spacing last', () => {
    const text = hostText(
      mount(createElement(Text, { variant: 'eyebrow', style: { letterSpacing: 2 } }, 'المظهر'))
    );
    expect(text.props.style).toEqual([{ letterSpacing: 0 }, { letterSpacing: 2 }]);
  });

  it('resets the eyebrow variant while its tracking class stays', () => {
    const text = hostText(mount(createElement(Eyebrow, null, 'المظهر')));
    expect(text.props.style).toEqual([{ letterSpacing: 0 }]);
    expect((text.props.className as string).split(' ')).toContain('tracking-[1.5px]');
  });
});
