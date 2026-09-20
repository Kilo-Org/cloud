/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native style regression tests. */
// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement } from 'react';
import { type TextStyle } from 'react-native';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      { letterSpacing: 0 },
      { writingDirection: 'rtl' },
    ]);
  });

  it('keeps Latin tracking in a right-to-left interface', () => {
    i18nManager.isRTL = true;
    const styles = ownStyles(mount('Preferences'));
    expect(styles).toContainEqual({ writingDirection: 'rtl' });
    expect(styles.some(style => 'letterSpacing' in style)).toBe(false);
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
