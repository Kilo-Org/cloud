/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native style regression tests. */
import { createElement } from 'react';
import { type TextStyle } from 'react-native';
import { type ReactTestInstance } from '@/test/renderer';
import { compileClassName } from '@/test/native-dimensions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from './eyebrow';
import { Text } from './text';
import { hostText, mountTextTree, unmountTextTree } from './text.mounted.test-helpers';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

/** The suite's own mount: the shared tree, wrapped in the tracked class it asserts on. */
function mount(children: string, style?: TextStyle, className = 'tracking-wide') {
  return hostText(mountTextTree(createElement(Text, { className, style }, children)));
}

/** The component's own inline styles, flattened the way React Native merges them. */
function ownStyles(node: ReactTestInstance): TextStyle[] {
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
  const declarations = await compileClassName(className);
  const value = declarations
    .map(declaration => declaration as { letterSpacing?: unknown })
    .findLast(declaration => typeof declaration.letterSpacing === 'number')?.letterSpacing;
  if (typeof value !== 'number') {
    throw new TypeError(`${className} did not compile to a letter spacing`);
  }
  return value;
}

/** The resolved class list of the host `Text`. */
function hostClasses(root: ReactTestInstance): string[] {
  return String(hostText(root).props.className).split(' ');
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});

afterEach(() => {
  unmountTextTree();
});

// The reset belongs to the script, not the interface: a joined script takes it
// in either direction, and an RTL interface resets its RTL-script copy as well
// (the `NATURAL_LETTER_SPACING` rule in `Text`).
describe('Text joined-script letter spacing', () => {
  it('keeps Latin tracking in a left-to-right interface', () => {
    const node = mount('Preferences');
    expect(node.props.className).toContain('tracking-wide');
    expect(ownStyles(node)).toEqual([]);
  });

  it('adds the RTL paragraph direction beside the reset on an Arabic run', () => {
    i18nManager.isRTL = true;
    expect(ownStyles(mount('أعلام المميزات'))).toEqual([
      { writingDirection: 'rtl' },
      { letterSpacing: 0 },
    ]);
  });

  it('lets an explicit caller letterSpacing win over the reset', () => {
    i18nManager.isRTL = true;
    const styles = ownStyles(mount('المظهر', { letterSpacing: 2 }));
    expect(styles.at(-1)).toEqual({ letterSpacing: 2 });
  });

  it.each([false, true])(
    'overrides the tracking the app compiles, on a joined run (isRTL=%s)',
    async isRTL => {
      const tracking = await compiledLetterSpacing('tracking-[1.5px]');
      expect(tracking).toBeGreaterThan(0);

      i18nManager.isRTL = isRTL;
      // Each mount replaces the tracked renderer, so read the Latin tree before
      // the Arabic one takes its place.
      const latin = ownStyles(mount('Settings', undefined, 'tracking-[1.5px]'));
      const arabic = ownStyles(mount('التفصيلات', undefined, 'tracking-[1.5px]'));

      expect(resolvedLetterSpacing([{ letterSpacing: tracking }, ...latin])).toBe(tracking);
      expect(resolvedLetterSpacing([{ letterSpacing: tracking }, ...arabic])).toBe(0);
    }
  );
});

describe('Text mounted letter spacing', () => {
  // The reset belongs to the script: a joined script takes it in either
  // direction, and an RTL interface resets its RTL-script copy as well.
  it.each([false, true])('resets the tracking for Arabic children (isRTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const text = hostText(
      mountTextTree(createElement(Text, { className: 'tracking-[1.5px]' }, 'الجلسات الجارية الآن'))
    );

    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('leaves Latin children untouched and keeps LTR style undefined', () => {
    const text = hostText(
      mountTextTree(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
    );

    expect(text.props.style).toBeUndefined();
  });

  it('resets the eyebrow variant tracking for Arabic children in RTL', () => {
    i18nManager.isRTL = true;
    const text = hostText(mountTextTree(createElement(Text, { variant: 'eyebrow' }, 'عرض الكل')));

    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it('resets the tab label tracking for Arabic children in RTL', () => {
    i18nManager.isRTL = true;
    const text = hostText(
      mountTextTree(createElement(Text, { className: 'tracking-[0.2px]' }, 'الرئيسية'))
    );

    expect(text.props.className as string).toContain('tracking-[0.2px]');
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  // An RTL interface keeps the paragraph direction for a Latin run and leaves
  // its tracking alone: the reset is for RTL-script copy (`text.rtl-labels`).
  it('keeps the RTL paragraph direction and no reset for Latin children', () => {
    i18nManager.isRTL = true;
    const text = hostText(
      mountTextTree(createElement(Text, { className: 'tracking-[1.5px]' }, 'Live now'))
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
    const classes = hostClasses(
      mountTextTree(createElement(Text, { variant: 'eyebrow' }, 'Live now'))
    );
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

  it.each([false, true])('drops the mono family from Arabic copy (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const node = hostText(
      mountTextTree(createElement(Text, { variant: 'eyebrow' }, 'الجلسات الجارية الآن'))
    );
    const classes = String(node.props.className).split(' ');

    // The mono family ships no Arabic glyph and the reset is the script's, so
    // both hold in either direction.
    expect(classes.some(name => name.startsWith('font-mono'))).toBe(false);
    expect(ownStyles(node)).toContainEqual({ letterSpacing: 0 });

    if (isRTL) {
      expect(classes).not.toContain('uppercase');
      expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
    } else {
      // The variant's own class stays on the element in an LTR interface and
      // the reset draws its tracking inert (NativeWind merges the class first).
      expect(classes).toEqual(expect.arrayContaining(['uppercase', 'tracking-[1.5px]']));
    }
  });

  it('leaves a non-eyebrow variant untouched in either direction', () => {
    i18nManager.isRTL = true;
    const classes = hostClasses(mountTextTree(createElement(Text, null, 'Live now')));
    expect(classes).not.toContain('uppercase');
    expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
  });

  it.each([false, true])('applies the same rule to the Eyebrow component (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const classes = hostClasses(
      mountTextTree(createElement(Eyebrow, null, isRTL ? 'الجلسات الجارية الآن' : 'LIVE NOW'))
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

// A heading reaches an assistive reader as a heading with its own level, and
// the two come from one entry per heading: neither can be announced without the
// other, and a non-heading variant announces neither.
describe('Text heading accessibility', () => {
  it.each([
    ['h1', '1'],
    ['h2', '2'],
    ['h3', '3'],
    ['h4', '4'],
  ] as const)('announces %s as a heading with level %s', (variant, level) => {
    const node = hostText(mountTextTree(createElement(Text, { variant }, 'Section')));

    expect(node.props.role).toBe('heading');
    expect(node.props['aria-level']).toBe(level);
  });

  it('leaves a non-heading variant without a heading role or level', () => {
    const node = hostText(mountTextTree(createElement(Text, { variant: 'muted' }, 'Note')));

    expect(node.props.role).toBeUndefined();
    expect(node.props['aria-level']).toBeUndefined();
  });
});

describe('Text mono variant in either interface', () => {
  // The mono variant carries a font that ships no RTL-script glyphs, so
  // RTL-script copy loses the family in either direction while a Latin run such
  // as a session id keeps it.
  it.each([false, true])('drops the mono family for an Arabic mono variant (RTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    const classes = hostClasses(
      mountTextTree(createElement(Text, { variant: 'mono' }, 'الجلسات الجارية الآن'))
    );

    expect(classes.some(name => name.startsWith('font-mono'))).toBe(false);
  });

  it('keeps the mono family for a session id in RTL', () => {
    i18nManager.isRTL = true;
    const classes = hostClasses(
      mountTextTree(createElement(Text, { variant: 'mono' }, 'ses_9f2c1a7b'))
    );

    expect(classes).toContain('font-mono-medium');
  });
});
