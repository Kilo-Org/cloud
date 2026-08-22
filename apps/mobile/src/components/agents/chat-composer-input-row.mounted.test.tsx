/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as composer-paste-button.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ChatComposerInputRow } from './chat-composer-input-row';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  ArrowUp: 'ArrowUp',
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
    onSelectionChange: () => undefined,
    onStop: () => undefined,
    onSubmit: () => undefined,
    onToggleVoice: () => undefined,
    paperclipDisabled: false,
    placeholder: 'Message the agent',
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
});
