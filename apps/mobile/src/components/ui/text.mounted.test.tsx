/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native style regression tests. */
// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement, type ReactElement } from 'react';
import { type TextStyle } from 'react-native';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from './eyebrow';
import { Text } from './text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(children: string, style?: TextStyle, className = 'tracking-wide') {
  act(() => {
    renderer = TestRenderer.create(createElement(Text, { className, style }, children));
  });
  if (!renderer) {
    throw new Error('Missing Text renderer');
  }
  return renderer.root.find(node => Object.is(node.type, 'Text'));
}

/** The component's own inline styles, flattened the way React Native merges them. */
function ownStyles(node: TestRenderer.ReactTestInstance): TextStyle[] {
  const { style } = node.props;
  const entries = Array.isArray(style) ? (style as unknown[]).flat(Infinity) : [style];
  return entries.filter((entry): entry is TextStyle => typeof entry === 'object' && entry !== null);
}

/** The letter spacing a React Native style array resolves to: the last entry wins. */
function resolvedLetterSpacing(styles: TextStyle[]): TextStyle['letterSpacing'] {
  return styles.findLast(style => 'letterSpacing' in style)?.letterSpacing;
}

/** What the app's own Tailwind + react-native-css compile a tracking class to. */
async function compiledLetterSpacing(className: string): Promise<number> {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${className}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  const declarations =
    rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
  const value = declarations
    .map(declaration => declaration as { letterSpacing?: unknown })
    .findLast(declaration => typeof declaration.letterSpacing === 'number')?.letterSpacing;
  if (typeof value !== 'number') {
    throw new TypeError(`${className} did not compile to a letter spacing`);
  }
  return value;
}

function mountElement(element: ReactElement) {
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

describe('Text joined-script letter spacing', () => {
  it('keeps Latin tracking in a left-to-right interface', () => {
    const node = mount('Preferences');
    expect(node.props.className).toContain('tracking-wide');
    expect(ownStyles(node)).toEqual([]);
  });

  it('resets the tracking on an Arabic run in a left-to-right interface', () => {
    expect(ownStyles(mount('التفصيلات'))).toEqual([{ letterSpacing: 0 }]);
  });

  it('adds the RTL paragraph direction beside the reset on an Arabic run', () => {
    i18nManager.isRTL = true;
    expect(ownStyles(mount('أعلام المميزات'))).toEqual([
      { writingDirection: 'rtl' },
      { letterSpacing: 0 },
    ]);
  });

  it('resets the tracking in a right-to-left interface whatever the script', () => {
    i18nManager.isRTL = true;
    const styles = ownStyles(mount('Preferences'));
    expect(styles).toContainEqual({ writingDirection: 'rtl' });
    expect(styles).toContainEqual({ letterSpacing: 0 });
  });

  it('lets an explicit caller letterSpacing win over the reset', () => {
    const styles = ownStyles(mount('المظهر', { letterSpacing: 2 }));
    expect(styles.at(-1)).toEqual({ letterSpacing: 2 });
  });

  it('overrides the tracking the app compiles, on a joined run only', async () => {
    const tracking = await compiledLetterSpacing('tracking-[1.5px]');
    expect(tracking).toBeGreaterThan(0);

    const latin = mount('Settings', undefined, 'tracking-[1.5px]');
    const arabic = mount('التفصيلات', undefined, 'tracking-[1.5px]');

    expect(resolvedLetterSpacing([{ letterSpacing: tracking }, ...ownStyles(latin)])).toBe(
      tracking
    );
    expect(resolvedLetterSpacing([{ letterSpacing: tracking }, ...ownStyles(arabic)])).toBe(0);
  });
});

describe('Text mounted letter spacing', () => {
  it.each([false, true])('clears the tracking for Arabic children with isRTL=%s', isRTL => {
    i18nManager.isRTL = isRTL;
    const text = hostText(
      mountElement(createElement(Text, { className: 'tracking-[1.5px]' }, 'الجلسات الجارية الآن'))
    );

    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('leaves Latin children untouched and keeps LTR style undefined', () => {
    const text = hostText(
      mountElement(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toBeUndefined();
  });

  it('clears the tracking of the eyebrow variant for Arabic children', () => {
    const text = hostText(mountElement(createElement(Text, { variant: 'eyebrow' }, 'عرض الكل')));

    expect(text.props.className as string).toContain('tracking-[1.5px]');
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('clears the tab label tracking for Arabic children', () => {
    const text = hostText(
      mountElement(createElement(Text, { className: 'tracking-[0.2px]' }, 'الرئيسية'))
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
      mountElement(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
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
    const classes = hostClasses(
      mountElement(createElement(Text, { variant: 'eyebrow' }, 'Live now'))
    );
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
    const classes = hostClasses(mountElement(createElement(Text, null, 'Live now')));
    expect(classes).not.toContain('uppercase');
    expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
  });

  it.each([false, true])('applies the same rule to the Eyebrow component (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const classes = hostClasses(
      mountElement(createElement(Eyebrow, null, isRTL ? 'الجلسات الجارية الآن' : 'LIVE NOW'))
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
