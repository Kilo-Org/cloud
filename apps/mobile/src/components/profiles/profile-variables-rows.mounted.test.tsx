// The profile Variables row must keep a long key's distinguishing suffix: keys
// in one profile share long prefixes, so React Native's default tail ellipsis
// made neighbouring rows look identical at a compact width.
import { createElement } from 'react';
// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SECRET_MASK, type VariableRow } from '@/components/profiles/profile-variables-model';
import { VariableRowView } from '@/components/profiles/profile-variables-rows';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  Eye: 'Eye',
  EyeOff: 'EyeOff',
  Lock: 'Lock',
  Trash2: 'Trash2',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

/** Longer than a compact row's key column, as profile keys commonly are. */
const LONG_KEY = 'ROTATION_DRAFT_KEPT_R3';

const ROW: VariableRow = {
  key: LONG_KEY,
  value: '***',
  isSecret: true,
  maskedValue: SECRET_MASK,
};

describe('variable row key truncation', () => {
  it('truncates the key in the middle so a shared prefix cannot hide the suffix', async () => {
    const mounted = await renderWithProviders(createElement(VariableRowView, { row: ROW }));
    const key = mounted.renderer.root.findAll(
      node => String(node.type) === 'Text' && node.props.children === LONG_KEY
    )[0];
    if (key === undefined) {
      throw new Error('The variable key did not mount as one text node');
    }
    expect(key.props.numberOfLines).toBe(1);
    expect(key.props.ellipsizeMode).toBe('middle');
  });
});

// The placeholder must never ellipsize: a cut dot run reads as a truncated
// value and ends short of where a plain value's column ends.
describe('variable row secret mask', () => {
  it('renders the fixed placeholder with no width cap and no line limit', async () => {
    const mounted = await renderWithProviders(createElement(VariableRowView, { row: ROW }));
    const mask = mounted.renderer.root.findAll(
      node => String(node.type) === 'Text' && node.props.children === SECRET_MASK
    )[0];
    if (mask === undefined) {
      throw new Error('The variable mask did not mount as one text node');
    }
    expect(mask.props.numberOfLines).toBeUndefined();
    expect(mask.props.ellipsizeMode).toBeUndefined();
  });
});

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

// Flexbox decides which of the two texts keeps its characters, so these tests
// compile the row's classes with the app's own theme and compiler and assert the
// resolved native styles: the key starts at its natural width and the value is
// the box that gives width up.
async function nativeStyle(className: string) {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${className}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  const declarations = rules
    ?.find(([name]) => name === 'target')?.[1]
    .flatMap(rule => rule.d ?? []);
  return Object.assign({}, ...(declarations ?? [])) as Record<string, unknown>;
}

const VALUE = 'postgresql://reporting-replica.internal.example.com/app';

const VALUE_ROW: VariableRow = {
  key: LONG_KEY,
  value: VALUE,
  isSecret: false,
  maskedValue: VALUE,
};

function classNameOf(mounted: RenderWithProvidersResult, text: string) {
  const node = mounted.renderer.root.findAll(
    candidate => String(candidate.type) === 'Text' && candidate.props.children === text
  )[0];
  if (node === undefined) {
    throw new Error(`The text ${text} did not mount`);
  }
  const className = node.props.className;
  if (typeof className !== 'string') {
    throw new TypeError(`The text ${text} has no class list`);
  }
  return className;
}

describe('variable row text priority', () => {
  it('keeps the key at its natural width and lets the value shrink instead', async () => {
    const mounted = await renderWithProviders(createElement(VariableRowView, { row: VALUE_ROW }));
    const key = await nativeStyle(classNameOf(mounted, LONG_KEY));
    expect(key).toMatchObject({ flexShrink: 0, maxWidth: '100%' });
    // A zero flex basis is what made the key give width to the value before: the
    // key must be measured at its own width, not grown into a share of the row.
    expect(key.flexBasis).toBeUndefined();

    const value = await nativeStyle(classNameOf(mounted, VALUE));
    expect(value).toMatchObject({ flexShrink: 1 });
    // A fixed share of the row belonged to the value before: it must be free to
    // take whatever the key leaves, however little that is.
    expect(value.maxWidth).toBeUndefined();
  });

  it('makes the key yield to the fixed-width mask instead', async () => {
    const mounted = await renderWithProviders(createElement(VariableRowView, { row: ROW }));
    const key = await nativeStyle(classNameOf(mounted, LONG_KEY));
    expect(key).toMatchObject({ flexShrink: 1 });

    const maskRow = mounted.renderer.root.findAll(
      node =>
        String(node.type) === 'View' &&
        typeof node.props.className === 'string' &&
        node.props.className.split(' ').includes('shrink-0')
    )[0];
    if (maskRow === undefined) {
      throw new Error('The mask did not mount in a fixed-width wrapper');
    }
    expect(await nativeStyle(maskRow.props.className as string)).toMatchObject({ flexShrink: 0 });
  });
});
