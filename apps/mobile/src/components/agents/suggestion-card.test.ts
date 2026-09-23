/* eslint-disable new-cap -- SuggestionCard is invoked as a plain function, matching repo test convention */
// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as React from 'react';
import type * as ReactI18next from 'react-i18next';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cn } from '@/lib/utils';

import { SuggestionCard } from './suggestion-card';

type CardProps = React.ComponentProps<typeof SuggestionCard>;
type Element = React.ReactElement<Record<string, unknown>>;

// `SuggestionCard` is a plain function whose only hooks are `useRef`/`useState`.
// These slots let a test invoke it twice (mount, then re-render) and read the
// state the accept/dismiss handlers wrote, without mounting React.
const refSlots = vi.hoisted(() => ({ slots: [] as { current: unknown }[], cursor: 0 }));
const stateSlots = vi.hoisted(() => ({ slots: [] as { value: unknown }[], cursor: 0 }));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useRef: <T>(initial: T) => {
      const index = refSlots.cursor;
      refSlots.cursor += 1;
      refSlots.slots[index] ??= { current: initial };
      return refSlots.slots[index] as { current: T };
    },
    useState: <T>(initial: T) => {
      const index = stateSlots.cursor;
      stateSlots.cursor += 1;
      const slot = (stateSlots.slots[index] ??= { value: initial as unknown });
      return [
        slot.value as T,
        (next: T | ((previous: T) => T)) => {
          slot.value =
            typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next;
        },
      ] as [T, (value: T | ((previous: T) => T)) => void];
    },
  };
});

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }),
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@/components/ui/icons', () => ({ Sparkles: 'Sparkles', X: 'X' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

// The row no longer scrolls, so a model-generated label wider than the card has
// no scroll recovery path. These tests compile the classes with the app's own
// theme and compiler, so they assert the native styles that keep the button
// inside the row and let the label shrink and wrap instead of overflowing.
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

const text = 'Review the new parseDuration implementation and tests.';
const actions: CardProps['actions'] = [
  {
    label: 'Review',
    description: 'Inspect every changed file.\nDo not edit.',
    prompt: '/review',
  },
  { label: 'Test', prompt: 'Run the tests' },
];

function renderCard(props: CardProps): Element {
  refSlots.cursor = 0;
  stateSlots.cursor = 0;
  return SuggestionCard(props) as Element;
}

function childrenOf(element: Element): Element[] {
  const children = element.props.children;
  // `{actions.map(...)}` sits in the tree as one nested array, so flatten the
  // list before exposing individual elements to a test.
  return (Array.isArray(children) ? children.flat() : [children]) as Element[];
}

function requireChild(element: Element | undefined, what: string): Element {
  if (!element) {
    throw new Error(`Suggestion card element not found: ${what}`);
  }
  return element;
}

function parts(root: Element) {
  const [textRow, actionRow, status] = root.props.children as [Element, Element, Element | null];
  return { textRow, actionRow, status };
}

function press(element: Element) {
  const onPress = element.props.onPress as (() => void) | undefined;
  if (!onPress) {
    throw new Error('Element has no onPress handler');
  }
  onPress();
}

async function flushMicrotasks() {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  refSlots.slots = [];
  refSlots.cursor = 0;
  stateSlots.slots = [];
  stateSlots.cursor = 0;
});

describe('SuggestionCard', () => {
  it('renders the full suggestion text as context beside one primary action', () => {
    const root = renderCard({
      text,
      actions,
      onAccept: vi.fn<() => Promise<void>>(),
      onDismiss: vi.fn<() => Promise<void>>(),
    });
    const { textRow, actionRow } = parts(root);

    const rowChildren = childrenOf(textRow);
    expect(requireChild(rowChildren[0], 'sparkle icon').type).toBe('Sparkles');
    const suggestionText = requireChild(rowChildren[1], 'suggestion text');
    expect(suggestionText.type).toBe('Text');
    expect(suggestionText.props.children).toBe(text);
    expect(suggestionText.props.numberOfLines).toBeUndefined();

    const buttons = childrenOf(actionRow);
    expect(buttons).toHaveLength(3);
    expect(buttons.map(button => button.props.variant)).toEqual(['default', 'outline', 'ghost']);
    expect(buttons.filter(button => button.props.variant === 'default')).toHaveLength(1);
    expect(requireChild(buttons[0], 'first action').props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Review',
      accessibilityHint: 'Inspect every changed file.\nDo not edit.',
    });
    expect(requireChild(buttons[2], 'dismiss').props.accessibilityLabel).toBe('Dismiss suggestion');
  });

  it('keeps an over-wide action label inside the row instead of overflowing it', async () => {
    const longAction: CardProps['actions'][number] = {
      label: 'Review the new parseDuration implementation and its tests before shipping',
      prompt: '/review',
    };
    const root = renderCard({
      text,
      actions: [longAction],
      onAccept: vi.fn<() => Promise<void>>(),
      onDismiss: vi.fn<() => Promise<void>>(),
    });
    const button = requireChild(childrenOf(parts(root).actionRow)[0], 'first action');
    const label = requireChild(childrenOf(button)[0], 'action label');

    expect(label.props.children).toBe(longAction.label);
    // The button itself is clamped to the row it sits in, however long the
    // label: it never keeps the `shrink-0` the shared Button defaults to.
    expect(await nativeStyle(button.props.className as string)).toMatchObject({
      maxWidth: '100%',
      flexShrink: 1,
    });
    // The shared Button's base class is `shrink-0`, so the card's class has to
    // win that merge or the button could never shrink to the row.
    expect(cn('shrink-0', button.props.className as string)).not.toContain('shrink-0');
    // Wrapping, not truncating: no line limit, and the label shrinks to the
    // width the button has left for it.
    expect(label.props.numberOfLines).toBeUndefined();
    expect(await nativeStyle(label.props.className as string)).toMatchObject({ flexShrink: 1 });
  });

  it('surfaces the apply failure and re-enables the action buttons', async () => {
    const onAccept = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('offline'));
    const onDismiss = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const props: CardProps = { text, actions, onAccept, onDismiss };

    const root = renderCard(props);
    press(requireChild(childrenOf(parts(root).actionRow)[0], 'first action'));

    await flushMicrotasks();

    const { actionRow, status } = parts(renderCard(props));
    expect(status?.type).toBe('AccessibleStatus');
    expect(status?.props.message).toBe("Couldn't apply this suggestion. Try again.");
    const buttons = childrenOf(actionRow);
    expect(requireChild(buttons[0], 'first action').props.disabled).toBe(false);
    expect(requireChild(buttons[0], 'first action').props.loading).toBe(false);
    expect(onAccept).toHaveBeenCalledWith(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('surfaces the dismiss failure and re-enables dismiss', async () => {
    const onAccept = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onDismiss = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('offline'));
    const props: CardProps = { text, actions, onAccept, onDismiss };

    const root = renderCard(props);
    const buttons = childrenOf(parts(root).actionRow);
    press(requireChild(buttons.at(-1), 'dismiss'));

    await flushMicrotasks();

    const { actionRow, status } = parts(renderCard(props));
    expect(status?.type).toBe('AccessibleStatus');
    expect(status?.props.message).toBe("Couldn't dismiss this suggestion. Try again.");
    const dismiss = requireChild(childrenOf(actionRow)[2], 'dismiss');
    expect(dismiss.props.disabled).toBe(false);
    expect(dismiss.props.loading).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onAccept).not.toHaveBeenCalled();
  });
});
