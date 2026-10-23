import { type ComponentProps, createElement } from 'react';
import { MockTextInput } from '@/test/native-input.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionCard } from './question-card';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: MockTextInput,
  View: 'View',
}));
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: 'DestructiveConfirmDialog',
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
  requestA11yFocus: vi.fn(() => true),
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

describe('QuestionCard actions', () => {
  it('submits a selected answer', async () => {
    const { renderer, props } = await mount();
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(true);

    press(action(renderer.root, 'Continue'));
    const send = action(renderer.root, 'Send answers');
    expect(send.props.disabled).toBe(false);
    press(send);
    expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['Continue']]);
  });

  it('requires an answer to every question before submitting their ordered choices', async () => {
    const { renderer, props } = await mount({
      questions: [
        {
          header: 'Version',
          question: 'Which version change?',
          options: [{ label: 'patch', description: '' }],
          custom: false,
        },
        {
          header: 'Ref',
          question: 'Which branch?',
          options: [{ label: 'main', description: '' }],
          custom: false,
        },
      ],
    });

    press(action(renderer.root, 'patch'));
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(true);
    expect(props.onAnswer).not.toHaveBeenCalled();

    press(action(renderer.root, 'main'));
    const send = action(renderer.root, 'Send answers');
    expect(send.props.disabled).toBe(false);
    press(send);
    expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['patch'], ['main']]);
  });

  it('requires custom answer text and disables submission when it is cleared', async () => {
    const { renderer, props } = await mount({
      questions: [
        {
          header: 'Next step',
          question: 'How should the agent proceed?',
          options: [],
          custom: true,
        },
      ],
    });
    const input = renderer.root.findByType('TextInput');
    const typeText = input.props.onChangeText as (text: string) => void;
    act(() => {
      typeText('   ');
    });
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(true);

    act(() => {
      typeText('  Continue manually  ');
    });
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(false);
    press(action(renderer.root, 'Send answers'));
    expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['Continue manually']]);

    act(() => {
      typeText('');
    });
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(true);
  });

  it('prevents another answer or skip while submitting', async () => {
    const { renderer, props } = await mount();
    press(action(renderer.root, 'Continue'));
    act(() => {
      renderer.update(createElement(QuestionCard, { ...props, isSubmitting: true }));
    });
    expect(action(renderer.root, 'Submitting…').props.disabled).toBe(true);
    expect(action(renderer.root, 'Skip').props.disabled).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
  });

  it.each(['answer', 'reject'] as const)('retries the failed %s action', async failedAction => {
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
    expect(retry.props.disabled).toBe(false);
    press(retry);
    if (failedAction === 'answer') {
      expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['Continue']]);
      expect(props.onReject).not.toHaveBeenCalled();
    } else {
      expect(props.onReject).toHaveBeenCalledOnce();
      expect(props.onAnswer).not.toHaveBeenCalled();
    }
  });

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
    const confirmation = renderer.root.findAllByType('DestructiveConfirmDialog')[0];
    if (!confirmation) {
      throw new Error('missing skip confirmation');
    }
    act(() => {
      (confirmation.props.onConfirm as () => void)();
    });
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it('keeps the question answerable after cancelling Skip', async () => {
    const { renderer, props } = await mount();
    press(action(renderer.root, 'Skip'));
    const confirmation = renderer.root.findByType('DestructiveConfirmDialog');
    act(() => {
      (confirmation.props.onCancel as () => void)();
    });
    expect(props.onReject).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('DestructiveConfirmDialog')).toHaveLength(0);

    press(action(renderer.root, 'Continue'));
    expect(action(renderer.root, 'Send answers').props.disabled).toBe(false);
    press(action(renderer.root, 'Send answers'));
    expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith([['Continue']]);
  });
});
