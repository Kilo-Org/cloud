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
  // The reset belongs to the RTL interface: RTL-script copy takes it there,
  // while a joined script in an LTR screen keeps the tracking its class asks
  // for (`text.rtl-labels` pins that LTR case).
  it.each([false, true])(
    'resets the tracking for Arabic children in RTL only (isRTL=%s)',
    isRTL => {
      i18nManager.isRTL = isRTL;
      const text = hostText(
        mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'الجلسات الجارية الآن'))
      );

      if (isRTL) {
        expect(text.props.style).toContainEqual({ letterSpacing: 0 });
      } else {
        expect(text.props.style).toBeUndefined();
      }
    }
  );

  it('leaves Latin children untouched and keeps LTR style undefined', () => {
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toBeUndefined();
  });

  it('resets the eyebrow variant tracking for Arabic children in RTL', () => {
    i18nManager.isRTL = true;
    const text = hostText(mount(createElement(Text, { variant: 'eyebrow' }, 'عرض الكل')));

    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('resets the tab label tracking for Arabic children in RTL', () => {
    i18nManager.isRTL = true;
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[0.2px]' }, 'الرئيسية'))
    );

    expect(text.props.className as string).toContain('tracking-[0.2px]');
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  // An RTL interface keeps the paragraph direction for a Latin run and leaves
  // its tracking alone: the reset is for RTL-script copy (`text.rtl-labels`).
  it('keeps the RTL paragraph direction and no reset for Latin children', () => {
    i18nManager.isRTL = true;
    const text = hostText(
      mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toContainEqual({ writingDirection: 'rtl' });
    expect(text.props.style).not.toContainEqual({ letterSpacing: 0 });
  });
});

describe('Text eyebrow letterspacing', () => {
  // Finding home-ar-loading: an Arabic section label carried the Latin
  // uppercase letter-spacing and broke apart mid-word ('ال جلسا ت'). The
  // display treatment is dropped for RTL-script copy (Arabic, Hebrew) in an
  // RTL interface.
  it.each([false, true])('keeps the eyebrow display treatment for Latin copy (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const classes = hostClasses(mount(createElement(Text, { variant: 'eyebrow' }, 'Live now')));
    expect(classes).toEqual(
      expect.arrayContaining([
        'font-mono-medium',
        'text-[10px]',
        'text-muted-foreground',
        'uppercase',
        'tracking-[1.5px]',
      ])
    );
  });

  it.each([false, true])('drops the treatment from Arabic copy in RTL (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const classes = hostClasses(
      mount(createElement(Text, { variant: 'eyebrow' }, 'الجلسات الجارية الآن'))
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
    expect(classes).toEqual(expect.arrayContaining(['text-[10px]']));
    if (isRTL) {
      // Arabic copy in an RTL interface also drops the mono family.
      expect(classes.some(name => name.startsWith('font-mono'))).toBe(false);
      expect(classes).not.toContain('uppercase');
      expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
    } else {
      expect(classes).toEqual(
        expect.arrayContaining(['font-mono-medium', 'uppercase', 'tracking-[1.5px]'])
      );
    }
  });
});
