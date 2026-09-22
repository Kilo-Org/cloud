import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SuggestionCard } from './suggestion-card';

// The card owns the suggestion's inline presentation: the whole text, one
// primary action, and a dismiss control. The harness mounts the real component
// (hooks included) with the RN primitives replaced by named hosts so the tree
// can be inspected for the defects this slice fixes: a truncated text node, a
// text wrapped in a Pressable, and more than one `variant="default"` action.

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }),
  };
});
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}));
vi.mock('@/components/ui/icons', () => ({ Sparkles: 'Sparkles', X: 'X' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

type CardProps = {
  text: string;
  actions: { label: string; description?: string; prompt: string }[];
  onAccept: (index: number) => Promise<void>;
  onDismiss: () => Promise<void>;
};

const TEXT = 'Review the new parseDuration implementation and tests';
const ACTIONS = [
  { label: 'Review', description: 'Inspect every changed file.', prompt: '/review' },
  { label: 'Test', prompt: 'Run the tests' },
];

/** A handler that rejects, shaped so `require-await`/`promise-function-async` are satisfied. */
async function rejectAction(): Promise<void> {
  await Promise.resolve();
  throw new Error('action failed');
}

function renderCard(props: CardProps): Renderer {
  const ref: { current: Renderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SuggestionCard, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('SuggestionCard renderer was not created');
  }
  return renderer;
}

function isHost(node: Instance, type: string): boolean {
  return node.type === type;
}

function hosts(renderer: Renderer, type: string): Instance[] {
  return renderer.root.findAll(node => isHost(node, type));
}

function buttons(renderer: Renderer): Instance[] {
  return hosts(renderer, 'Button');
}

function buttonAt(renderer: Renderer, index: number): Instance {
  const button = buttons(renderer)[index];
  if (!button) {
    throw new Error(`Button ${index} was not rendered`);
  }
  return button;
}

function suggestionText(renderer: Renderer): Instance {
  return renderer.root.find(node => isHost(node, 'Text') && node.props.children === TEXT);
}

function actionRow(renderer: Renderer): Instance | undefined {
  return hosts(renderer, 'View').find(view =>
    String(view.props.className ?? '').includes('flex-wrap')
  );
}

function statusMessage(renderer: Renderer): unknown {
  return hosts(renderer, 'AccessibleStatus')[0]?.props.message;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function press(node: Instance): Promise<void> {
  await act(async () => {
    (node.props.onPress as () => void)();
    await Promise.resolve();
  });
  await settle();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const handlers: { resolve: ((value: T) => void) | undefined } = { resolve: undefined };
  const promise = new Promise<T>(resolve => {
    handlers.resolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      handlers.resolve?.(value);
    },
  };
}

describe('SuggestionCard', () => {
  it('renders the whole suggestion text and exactly one primary action', () => {
    const renderer = renderCard({
      text: TEXT,
      actions: ACTIONS,
      onAccept: vi.fn<() => Promise<void>>(),
      onDismiss: vi.fn<() => Promise<void>>(),
    });

    const text = suggestionText(renderer);
    expect(text.props.children).toBe(TEXT);
    expect(text.props).not.toHaveProperty('numberOfLines');

    for (let ancestor = text.parent; ancestor; ancestor = ancestor.parent) {
      if (isHost(ancestor, 'View')) {
        expect(String(ancestor.props.className ?? '')).not.toContain('max-w-[240px]');
      }
    }

    for (const pressable of hosts(renderer, 'Pressable')) {
      expect(pressable.findAll(node => node.props.children === TEXT)).toHaveLength(0);
    }

    const rendered = buttons(renderer);
    expect(rendered.map(button => button.props.variant)).toEqual(['default', 'outline', 'ghost']);
    expect(rendered.filter(button => button.props.variant === 'default')).toHaveLength(1);
    expect(buttonAt(renderer, 2).props.accessibilityLabel).toBe('Dismiss suggestion');

    renderer.unmount();
  });

  it('shows the apply-failed copy after a rejected accept and allows a retry', async () => {
    const onAccept = vi.fn(rejectAction);
    const onDismiss = vi.fn<() => Promise<void>>();
    const renderer = renderCard({ text: TEXT, actions: ACTIONS, onAccept, onDismiss });

    await press(buttonAt(renderer, 0));

    expect(statusMessage(renderer)).toBe("Couldn't apply this suggestion. Try again.");
    const retry = buttonAt(renderer, 0);
    expect(retry.props.disabled).toBe(false);
    expect(retry.props.loading).toBe(false);

    await press(retry);

    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onDismiss).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('shows the dismiss-failed copy after a rejected dismiss and allows a retry', async () => {
    const onAccept = vi.fn<() => Promise<void>>();
    const onDismiss = vi.fn(rejectAction);
    const renderer = renderCard({ text: TEXT, actions: ACTIONS, onAccept, onDismiss });

    await press(buttonAt(renderer, 2));

    expect(statusMessage(renderer)).toBe("Couldn't dismiss this suggestion. Try again.");
    const retry = buttonAt(renderer, 2);
    expect(retry.props.disabled).toBe(false);

    await press(retry);

    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onAccept).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('renders the text and dismiss control with no primary action when there are none', () => {
    const renderer = renderCard({
      text: TEXT,
      actions: [],
      onAccept: vi.fn<() => Promise<void>>(),
      onDismiss: vi.fn<() => Promise<void>>(),
    });

    expect(suggestionText(renderer).props.children).toBe(TEXT);
    const rendered = buttons(renderer);
    expect(rendered.map(button => button.props.variant)).toEqual(['ghost']);
    expect(rendered.filter(button => button.props.variant === 'default')).toHaveLength(0);
    expect(buttonAt(renderer, 0).props.accessibilityLabel).toBe('Dismiss suggestion');

    renderer.unmount();
  });

  it('keeps the action row mounted and marks the pending action while an accept is in flight', async () => {
    const accept = deferred<boolean>();
    const onAccept = vi.fn(async () => {
      await accept.promise;
    });
    const renderer = renderCard({
      text: TEXT,
      actions: ACTIONS,
      onAccept,
      onDismiss: vi.fn<() => Promise<void>>(),
    });

    const rowBefore = actionRow(renderer);
    expect(rowBefore).toBeDefined();

    await press(buttonAt(renderer, 0));

    // The row keeps its identity and class, so the pending spinner replaces no
    // layout: the card does not jump while the accept is in flight.
    expect(actionRow(renderer)?.props.className).toBe(rowBefore?.props.className);
    const rendered = buttons(renderer);
    expect(rendered).toHaveLength(3);
    expect(rendered[0]?.props.loading).toBe(true);
    expect(rendered[0]?.props.size).toBe('sm');
    expect(rendered[2]?.props.disabled).toBe(true);

    accept.resolve(true);
    await settle();

    renderer.unmount();
  });
});
