/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as permission-card.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { QuestionCard } from './question-card';

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
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: vi.fn(),
  moveA11yFocus: vi.fn(() => true),
}));

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
});
