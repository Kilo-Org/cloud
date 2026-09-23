import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

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

// Both assertions are kept: `hostText` reaches the host node to read its inline
// style, `hostClasses` reads the resolved class list.
function hostText(root: TestRenderer.ReactTestInstance) {
  return root.find(node => Object.is(node.type, 'Text'));
}

function hostClasses(root: TestRenderer.ReactTestInstance): string[] {
  const node = root.find(candidate => Object.is(candidate.type, 'Text'));
  return String(node.props.className).split(' ');
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

  // The interface direction owns the reset outside joined script: an RTL
  // interface draws every run unspaced (`RTL_NO_LETTER_SPACING`), so a Latin
  // label keeps the paragraph direction and loses the tracking its class asks
  // for. The joined-script rule only adds the override in an LTR interface.
  it('keeps the RTL paragraph direction and the reset for Latin children', () => {
    i18nManager.isRTL = true;
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toContainEqual({ writingDirection: 'rtl' });
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });
});

describe('Text eyebrow letterspacing', () => {
  // Finding home-ar-loading: an Arabic section label carried the Latin
  // uppercase letter-spacing and broke apart mid-word ('ال جلسا ت').
  it.each([false, true])('keeps the eyebrow display treatment in LTR only (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const classes = hostClasses(mount(createElement(Text, { variant: 'eyebrow' }, 'Live now')));
    expect(classes).toEqual(
      expect.arrayContaining(['font-mono-medium', 'text-[10px]', 'text-muted-foreground'])
    );
    if (isRTL) {
      expect(classes).not.toContain('uppercase');
      expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
    } else {
      expect(classes).toEqual(expect.arrayContaining(['uppercase', 'tracking-[1.5px]']));
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
    const classes = hostClasses(
      mount(createElement(Eyebrow, null, isRTL ? 'الجلسات الجارية الآن' : 'LIVE NOW'))
    );
    expect(classes).toEqual(expect.arrayContaining(['font-mono-medium', 'text-[10px]']));
    if (isRTL) {
      expect(classes).not.toContain('uppercase');
      expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
    } else {
      expect(classes).toEqual(expect.arrayContaining(['uppercase', 'tracking-[1.5px]']));
    }
  });
});
