/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as permission-card.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionCard } from './question-card';

const a11yMocks = vi.hoisted(() => ({
  announceForA11y: vi.fn<(message: string) => void>(),
  moveA11yFocus: vi.fn<() => boolean>(() => true),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
}));
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#ffffff', mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/a11y/announce', () => a11yMocks);

// Custom answer selection contract (final cumulative r7):
// - Multiple choice: the custom choice is a checkbox. Re-activating it
//   unchecks it, and clearing its text also unchecks it so it never reads as
//   selected with no content.
// - Single choice: the custom choice is a radio that stays selected on
//   re-activation, and picking a preset option deselects it.

type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiple?: boolean;
  custom?: boolean;
};

function makeQuestion(overrides: { multiple?: boolean; custom?: boolean } = {}): Question[] {
  return [
    {
      question: 'How should the agent proceed?',
      header: 'Agent needs input',
      options: [
        { label: 'Continue', description: '' },
        { label: 'Stop', description: '' },
      ],
      multiple: overrides.multiple ?? false,
      custom: overrides.custom ?? true,
    },
  ];
}

type Renderer = TestRenderer.ReactTestRenderer;

async function renderCard(questions: Question[]): Promise<Renderer> {
  const holder: { current?: Renderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(
      createElement(QuestionCard, {
        questions,
        onAnswer: () => undefined,
        onReject: () => undefined,
        requestId: 'question-req-1',
      })
    );
  });
  const renderer = holder.current;
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function customChoice(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === 'Type your own answer'
  )[0];
}

function customInput(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'TextInput'
  )[0];
}

function optionButton(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Button' &&
      node.props.accessibilityLabel === label
  )[0];
}

function press(node: TestRenderer.ReactTestInstance | undefined): void {
  if (!node) {
    throw new Error('target node not found');
  }
  act(() => {
    (node.props.onPress as () => void)();
  });
}

function customChoiceChecked(root: TestRenderer.ReactTestInstance): boolean {
  const choice = customChoice(root);
  if (!choice) {
    throw new Error('custom choice not found');
  }
  const props = choice.props as { accessibilityState?: { checked?: boolean } };
  return props.accessibilityState?.checked === true;
}

function typeCustomText(root: TestRenderer.ReactTestInstance, text: string): void {
  const input = customInput(root);
  if (!input) {
    throw new Error('custom input not found');
  }
  act(() => {
    (input.props.onChangeText as (text: string) => void)(text);
  });
}

describe('QuestionCard custom answer selection', () => {
  beforeEach(() => {
    a11yMocks.announceForA11y.mockReset();
    a11yMocks.moveA11yFocus.mockReset();
    a11yMocks.moveA11yFocus.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unchecks the custom answer when re-activated for multiple choice', async () => {
    const renderer = await renderCard(makeQuestion({ multiple: true }));

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(true);

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(false);
  });

  it('unchecks the custom answer when its text is cleared for multiple choice', async () => {
    const renderer = await renderCard(makeQuestion({ multiple: true }));

    typeCustomText(renderer.root, 'Manual input');
    expect(customChoiceChecked(renderer.root)).toBe(true);

    typeCustomText(renderer.root, '');
    expect(customChoiceChecked(renderer.root)).toBe(false);
  });

  it('keeps the custom answer selected when re-activated for single choice', async () => {
    const renderer = await renderCard(makeQuestion({ multiple: false }));

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(true);

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(true);
  });

  it('deselects the custom answer when a single-choice preset option is picked', async () => {
    const renderer = await renderCard(makeQuestion({ multiple: false }));

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(true);

    press(optionButton(renderer.root, 'Continue'));
    expect(customChoiceChecked(renderer.root)).toBe(false);
  });

  it('cancels the delayed focus retry when a new request replaces the card', async () => {
    vi.useFakeTimers();
    // First mount misses the node handle (schedules a retry); the replacement
    // mount finds it (no new retry). If the effect dropped the shared cleanup,
    // the first retry would still fire after 50ms and focus the stale node.
    a11yMocks.moveA11yFocus.mockReturnValueOnce(false).mockReturnValue(true);

    const renderer = await renderCard(makeQuestion());

    act(() => {
      renderer.update(
        createElement(QuestionCard, {
          questions: makeQuestion(),
          onAnswer: () => undefined,
          onReject: () => undefined,
          requestId: 'question-req-2',
        })
      );
    });

    vi.advanceTimersByTime(100);
    expect(a11yMocks.moveA11yFocus).toHaveBeenCalledTimes(2);
  });

  it('cancels the delayed focus retry on unmount', async () => {
    vi.useFakeTimers();
    // The first focus attempt misses the node handle, so a retry is scheduled.
    // The effect cleanup must clear it before it can focus an unmounted node.
    a11yMocks.moveA11yFocus.mockReturnValueOnce(false).mockReturnValue(true);

    const renderer = await renderCard(makeQuestion());

    act(() => {
      renderer.unmount();
    });

    vi.advanceTimersByTime(100);
    expect(a11yMocks.moveA11yFocus).toHaveBeenCalledTimes(1);
  });
});
