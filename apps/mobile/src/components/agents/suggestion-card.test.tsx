import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SuggestionCard } from './suggestion-card';

const mockHaptics = vi.hoisted(() => vi.fn());

const MockButton = vi.hoisted(() => () => null);
const MockText = vi.hoisted(() => () => null);
const MockView = vi.hoisted(() => () => null);
const MockScrollView = vi.hoisted(() => () => null);
const MockPressable = vi.hoisted(() => () => null);
const MockActivityIndicator = vi.hoisted(() => () => null);

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'Light' },
  impactAsync: (style: string) => mockHaptics(style),
}));

vi.mock('@/components/ui/button', () => ({ Button: MockButton }));
vi.mock('@/components/ui/text', () => ({ Text: MockText }));

vi.mock('react-native', () => ({
  ActivityIndicator: MockActivityIndicator,
  Pressable: MockPressable,
  ScrollView: MockScrollView,
  Text: MockText,
  View: MockView,
}));

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type SuggestionCardProps = React.ComponentProps<typeof SuggestionCard>;

type MockProps = { children?: React.ReactNode; [key: string]: unknown };
type MockElement = React.ReactElement<MockProps>;

function createRenderer() {
  const reactInternals = React as typeof React & ReactInternals;
  const hookState: unknown[] = [];
  let hookIndex = 0;

  // Mirrors the repo's existing React 19 test-only dispatcher harness; pinned
  // to the current React internals shape and not intended for production use.
  const dispatcher = {
    useCallback: <T,>(fn: T) => fn,
    useEffect: () => void 0,
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = { current: initialValue };
      }
      return hookState[stateIndex] as { current: T };
    },
    useState: <T,>(initialValue: T) => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = initialValue;
      }
      const setState = (value: T | ((prev: T) => T)) => {
        const prev = hookState[stateIndex] as T;
        hookState[stateIndex] =
          typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
      };
      return [hookState[stateIndex] as T, setState] as const;
    },
  };

  function render(props: SuggestionCardProps) {
    hookIndex = 0;
    const previousDispatcher =
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try {
      const suggestionCard = SuggestionCard;
      return suggestionCard(props) as React.ReactElement;
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  }

  return { render };
}

function findAll(
  node: React.ReactNode,
  predicate: (element: MockElement) => boolean
): MockElement[] {
  const results: MockElement[] = [];
  function traverse(current: React.ReactNode) {
    if (!React.isValidElement(current)) {
      return;
    }
    const element = current as unknown as MockElement;
    if (predicate(element)) {
      results.push(element);
    }
    const children = element.props.children;
    if (Array.isArray(children)) {
      for (const child of children as React.ReactNode[]) {
        traverse(child);
      }
    } else if (children !== undefined && children !== null) {
      traverse(children);
    }
  }
  traverse(node);
  return results;
}

function getTextContent(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (!React.isValidElement(node)) {
    return '';
  }
  const element = node as unknown as MockElement;
  const children = element.props.children;
  if (Array.isArray(children)) {
    return (children as React.ReactNode[]).map(child => getTextContent(child)).join('');
  }
  if (children === undefined || children === null) {
    return '';
  }
  return getTextContent(children);
}

function throwDeferredUninitialized(): never {
  throw new Error('Deferred promise was not initialized');
}

function createDeferredPromise<T>() {
  let resolve: (value: T) => void = throwDeferredUninitialized;
  let reject: (reason?: unknown) => void = throwDeferredUninitialized;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, reject, resolve };
}

const baseProps: SuggestionCardProps = {
  actions: [
    { description: 'Use Prettier for formatting', label: 'Apply Prettier', prompt: 'p1' },
    { description: 'Use Biome for formatting', label: 'Apply Biome', prompt: 'p2' },
  ],
  onAccept: vi.fn(),
  onDismiss: vi.fn(),
  text: 'Pick a formatter',
};

async function callOnPress(button: MockElement): Promise<void> {
  const onPress = button.props.onPress as (() => void | Promise<void>) | undefined;
  if (onPress === undefined) {
    throw new Error('Button is missing onPress');
  }
  await onPress();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SuggestionCard', () => {
  it('renders action labels and only one footer button', () => {
    const renderer = createRenderer();

    const tree = renderer.render(baseProps);

    const buttons = findAll(tree, node => node.type === MockButton);
    const buttonTexts = buttons.map(button => getTextContent(button.props.children));
    expect(buttonTexts).toContain('Apply Prettier');
    expect(buttonTexts).toContain('Apply Biome');
    expect(buttonTexts).toContain('Dismiss suggestion');
    expect(buttons).toHaveLength(baseProps.actions.length + 1);
  });

  it('second action calls onAccept(1)', async () => {
    const renderer = createRenderer();
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn();

    const tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const actionButtons = findAll(tree, node => node.type === MockButton);
    const secondButton = actionButtons[1];
    if (secondButton === undefined) {
      throw new Error('Expected second action button');
    }
    await callOnPress(secondButton);

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith(1);
    expect(mockHaptics).toHaveBeenCalledWith('Light');
  });

  it('dismiss calls onDismiss', async () => {
    const renderer = createRenderer();
    const onAccept = vi.fn();
    const onDismiss = vi.fn().mockResolvedValue(undefined);

    const tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const dismissButton = findAll(tree, node => node.type === MockButton).find(
      button => getTextContent(button.props.children) === 'Dismiss suggestion'
    );
    if (dismissButton === undefined) {
      throw new Error('Expected dismiss button');
    }
    await callOnPress(dismissButton);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('prevents same-frame double taps', async () => {
    const renderer = createRenderer();
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn();

    const tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const [firstButton] = findAll(tree, node => node.type === MockButton);
    if (firstButton === undefined) {
      throw new Error('Expected first action button');
    }
    void callOnPress(firstButton);
    void callOnPress(firstButton);

    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('deferred pending disables all buttons and shows loading only on tapped action', async () => {
    const renderer = createRenderer();
    const { promise, resolve } = createDeferredPromise<undefined>();
    const onAccept = vi.fn().mockReturnValue(promise);
    const onDismiss = vi.fn();

    let tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const actionButtons = findAll(tree, node => node.type === MockButton);
    const secondButton = actionButtons[1];
    if (secondButton === undefined) {
      throw new Error('Expected second action button');
    }
    const pressPromise = callOnPress(secondButton);
    expect(onAccept).toHaveBeenCalledTimes(1);

    tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const buttonsAfterPending = findAll(tree, node => node.type === MockButton);
    const [firstButton, secondButtonAfterPending, dismissButton] = buttonsAfterPending;
    if (
      firstButton === undefined ||
      secondButtonAfterPending === undefined ||
      dismissButton === undefined
    ) {
      throw new Error('Expected buttons after pending');
    }
    for (const button of buttonsAfterPending) {
      expect(button.props.disabled).toBe(true);
    }
    expect(secondButtonAfterPending.props.loading).toBe(true);
    expect(firstButton.props.loading).toBe(false);
    expect(dismissButton.props.loading).toBe(false);

    await callOnPress(secondButtonAfterPending);
    expect(onAccept).toHaveBeenCalledTimes(1);

    resolve(undefined);
    await pressPromise;
  });

  it('accept failure shows exact safe copy and not raw error', async () => {
    const renderer = createRenderer();
    const onAccept = vi.fn().mockRejectedValue(new Error('Raw upstream error'));
    const onDismiss = vi.fn();

    let tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const [firstButton] = findAll(tree, node => node.type === MockButton);
    if (firstButton === undefined) {
      throw new Error('Expected first action button');
    }
    await callOnPress(firstButton);

    tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const allText = findAll(tree, node => node.type === MockText)
      .map(text => getTextContent(text))
      .join(' ');
    expect(allText).toContain("Couldn't apply this suggestion. Try again.");
    expect(allText).not.toContain('Raw upstream error');
  });

  it('dismiss failure shows exact safe copy and not raw error', async () => {
    const renderer = createRenderer();
    const onAccept = vi.fn();
    const onDismiss = vi.fn().mockRejectedValue(new Error('Raw dismiss error'));

    let tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const dismissButton = findAll(tree, node => node.type === MockButton).find(
      button => getTextContent(button.props.children) === 'Dismiss suggestion'
    );
    if (dismissButton === undefined) {
      throw new Error('Expected dismiss button');
    }
    await callOnPress(dismissButton);

    tree = renderer.render({ ...baseProps, onAccept, onDismiss });

    const allText = findAll(tree, node => node.type === MockText)
      .map(text => getTextContent(text))
      .join(' ');
    expect(allText).toContain("Couldn't dismiss this suggestion. Try again.");
    expect(allText).not.toContain('Raw dismiss error');
  });

  it('sets accessibility label and hint on action buttons and hides description text', () => {
    const renderer = createRenderer();

    const tree = renderer.render(baseProps);

    const actionButtons = findAll(tree, node => node.type === MockButton);
    const [firstButton] = actionButtons;
    if (firstButton === undefined) {
      throw new Error('Expected first action button');
    }
    expect(firstButton.props.accessibilityLabel).toBe('Apply Prettier');
    expect(firstButton.props.accessibilityHint).toBe('Use Prettier for formatting');

    const descriptionTexts = findAll(
      tree,
      node =>
        node.type === MockText &&
        typeof node.props.children === 'string' &&
        node.props.accessible === false
    );
    const descriptionContents = descriptionTexts.map(
      (text): React.ReactNode => text.props.children
    );
    expect(descriptionContents).toContain('Use Prettier for formatting');
    expect(descriptionContents).toContain('Use Biome for formatting');
  });
});
