// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement, type ReactElement, useState } from 'react';
import { Text as NativeText, Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Button,
  BUTTON_BUSY_LABEL_CLASS,
  BUTTON_BUSY_OVERLAY_CLASS,
  type ButtonProps,
} from './button';
import { Text } from './text';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#123456',
    primary: '#345678',
    primaryForeground: '#abcdef',
  }),
}));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing Button renderer');
  }
  return renderer.root.findByType(Pressable);
}

const busyWrappers = (node: TestRenderer.ReactTestInstance) =>
  node.findAll(n => `${n.props.className ?? ''}`.startsWith(BUTTON_BUSY_LABEL_CLASS));

function renderButton({
  children = createElement(Text, null, 'Retry'),
  ...props
}: ButtonProps = {}) {
  return render(createElement(Button, { accessibilityLabel: 'Retry', ...props }, children));
}

async function nativeDimensions(button: TestRenderer.ReactTestInstance) {
  const dimensions = (button.props.className as string)
    .split(' ')
    .filter(className => /^(?:min-h|h|w)-/.test(className))
    .join(' ');
  // Use the app's theme and installed compilers, not a hand-written utility-to-point map.
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${dimensions}; }`,
    { from: import.meta.filename }
  );
  // Match metro.config.js. The compiler keeps its default 14-point inlineRem.
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  return rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []);
}

/** The native style a single className compiles to, through the app's pipeline. */
async function compiledStyles(className: string) {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${className}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  return rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('Button native target contract', () => {
  // These assertions protect compiled host dimensions; native F2 must still measure the target.
  it.each([undefined, 'default', 'lg'] as const)(
    'keeps a 44-point minimum without fixing the height for size %s',
    async size => {
      const button = renderButton({ size, variant: 'outline' });
      expect(await nativeDimensions(button)).toEqual([{ minHeight: 44 }]);
      expect(button.props.hitSlop).toBeUndefined();
    }
  );

  it('keeps a 36-point compact minimum plus four-point hitSlop on every edge', async () => {
    const button = renderButton({ size: 'sm' });
    expect(await nativeDimensions(button)).toEqual([{ minHeight: 36 }]);
    expect(button.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
  });

  it('keeps an icon target 44 points wide and tall without requiring label content', async () => {
    const button = renderButton({ size: 'icon', children: null, accessibilityLabel: 'Close' });
    expect(await nativeDimensions(button)).toEqual([{ height: 44, width: 44 }]);
    expect(button.props.role).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Close');
  });

  it.each([0, { top: 8, bottom: 6, left: 5, right: 7 }])(
    'preserves explicit compact hitSlop %j',
    hitSlop => {
      expect(renderButton({ size: 'sm', hitSlop }).props.hitSlop).toEqual(hitSlop);
    }
  );

  it.each([
    'default',
    'destructive',
    'outline',
    'secondary',
    'ghost',
    'link',
    'accent-soft',
  ] as const)(
    'keeps the %s label and control identity while loading disables interaction',
    variant => {
      const button = renderButton({
        variant,
        loading: true,
        disabled: false,
        accessibilityState: { selected: true },
      });
      const label = button.findByType(NativeText);
      expect(label.children).toEqual(['Retry']);
      expect(button.props.role).toBe('button');
      expect(button.props.accessibilityLabel).toBe('Retry');
      expect(button.props.disabled).toBe(true);
      expect(button.props.accessibilityState).toEqual({
        selected: true,
        disabled: true,
        busy: true,
      });
      expect(button.findByType(ActivityIndicator).props.size).toBe('small');

      const ready = renderButton({
        variant,
        loading: false,
        accessibilityState: { selected: true },
      });
      expect(ready).toBe(button);
      expect(ready.findByType(NativeText)).toBe(label);
      expect(label.children).toEqual(['Retry']);
      expect(ready.findAllByType(ActivityIndicator)).toHaveLength(0);
      expect(ready.props.disabled).toBe(false);
      expect(ready.props.accessibilityState).toEqual({
        selected: true,
        disabled: false,
        busy: false,
      });
    }
  );

  it('names a loading button from its visible text so the settled state reads the label again', () => {
    // No caller label: Button derives one from the child text, so the
    // `busy: true → false` transition rewrites the Android node's accessible
    // name from the busy state back to the visible label. Passing
    // `accessibilityLabel: undefined` overrides the default renderButton label
    // so these assertions only pass when the derivation itself runs.
    const busy = renderButton({ loading: true, accessibilityLabel: undefined });
    expect(busy.props.accessibilityLabel).toBe('Retry');

    const ready = renderButton({ loading: false, accessibilityLabel: undefined });
    expect(ready.props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
    expect(ready.props.accessibilityLabel).toBe('Retry');

    // An explicit caller label always wins.
    const named = renderButton({ loading: true, accessibilityLabel: 'Retry request' });
    expect(named.props.accessibilityLabel).toBe('Retry request');

    // A button that never opted into loading is untouched: no derived label.
    const plain = renderButton({ accessibilityLabel: undefined });
    expect(plain.props.accessibilityLabel).toBeUndefined();
  });

  it('does not name an icon-only loading button from its non-text children', () => {
    const button = renderButton({
      size: 'icon',
      children: null,
      loading: true,
      accessibilityLabel: undefined,
    });
    expect(button.props.accessibilityLabel).toBeUndefined();
  });

  it('replaces the label with a centred spinner and keeps the label in layout', async () => {
    const label = renderButton({ loading: false }).findByType(NativeText);
    const button = renderButton({ loading: true });
    // The label stays in the row, so a content-sized button keeps exactly the
    // width its label needs and nothing shifts when the request starts.
    expect(button.findByType(NativeText)).toBe(label);
    const wrappers = busyWrappers(button);
    expect(wrappers[0]?.props.className).toContain('opacity-0');
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]?.props.accessibilityElementsHidden).toBe(true);
    expect(wrappers[0]?.props.importantForAccessibility).toBe('no-hide-descendants');
    // The spinner is out of flow, so it adds no width of its own and sits on
    // the button's centre rather than beside the label.
    const spinner = button.findByType(ActivityIndicator);
    expect(spinner.props.size).toBe('small');
    expect(spinner.parent?.props.className).toBe(BUTTON_BUSY_OVERLAY_CLASS);
    const overlayStyles = await compiledStyles(BUTTON_BUSY_OVERLAY_CLASS);
    expect(overlayStyles).toContainEqual(expect.objectContaining({ position: 'absolute' }));

    // The wrapper and the label are the same elements once loading ends; only
    // the opacity, the accessibility hiding and the indicator change.
    const ready = renderButton({ loading: false });
    expect(ready.findByType(NativeText)).toBe(label);
    expect(ready.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(busyWrappers(ready)).toHaveLength(1);
    expect(busyWrappers(ready)[0]?.props.className).not.toContain('opacity-0');
  });

  it('leaves a button that never loads without a busy wrapper', () => {
    const button = renderButton({});
    expect(busyWrappers(button)).toHaveLength(0);
    expect(button.findAllByProps({ className: BUTTON_BUSY_OVERLAY_CLASS })).toHaveLength(0);
    expect(button.findByType(NativeText).children).toEqual(['Retry']);
  });

  it.each(['Retry', 3])('wraps a bare %p child in the themed label Text', child => {
    // Pressable is a View: a raw scalar child draws nothing on device, so the
    // button collapses to padding while the accessibility tree still names it.
    const button = renderButton({ children: child });
    const label = button.findByType(NativeText);
    // Test renderer stringifies a number child; the host text is identical.
    expect(label.children).toEqual([String(child)]);
    // The wrapped label carries the button's themed label classes, not the
    // plain Text default (variant ink varies, so assert the shared base).
    expect(label.props.className).toContain('font-semibold');
    expect(label.props.className).toContain('text-sm');
  });

  it('leaves element children unwrapped', () => {
    const button = renderButton({
      children: createElement(View, null, 'Retry'),
    });
    // No themed label Text is added around an element the caller provided.
    expect(button.findAllByType(NativeText)).toHaveLength(0);
  });

  it('wraps scalar entries of an array while skipping whitespace-only strings', () => {
    // Mixed icon-plus-label callers pass arrays; a JSX `{' '}` separator between
    // them draws nothing in a View today and the row gap does the spacing, so
    // it must not start rendering inside a Text.
    const button = renderButton({
      children: [createElement(View, { key: 'i' }), '  ', 'Save', 7],
    });
    const labels = button.findAllByType(NativeText);
    expect(labels).toHaveLength(2);
    expect(labels[0]?.props.children).toBe('Save');
    expect(labels[1]?.props.children).toBe(7);
  });

  it('keeps an explicitly disabled control disabled after loading ends', () => {
    renderButton({ disabled: true, loading: true });
    const button = renderButton({ disabled: true, loading: false });
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(button.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(button.findByType(NativeText).children).toEqual(['Retry']);
  });

  it('keeps a disabled primary label legible instead of dimming the brand pair', () => {
    const button = renderButton({ disabled: true });
    const classes = (button.props.className as string).split(' ');
    // bg-primary-disabled must win over the variant's bg-primary so the disabled
    // fill is the muted surface the ink label stays readable on.
    expect(classes).toContain('bg-primary-disabled');
    expect(classes).not.toContain('bg-primary');
    expect(classes).not.toContain('opacity-50');
    // The label keeps the ink colour; the disabled fill is chosen to contrast
    // with it, so hard-coded primaryForeground children stay legible too.
    const label = button.findByType(NativeText).props.className as string;
    expect(label).toContain('text-primary-foreground');
    expect(label).not.toContain('text-muted-foreground');
  });

  it('keeps a hard-coded primaryForeground child on a fill that contrasts with it', () => {
    const button = renderButton({
      disabled: true,
      children: createElement(Text, { className: 'text-primary-foreground' }, 'Save'),
    });
    const classes = (button.props.className as string).split(' ');
    expect(classes).toContain('bg-primary-disabled');
    expect(classes).not.toContain('bg-muted');
    expect(button.findByType(NativeText).props.className).toContain('text-primary-foreground');
  });

  it('keeps a busy primary on its brand fill so it still reads as working', () => {
    const button = renderButton({ loading: true });
    const classes = (button.props.className as string).split(' ');
    expect(classes).toContain('bg-primary');
    expect(classes).not.toContain('bg-primary-disabled');
    expect(classes).not.toContain('opacity-50');
  });

  it('centers the label so a wrapped label stays under its own lines', () => {
    // Android can paint a wrapped label even when the layout reports one line;
    // centered text keeps the wrapped lines aligned under each other instead
    // of hanging from the start edge. Single-line labels are unaffected.
    const label = renderButton({ variant: 'outline' }).findByType(NativeText);
    expect((label.props.className as string).split(' ')).toContain('text-center');
  });

  it('keeps the dimmed treatment for a disabled non-primary variant', () => {
    const button = renderButton({ variant: 'outline', disabled: true });
    const classes = (button.props.className as string).split(' ');
    expect(classes).toContain('opacity-50');
    expect(classes).not.toContain('bg-primary-disabled');
  });

  it('keeps an enabled action connected to its visible outcome', () => {
    function Action() {
      const [started, setStarted] = useState(false);
      return createElement(
        Button,
        {
          onPress: () => {
            setStarted(true);
          },
        },
        createElement(Text, null, started ? 'Started' : 'Start')
      );
    }
    const button = render(createElement(Action));
    expect(button.props.disabled).toBe(false);
    expect(button.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(button.findByType(NativeText).children).toEqual(['Start']);
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(button.findByType(NativeText).children).toEqual(['Started']);
  });
});
