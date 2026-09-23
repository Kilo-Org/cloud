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
