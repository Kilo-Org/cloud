/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
// eslint-disable-next-line import/no-nodejs-modules -- The compiler's CommonJS export is the only way to load it under vitest.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement } from 'react';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Globe } from '@/components/ui/icons';
import { act, TestRenderer } from '@/test/renderer';

import { ConfigureRow } from './configure-row';

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

/** The compiled declarations of one className, through the app's own pipeline. */
async function compiledDeclarations(classes: string): Promise<unknown[]> {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${classes}; }`,
    { from: import.meta.filename }
  );
  return (
    compile(css, { inlineVariables: false })
      .stylesheet()
      .s?.find(([name]) => name === 'target')?.[1]
      .flatMap(rule => rule.d ?? []) ?? []
  );
}

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => windowDims,
}));
vi.mock('@/components/ui/icons', () => ({ Globe: 'Globe' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'ChevronRight',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    secondaryForeground: '#F2F0EB',
    mutedForeground: '#8A8680',
    destructive: '#F28B7A',
  }),
}));

/**
 * The account settings list (Language / Trusted hosts / Passkeys / Device
 * sessions) once hashed each row title into the agent hue ramp, so the list
 * showed three different accent tints (olive, blue, purple). Passkeys and
 * Device sessions collided on the same hue, so a test over three titles could
 * pass while a fourth row still rendered a hashed tint — every account row is
 * named here.
 */
const ACCOUNT_ROW_TITLES = ['Language', 'Trusted hosts', 'Passkeys', 'Device sessions'];

/** The Preferences hub rows all render through this same component. */
const PREFERENCES_HUB_ROW_TITLES = [
  'General',
  'Voice input',
  'Translate tool summaries',
  'Account',
  'Notifications',
];

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(
  props: {
    title?: string;
    tone?: 'good' | 'warn' | 'danger';
    disabled?: boolean;
    /** `false` renders the inert row a display-only row is: no Pressable at all. */
    pressable?: boolean;
    note?: string;
  } = {}
) {
  act(() => {
    const element = createElement(ConfigureRow, {
      icon: Globe,
      title: props.title ?? 'General',
      subtitle: 'Transcribe',
      ...(props.pressable === false ? {} : { onPress: () => undefined }),
      ...(props.tone === undefined ? {} : { tone: props.tone }),
      ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
      ...(props.note === undefined ? {} : { note: props.note }),
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ConfigureRow renderer');
  }
  return renderer.root;
}

/** The classes of the row body: the one View that carries the row padding. */
function rowClasses(root: TestRenderer.ReactTestInstance): string[] {
  const body = root.find(
    node => Object.is(node.type, 'View') && String(node.props.className).includes('py-3')
  );
  return String(body.props.className).split(' ');
}

/** The shared icon tile and its stroke for the mounted row. */
function tileOf(root: TestRenderer.ReactTestInstance): {
  tileClassName: string;
  iconColor: string;
} {
  const tile = root.find(
    node =>
      typeof node.props.className === 'string' && node.props.className.includes('h-[30px] w-[30px]')
  );
  const icon = root.find(node => Object.is(node.type, 'Globe'));
  return {
    tileClassName: tile.props.className as string,
    iconColor: icon.props.color as string,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  windowDims.width = 390;
  windowDims.fontScale = 1;
});

describe('ConfigureRow mounted layout', () => {
  // A 160 dp window leaves the text block between the icon tile and the
  // chevron too little room for one word, and Android broke it mid-word
  // ("Gene ral" / "Trans cribe", e1-settings, 2026-09-21). Stacking hands the
  // title and subtitle the row's full width.
  it('stacks the icon above the title in a narrow window', () => {
    windowDims.width = 160;
    const classes = rowClasses(renderRow());
    expect(classes).toEqual(expect.arrayContaining(['gap-2', 'py-3']));
    expect(classes).not.toContain('flex-row');
  });

  it('keeps the icon and trailing control on one line at phone widths', () => {
    const root = renderRow();
    const classes = rowClasses(root);
    // The note renders below the icon-aligned line, so the padded row body is a
    // column and that inner line carries the side-by-side geometry.
    expect(classes).toEqual(expect.arrayContaining(['py-3']));
    expect(classes).not.toContain('gap-2');
    expect(classes).not.toContain('flex-row');
    const line = root.find(
      node => Object.is(node.type, 'View') && String(node.props.className).includes('flex-row')
    );
    expect(String(line.props.className).split(' ')).toEqual(
      expect.arrayContaining(['flex-row', 'items-center', 'gap-3'])
    );
  });

  it('still stacks at the large-font-scale threshold', () => {
    windowDims.fontScale = 1.8;
    expect(rowClasses(renderRow())).not.toContain('flex-row');
  });
});

describe('ConfigureRow icon tile', () => {
  it.each(ACCOUNT_ROW_TITLES)('gives the %s account row the shared neutral tile', title => {
    const row = tileOf(renderRow({ title }));

    expect(row.tileClassName).toContain('bg-hair-soft');
    expect(row.tileClassName).toContain('border-border');
    expect(row.tileClassName).not.toContain('agent-');
    expect(row.iconColor).toBe('#F2F0EB');
  });

  it('gives the account and Preferences hub rows one identical tile', () => {
    const tiles = [...ACCOUNT_ROW_TITLES, ...PREFERENCES_HUB_ROW_TITLES].map(
      title => tileOf(renderRow({ title })).tileClassName
    );

    expect(new Set(tiles).size).toBe(1);
  });

  it('still lets a semantic tone override the neutral tile', () => {
    const neutral = tileOf(renderRow({ title: 'Language' }));
    const danger = tileOf(renderRow({ title: 'Language', tone: 'danger' }));

    expect(danger.tileClassName).toContain('bg-danger-tile-bg');
    expect(danger.iconColor).toBe('#F28B7A');
    expect(danger.iconColor).not.toBe(neutral.iconColor);
  });
});

/** The mounted text node carrying `content`. */
function textOf(root: TestRenderer.ReactTestInstance, content: string): string[] {
  const node = root.find(
    candidate => Object.is(candidate.type, 'Text') && Object.is(candidate.props.children, content)
  );
  return String(node.props.className).split(' ');
}

describe('ConfigureRow disabled cue', () => {
  // Regression: a disabled row halved the entire row with `opacity-50` on top
  // of its already-muted subtitle, which lands that line at 2.15:1 on the dark
  // `bg-secondary` card and 1.95:1 on the light one — under the 3:1 floor, so a
  // row the user cannot open stopped being readable. The cue is the muted ink,
  // applied once; no row carries a second dim.
  it('dims a disabled row by token, never by row opacity', () => {
    expect(rowClasses(renderRow({ disabled: true }))).not.toContain('opacity-50');
    expect(rowClasses(renderRow())).not.toContain('opacity-50');
  });

  it('puts a disabled title on the muted ink and an enabled one on the foreground', () => {
    const disabled = textOf(renderRow({ disabled: true }), 'General');
    const enabled = textOf(renderRow(), 'General');

    expect(disabled).toContain('text-muted-foreground');
    expect(disabled).not.toContain('text-foreground');
    expect(enabled).toContain('text-foreground');
    expect(textOf(renderRow({ disabled: true }), 'Transcribe')).toContain('text-muted-foreground');
  });

  it('strokes a disabled icon with the muted ink and keeps the enabled one on its hue', () => {
    const disabled = tileOf(renderRow({ disabled: true }));
    const enabled = tileOf(renderRow());

    expect(disabled.iconColor).toBe('#8A8680');
    expect(enabled.iconColor).toBe('#F2F0EB');
    // The tile chrome is the row's own low-alpha tint in both states, so the
    // disabled row does not change size or band.
    expect(disabled.tileClassName).toBe(enabled.tileClassName);
  });

  it('keeps a disabled row non-tappable: no chevron and the disabled state', () => {
    const root = renderRow({ disabled: true });

    expect(root.findAllByType('ChevronRight' as never)).toHaveLength(0);
    expect(
      root.find(
        node => Object.is(node.type, 'Pressable') && node.props.accessibilityRole === 'button'
      ).props.accessibilityState
    ).toEqual({ disabled: true });
    expect(renderRow().findAllByType('ChevronRight' as never)).toHaveLength(1);
  });

  // The state belongs to the element that owns the accessible role. The inner
  // layout View has no role and is never a stop a reader reaches, so a state on
  // it announces disablement nowhere while making a second copy that can drift
  // from the Pressable's.
  it('declares the disabled state once, on the Pressable that owns the role', () => {
    const root = renderRow({ disabled: true });
    const withState = root.findAll(node => node.props.accessibilityState !== undefined);

    expect(withState).toHaveLength(1);
    expect(withState[0]?.type).toBe('Pressable');
    expect(withState[0]?.props.accessibilityRole).toBe('button');
  });

  it('declares no interactive state on an inert row', () => {
    const root = renderRow({ disabled: true, pressable: false });

    // No onPress means no Pressable: the row is one plain View, and it carries
    // no state of its own to announce from a node a reader never reaches.
    expect(root.findAllByType('Pressable' as never)).toHaveLength(0);
    expect(root.findAll(node => node.props.accessibilityState !== undefined)).toHaveLength(0);
  });
});

describe('ConfigureRow note', () => {
  const NOTE = 'Only organization owners and billing managers can change this connection.';

  it('renders the note below the icon-aligned line, inset to the title column', async () => {
    const root = renderRow({ note: NOTE });

    expect(textOf(root, NOTE)).toEqual(
      expect.arrayContaining(['mt-1', 'text-xs', 'text-muted-foreground'])
    );
    // The inset is the start edge (the tile's 30 dp plus the row's gap), so the
    // note keeps to the title's column when the row mirrors.
    const note = root.find(
      node => Object.is(node.type, 'Text') && Object.is(node.props.children, NOTE)
    );
    // The inset must compile to the START edge, not the left one: the row's
    // icon tile and title column move to the physical right under RTL, so a
    // `pl-` utility would put the note under the tile there.
    expect(await compiledDeclarations('ps-[40.5px]')).toContainEqual({ paddingInlineStart: 40.5 });
    expect(await compiledDeclarations('pl-[40.5px]')).toContainEqual({ paddingLeft: 40.5 });
    // It is a sentence, so it wraps instead of ellipsizing like a value does.
    expect(note.props.numberOfLines).toBe(3);
    expect(textOf(root, 'Transcribe')).toContain('mt-0.5');
    // A third line inside the title column would centre the tile on
    // title+subtitle+note and drop the icon of a row that carries one.
    const textBlock = root.find(
      node => Object.is(node.type, 'View') && String(node.props.className).includes('min-w-0')
    );
    expect(textBlock.findAll(node => Object.is(node.props.children, NOTE))).toHaveLength(0);
  });

  it('drops the inset when the row stacks, where the note takes the full width', () => {
    windowDims.width = 160;
    const root = renderRow({ note: NOTE });

    expect(
      String(
        root.find(node => Object.is(node.type, 'Text') && Object.is(node.props.children, NOTE))
          .props.className
      )
    ).not.toContain('ps-[40.5px]');
  });

  it('renders only the title and subtitle when a row has no note', () => {
    expect(renderRow().findAll(node => Object.is(node.type, 'Text'))).toHaveLength(2);
  });
});
