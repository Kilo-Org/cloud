import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { RTL_NO_LETTER_SPACING } from '@/lib/rtl-text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
// `Text` reads the native direction at render time, so the mutable flag drives
// each render; the host text element is the assertion target.
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
// `@rn-primitives/slot` ships untranspiled JSX and is only reached by `asChild`.
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
  return root.find(candidate => Object.is(candidate.type, 'Text'));
}

function hostClasses(root: TestRenderer.ReactTestInstance): string[] {
  return String(hostText(root).props.className).split(' ');
}

function hostStyle(root: TestRenderer.ReactTestInstance): unknown[] {
  const style = (hostText(root).props.style ?? []) as unknown[];
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

describe('Text eyebrow letterspacing', () => {
  // Finding home-ar-loading: an Arabic section label carried the Latin
  // uppercase letter-spacing and broke apart mid-word ('ال جلسا ت'). The
  // tracked class stays on the element in either direction; the RTL style
  // array resets the letter-spacing, so the Arabic label keeps its joins
  // (see lib/rtl-text.ts).
  it.each([false, true])('keeps the eyebrow display treatment unspaced in RTL (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const root = mount(createElement(Text, { variant: 'eyebrow' }, 'Live now'));
    expect(hostClasses(root)).toEqual(
      expect.arrayContaining([
        'font-mono-medium',
        'text-[10px]',
        'text-muted-foreground',
        'uppercase',
        'tracking-[1.5px]',
      ])
    );
    if (isRTL) {
      expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
    } else {
      expect(hostText(root).props.style).toBeUndefined();
    }
  });

  it('leaves a non-eyebrow variant untouched in either direction', () => {
    i18nManager.isRTL = true;
    const classes = hostClasses(mount(createElement(Text, null, 'Live now')));
    expect(classes).not.toContain('uppercase');
    expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
  });

  it.each([false, true])('applies the same rule to the Eyebrow component (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const root = mount(createElement(Eyebrow, null, isRTL ? 'الجلسات الجارية الآن' : 'LIVE NOW'));
    expect(hostClasses(root)).toEqual(
      expect.arrayContaining(['font-mono-medium', 'text-[10px]', 'uppercase', 'tracking-[1.5px]'])
    );
    if (isRTL) {
      expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
    } else {
      expect(hostText(root).props.style).toBeUndefined();
    }
  });
});
