import { type ComponentProps, createElement } from 'react';
import { MockTextInput } from '@/test/native-input.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { Alert } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionCard } from './question-card';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: MockTextInput,
  View: 'View',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#ffffff', mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: vi.fn(),
  moveA11yFocus: vi.fn(() => true),
}));

type Props = ComponentProps<typeof QuestionCard>;
type Instance = TestRenderer.ReactTestInstance;
const renderers: TestRenderer.ReactTestRenderer[] = [];

async function mount(overrides: Partial<Props> = {}) {
  const props: Props = {
    requestId: 'question-actions',
    questions: [
      {
        question: 'How should the agent proceed?',
        header: 'Next step',
        options: [{ label: 'Continue', description: '' }],
        custom: false,
      },
    ],
    onAnswer: vi.fn<Props['onAnswer']>(),
    onReject: vi.fn<Props['onReject']>(),
    ...overrides,
  };
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(QuestionCard, props));
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return { renderer, props };
}

function action(root: Instance, label: string): Instance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Button' &&
      node.findAll(
        child =>
          typeof child.type === 'string' &&
          (child.type as string) === 'Text' &&
          child.children.includes(label)
      ).length > 0
  );
}

function expectFullWidthAction(button: Instance) {
  expect(button.parent?.props.className).toContain('flex-col');
  expect(button.parent?.props.className).not.toContain('flex-row');
  expect(button.props.className).toContain('w-full');
  expect(button.props.className).not.toContain('flex-1');
  const label = button.findByType('Text');
  expect(label.props.className).toContain('text-center');
  expect(label.props.className).toContain('shrink');
  // Keep the complete, scalable label rather than hiding the defect with ellipsis or tiny text.
  expect(label.props.numberOfLines).toBeUndefined();
  expect(label.props.adjustsFontSizeToFit).toBeUndefined();
  expect(label.props.allowFontScaling).not.toBe(false);
}

function press(button: Instance) {
  act(() => {
    (button.props.onPress as () => void)();
  });
}

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    renderer.unmount();
  }
  vi.clearAllMocks();
});

describe('QuestionCard action layout', () => {
  it('gives the complete Send answers label its own row before and after selecting an answer', async () => {
    const { renderer, props } = await mount();
    expectFullWidthAction(action(renderer.root, 'Send answers'));
    expectFullWidthAction(action(renderer.root, 'Skip'));
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(true);

    press(action(renderer.root, 'Continue'));
    const send = action(renderer.root, 'Send answers');
    expectFullWidthAction(send);
    expect(send.props.disabled).toBe(false);
    press(send);
    expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['Continue']]);
  });

  it('preserves full-width actions and disables them while submitting', async () => {
    const { renderer, props } = await mount();
    press(action(renderer.root, 'Continue'));
    act(() => {
      renderer.update(createElement(QuestionCard, { ...props, isSubmitting: true }));
    });
    expectFullWidthAction(action(renderer.root, 'Submitting…'));
    expectFullWidthAction(action(renderer.root, 'Skip'));
    expect(action(renderer.root, 'Submitting…').props.disabled).toBe(true);
    expect(action(renderer.root, 'Skip').props.disabled).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
  });

  it.each(['answer', 'reject'] as const)(
    'keeps a full-width working retry after a failed %s',
    async failedAction => {
      const { renderer, props } = await mount();
      press(action(renderer.root, 'Continue'));
      act(() => {
        renderer.update(
          createElement(QuestionCard, {
            ...props,
            submissionError: { kind: 'retryable', action: failedAction, message: 'Try again.' },
          })
        );
      });
      expect(renderer.root.findByProps({ children: 'Try again.' })).toBeDefined();
      const retry = action(renderer.root, failedAction === 'answer' ? 'Retry' : 'Retry skip');
      expectFullWidthAction(retry);
      expect(retry.props.disabled).toBe(false);
      press(retry);
      if (failedAction === 'answer') {
        expectFullWidthAction(action(renderer.root, 'Skip'));
        expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['Continue']]);
        expect(props.onReject).not.toHaveBeenCalled();
      } else {
        expect(props.onReject).toHaveBeenCalledOnce();
        expect(props.onAnswer).not.toHaveBeenCalled();
      }
    }
  );

  it('removes unavailable actions and keeps the terminal explanation', async () => {
    const { renderer } = await mount({
      submissionError: { kind: 'non-retryable', message: 'This question is no longer available.' },
    });
    expect(
      renderer.root.findByProps({ children: 'This question is no longer available.' })
    ).toBeDefined();
    const buttons = renderer.root.findAllByType('Button');
    expect(buttons).toHaveLength(1);
    expect(action(renderer.root, 'Continue').props.disabled).toBe(true);
  });

  it('keeps Skip behind its existing confirmation', async () => {
    const { renderer, props } = await mount();
    press(action(renderer.root, 'Skip'));
    expect(props.onReject).not.toHaveBeenCalled();
    const confirmation = vi.mocked(Alert.alert).mock.calls[0]?.[2];
    expect(confirmation).toEqual([
      expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
      expect.objectContaining({ text: 'Skip', style: 'destructive', onPress: props.onReject }),
    ]);
    confirmation?.[1]?.onPress?.();
    expect(props.onReject).toHaveBeenCalledOnce();
  });
});
