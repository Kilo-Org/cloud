import { createElement } from 'react';
import { MockTextInput } from '@/test/native-input.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionCard } from './question-card';

const a11yMocks = vi.hoisted(() => ({
  announceForA11y: vi.fn<(message: string) => void>(),
  requestA11yFocus: vi.fn<() => boolean>(() => true),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  // `@/components/ui/input` reads `I18nManager.isRTL` through
  // `@/lib/rtl-text`; the mock must expose it or the shared box throws.
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: MockTextInput,
  View: 'View',
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@/components/ui/icons', () => ({
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

// Custom answer contract: a multi-choice custom answer is a checkbox that
// unchecks on re-activation or an empty field; a single-choice one is a radio
// that stays selected, and a preset press replaces it.

type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiple?: boolean;
  custom?: boolean;
};

function makeQuestion(
  overrides: { multiple?: boolean; custom?: boolean; description?: string } = {}
): Question[] {
  return [
    {
      question: 'How should the agent proceed?',
      header: 'Agent needs input',
      options: [
        { label: 'Continue', description: overrides.description ?? '' },
        { label: 'Stop', description: '' },
      ],
      multiple: overrides.multiple ?? false,
      custom: overrides.custom ?? true,
    },
  ];
}

const DESCRIBED = makeQuestion({ description: 'Deploy to production' });

type Renderer = TestRenderer.ReactTestRenderer;

async function renderCard(
  questions: Question[],
  onAnswer: (answers: string[][]) => void = () => undefined
): Promise<Renderer> {
  const holder: { current?: Renderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(
      createElement(QuestionCard, {
        questions,
        onAnswer,
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
  // A described option joins its subtitle into the accessible name
  // (`<label>, <description>`), so match the leading label too.
  return root.findAll(node => {
    if (typeof node.type !== 'string' || (node.type as string) !== 'Button') {
      return false;
    }
    const accessibleLabel = node.props.accessibilityLabel;
    return (
      accessibleLabel === label ||
      (typeof accessibleLabel === 'string' && accessibleLabel.startsWith(`${label},`))
    );
  })[0];
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

/** The card's submit CTA, the button that submits the answers. */
function submitAction(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Button' &&
      node.findAll(
        child =>
          typeof child.type === 'string' &&
          (child.type as string) === 'Text' &&
          child.children.includes('Send answers')
      ).length > 0
  );
}

/** The row of text lines rendered inside one preset option button. */
function optionTextLines(root: TestRenderer.ReactTestInstance, label: string): string[] {
  const button = optionButton(root, label);
  if (!button) {
    throw new Error(`option button "${label}" not found`);
  }
  return button
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    );
}

describe('QuestionCard custom answer selection', () => {
  beforeEach(() => {
    a11yMocks.announceForA11y.mockReset();
    a11yMocks.requestA11yFocus.mockReset();
    a11yMocks.requestA11yFocus.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unchecks a multi-choice custom answer on re-activation and on an empty field', async () => {
    const renderer = await renderCard(makeQuestion({ multiple: true }));
    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(true);

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(false);

    typeCustomText(renderer.root, 'Manual input');
    expect(customChoiceChecked(renderer.root)).toBe(true);
    typeCustomText(renderer.root, '');
    expect(customChoiceChecked(renderer.root)).toBe(false);
  });

  it('keeps a single-choice custom answer selected on re-activation', async () => {
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

  it('pressing a preset after typing replaces the custom field instead of leaving text the card will not send', async () => {
    // Regression: the preset press left the typed text the payload dropped.
    let submitted: string[][] = [];
    const renderer = await renderCard(makeQuestion({ multiple: false }), answers => {
      submitted = answers;
    });
    const inputBefore = customInput(renderer.root);

    typeCustomText(renderer.root, 'deploy staging');
    expect(customChoiceChecked(renderer.root)).toBe(true);

    press(optionButton(renderer.root, 'Continue'));
    expect(customChoiceChecked(renderer.root)).toBe(false);

    // A new field instance starts from its empty default.
    const inputAfter = customInput(renderer.root);
    expect(inputAfter).not.toBe(inputBefore);
    expect(inputAfter?.props.defaultValue).toBe('');

    press(submitAction(renderer.root));
    expect(submitted).toEqual([['Continue']]);
  });

  it('re-pressing the selected custom radio keeps the typed answer on screen and in the submitted payload', async () => {
    let submitted: string[][] = [];
    const renderer = await renderCard(makeQuestion({ multiple: false }), answers => {
      submitted = answers;
    });

    typeCustomText(renderer.root, 'deploy staging');
    expect(customChoiceChecked(renderer.root)).toBe(true);
    const inputBefore = customInput(renderer.root);

    press(customChoice(renderer.root));
    expect(customChoiceChecked(renderer.root)).toBe(true);
    // The radio never remounts the field, so the typed answer stays put.
    expect(customInput(renderer.root)).toBe(inputBefore);

    press(submitAction(renderer.root));
    expect(submitted).toEqual([['deploy staging']]);
  });

  it('keeps a chosen preset when the custom field is emptied', async () => {
    // Regression: empty custom text cleared the whole answer, so a space removed
    // the preset the card would have submitted.
    let submitted: string[][] = [];
    const renderer = await renderCard(makeQuestion({ multiple: false }), answers => {
      submitted = answers;
    });

    press(optionButton(renderer.root, 'Continue'));
    typeCustomText(renderer.root, ' ');

    press(submitAction(renderer.root));
    expect({ checked: customChoiceChecked(renderer.root), submitted }).toEqual({
      checked: false,
      submitted: [['Continue']],
    });
  });

  it('renders an option description as a subtitle under its label', async () => {
    const renderer = await renderCard(DESCRIBED);

    expect(optionTextLines(renderer.root, 'Continue')).toEqual([
      'Continue',
      'Deploy to production',
    ]);
    // No description means no empty subtitle line under the label.
    expect(optionTextLines(renderer.root, 'Stop')).toEqual(['Stop']);
  });

  it('announces an option description in its accessible name, never only as a hint', async () => {
    const renderer = await renderCard(DESCRIBED);

    // TalkBack reads a node's hint, not the tooltip `accessibilityHint` fills.
    const described = optionButton(renderer.root, 'Continue');
    expect(described?.props.accessibilityLabel).toBe('Continue, Deploy to production');
    expect(described?.props.accessibilityHint).toBeUndefined();

    expect(optionButton(renderer.root, 'Stop')?.props.accessibilityLabel).toBe('Stop');
    expect(optionButton(renderer.root, 'Stop')?.props.accessibilityHint).toBeUndefined();
  });

  it('cancels the delayed focus retry when a new request replaces the card', async () => {
    vi.useFakeTimers();
    // First mount misses the node handle (schedules a retry); the replacement
    // mount finds it (no new retry). If the effect dropped the shared cleanup,
    // the first retry would still fire after 50ms and focus the stale node.
    a11yMocks.requestA11yFocus.mockReturnValueOnce(false).mockReturnValue(true);

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
    expect(a11yMocks.requestA11yFocus).toHaveBeenCalledTimes(2);
  });

  it('cancels the delayed focus retry on unmount', async () => {
    vi.useFakeTimers();
    // The first focus attempt misses the node handle, so a retry is scheduled.
    // The effect cleanup must clear it before it can focus an unmounted node.
    a11yMocks.requestA11yFocus.mockReturnValueOnce(false).mockReturnValue(true);

    const renderer = await renderCard(makeQuestion());

    act(() => {
      renderer.unmount();
    });

    vi.advanceTimersByTime(100);
    expect(a11yMocks.requestA11yFocus).toHaveBeenCalledTimes(1);
  });
});

describe('QuestionCard custom answer placeholder contrast', () => {
  // The custom answer field swaps its fill to `bg-primary` once its radio or
  // checkbox is active. A placeholder painted for the plain background
  // (`mutedForeground`, near-black) is invisible on that fill, so the field's
  // purpose cannot be read (ios session-answer-kb-up finding). The placeholder
  // colour must follow the fill, the same way the typed text does.
  it('paints the placeholder with the fill foreground once the custom answer is active', async () => {
    const renderer = await renderCard(makeQuestion());

    expect(customInput(renderer.root)?.props.placeholderTextColor).toBe('#6F6A61');

    press(customChoice(renderer.root));

    expect(customInput(renderer.root)?.props.placeholderTextColor).toBe('#ffffff');
  });
});
