/* eslint-disable new-cap -- SuggestionCard is invoked as a plain function, matching repo test convention */
import type * as React from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
