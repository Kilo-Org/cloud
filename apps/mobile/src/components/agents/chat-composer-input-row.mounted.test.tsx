/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as composer-paste-button.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposerInputRow } from './chat-composer-input-row';

const platformOS = vi.hoisted(() => ({ os: 'ios' }));

function reactNativeMock() {
  return {
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: platformOS.os },
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    View: 'View',
  };
}

vi.mock('react-native', reactNativeMock);
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn(() => ({})) },
  FadeOut: { duration: vi.fn(() => ({})) },
  useReducedMotion: () => false,
}));
vi.mock('@/components/ui/icons', () => ({
  ArrowUp: 'ArrowUp',
  CornerDownLeft: 'CornerDownLeft',
  Paperclip: 'Paperclip',
  Square: 'Square',
}));
vi.mock('@/components/voice-input-control', () => ({
  VoiceInputButton: 'VoiceInputButton',
}));
vi.mock('@/components/agents/chat-composer-input-height', () => ({
  shouldEnableComposerInputScroll: () => false,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6b7280' }),
}));

type RenderProps = {
  canSend?: boolean;
  hasSendableContent?: boolean;
  inputEditable: boolean;
  isStreaming?: boolean;
  onSubmit?: () => void;
  returnSendsMessage?: boolean;
  voiceInputAvailable?: boolean;
};

function makeProps(overrides: Partial<RenderProps> = {}) {
  return {
    attachmentsEnabled: false,
    canSend: false,
    disabled: false,
    hasSendableContent: false,
    inputAccessibilityDisabled: false,
    inputEditable: false,
    inputRef: { current: null },
    isSending: false,
    isStreaming: false,
    maxInputHeight: 120,
    measureHeight: 40,
    onAddAttachment: () => undefined,
    onChangeText: () => undefined,
    onInputBlur: () => undefined,
    onInputFocus: () => undefined,
    onInputLayout: () => undefined,
    onInsertNewline: () => undefined,
    onSelectionChange: () => undefined,
    onStop: () => undefined,
    onSubmit: () => undefined,
    onToggleVoice: () => undefined,
    paperclipDisabled: false,
    placeholder: 'Message the agent',
    returnSendsMessage: false,
    textInputStyle: {},
    voiceDisabled: false,
    voiceInputAvailable: false,
    voiceInputStatus: 'idle' as const,
    ...overrides,
  };
}

function findTextInput(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => typeof node.type === 'string' && (node.type as string) === 'TextInput');
}

function findAllByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function findByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | null {
  const matches = root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

async function renderRow(props: RenderProps): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(ChatComposerInputRow, makeProps(props)));
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ChatComposerInputRow mounted — iOS writing-tools lock', () => {
  beforeEach(() => {
    platformOS.os = 'ios';
  });

  it('blocks writing tools and selection when the input is not editable', async () => {
    const renderer = await renderRow({ inputEditable: false });

    const input = findTextInput(renderer.root);
    expect(input.props.editable).toBe(false);
    expect(input.props.contextMenuHidden).toBe(true);
    expect(input.props.pointerEvents).toBe('none');

    renderer.unmount();
  });

  it('leaves the input editable and gesture-enabled when it is editable', async () => {
    const renderer = await renderRow({ inputEditable: true });

    const input = findTextInput(renderer.root);
    expect(input.props.editable).toBe(true);
    expect(
      input.props.contextMenuHidden === undefined || input.props.contextMenuHidden === false
    ).toBe(true);
    expect(input.props.pointerEvents).not.toBe('none');

    renderer.unmount();
  });

  it('shows the Send pressable (not Stop) while streaming with content and an in-flight upload', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: true,
    });

    expect(findByAccessibilityLabel(renderer.root, 'Send message')).not.toBeNull();
    expect(findByAccessibilityLabel(renderer.root, 'Stop generating')).toBeNull();

    renderer.unmount();
  });

  it('shows the Stop pressable while streaming with no content', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
    });

    expect(findByAccessibilityLabel(renderer.root, 'Stop generating')).not.toBeNull();
    expect(findByAccessibilityLabel(renderer.root, 'Send message')).toBeNull();

    renderer.unmount();
  });

  it('keeps the microphone mounted beside Stop while streaming', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
      voiceInputAvailable: true,
    });

    expect(findAllByType(renderer.root, 'VoiceInputButton')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Stop generating')).not.toBeNull();

    renderer.unmount();
  });

  it('renders the newline control and wires return-submit when Return sends', async () => {
    const onSubmit = vi.fn<() => void>();
    const renderer = await renderRow({
      inputEditable: true,
      returnSendsMessage: true,
      onSubmit,
    });

    expect(findAllByType(renderer.root, 'CornerDownLeft')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Insert newline')).not.toBeNull();

    const input = findTextInput(renderer.root);
    expect(input.props.returnKeyType).toBe('send');
    expect(input.props.submitBehavior).toBe('submit');

    (input.props.onSubmitEditing as () => void)();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('omits the newline control and keeps newline submit when Return does not send', async () => {
    const renderer = await renderRow({ inputEditable: true, returnSendsMessage: false });

    expect(findAllByType(renderer.root, 'CornerDownLeft')).toHaveLength(0);

    const input = findTextInput(renderer.root);
    expect(input.props.returnKeyType).toBe('default');
    expect(input.props.submitBehavior).toBe('newline');
    expect(input.props.onSubmitEditing).toBeUndefined();

    renderer.unmount();
  });

  it('sizes the send and stop pressables to the 44pt iOS hit target', async () => {
    const sendRenderer = await renderRow({ inputEditable: true });
    const send = findByAccessibilityLabel(sendRenderer.root, 'Send message');
    const sendStyle = send?.props.style as { height: number; width: number } | undefined;
    expect(sendStyle?.height).toBe(44);
    expect(sendStyle?.width).toBe(44);
    sendRenderer.unmount();

    const stopRenderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
    });
    const stop = findByAccessibilityLabel(stopRenderer.root, 'Stop generating');
    const stopStyle = stop?.props.style as { height: number; width: number } | undefined;
    expect(stopStyle?.height).toBe(44);
    expect(stopStyle?.width).toBe(44);
    stopRenderer.unmount();
  });

  it('sizes the send and stop pressables to the 48dp Android hit target', async () => {
    platformOS.os = 'android';
    // `CONTROL_HIT_TARGET` is a module-level constant, so the row must be
    // re-imported after the platform flips to pick up the Android size. The
    // persistent `vi.mock` factory is cached, so `doMock` re-registers it for
    // the fresh import and `resetModules` clears the module cache.
    vi.doMock('react-native', reactNativeMock);
    vi.resetModules();
    const { ChatComposerInputRow: AndroidRow } = await import('./chat-composer-input-row');
    const { createElement: createElementAndroid } = await import('react');
    const { default: Renderer, act: actFresh } = await import('react-test-renderer');

    const renderAndroid = async (props: RenderProps): Promise<TestRenderer.ReactTestRenderer> => {
      const holder: { current?: TestRenderer.ReactTestRenderer } = {};
      await actFresh(async () => {
        await Promise.resolve();
        holder.current = Renderer.create(createElementAndroid(AndroidRow, makeProps(props)));
      });
      if (!holder.current) {
        throw new Error('renderer was not created');
      }
      return holder.current;
    };

    const sendRenderer = await renderAndroid({ inputEditable: true });
    const send = findByAccessibilityLabel(sendRenderer.root, 'Send message');
    const sendStyle = send?.props.style as { height: number; width: number } | undefined;
    expect(sendStyle?.height).toBe(48);
    expect(sendStyle?.width).toBe(48);
    sendRenderer.unmount();

    const stopRenderer = await renderAndroid({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
    });
    const stop = findByAccessibilityLabel(stopRenderer.root, 'Stop generating');
    const stopStyle = stop?.props.style as { height: number; width: number } | undefined;
    expect(stopStyle?.height).toBe(48);
    expect(stopStyle?.width).toBe(48);
    stopRenderer.unmount();
  });

  it('renders the mic at the lg size so it reaches the 48dp Android target', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      voiceInputAvailable: true,
    });

    const [mic] = findAllByType(renderer.root, 'VoiceInputButton');
    expect(mic?.props.size).toBe('lg');

    renderer.unmount();
  });
});
