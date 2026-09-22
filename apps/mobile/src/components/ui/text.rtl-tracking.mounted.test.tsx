import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { RTL_NO_LETTER_SPACING, RTL_WRITING_DIRECTION } from '@/lib/rtl-text';

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

/** The native Text host `Text` renders, whose style the platform draws. */
function hostText(root: TestRenderer.ReactTestInstance) {
  return root.find(node => Object.is(node.type, 'Text'));
}

function hostStyle(root: TestRenderer.ReactTestInstance): Record<string, unknown>[] {
  const style = (hostText(root).props.style ?? []) as (Record<string, unknown> | undefined)[];
  return style.filter(entry => entry !== undefined);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

// The tracked classes the home screen labels carry: the eyebrow
// ("الجلسات الجارية الآن", "استكشف"), the section-header action ("عرض الكل")
// and the bottom tab labels.
const TRACKED_CLASSES = ['tracking-[1.5px]', 'tracking-[0.2px]'] as const;

describe('Text tracked labels in RTL', () => {
  it.each(TRACKED_CLASSES)(
    'draws %s with no letter spacing while a tracked class stays on the element',
    trackedClass => {
      i18nManager.isRTL = true;
      const root = mount(createElement(Text, { className: trackedClass }, 'استكشف'));

      expect(hostText(root).props.className as string).toContain(trackedClass);
      expect(root.findAll(node => Object.is(node.type, 'Text'))).toHaveLength(1);
      expect(hostStyle(root)).toContainEqual(RTL_WRITING_DIRECTION);
      expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
    }
  );

  it('leaves no non-zero letter spacing on a tracked label in any class order', () => {
    i18nManager.isRTL = true;
    const root = mount(
      createElement(
        Text,
        { variant: 'eyebrow', className: 'grow tracking-[1.5px] text-primary' },
        'استكشف'
      )
    );

    expect(
      hostStyle(root)
        .map(entry => entry.letterSpacing)
        .filter(spacing => spacing !== undefined)
    ).toEqual([0]);
  });

  it('keeps the caller style after the RTL defaults', () => {
    i18nManager.isRTL = true;
    const callerStyle = { color: '#ff0000' };
    const root = mount(
      createElement(Text, { className: 'tracking-[1.5px]', style: callerStyle }, '…')
    );

    expect(hostStyle(root)).toContainEqual(callerStyle);
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });

  it('does not touch a tracked label in an LTR interface', () => {
    i18nManager.isRTL = false;
    const root = mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Explore'));

    expect(hostText(root).props.className as string).toContain('tracking-[1.5px]');
    expect(hostText(root).props.style).toBeUndefined();
  });

  it('applies the same reset to the shared Eyebrow label', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Eyebrow, null, 'استكشف'));

    // The eyebrow variant's Latin display treatment is LTR-only (#6435), so an
    // RTL eyebrow carries none of it; the shared reset still lands on the host
    // style, and any caller-supplied tracked class is neutralized the same way.
    const classes = (hostText(root).props.className as string).split(' ');
    expect(classes).not.toContain('uppercase');
    expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });
});
