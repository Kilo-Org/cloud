// Shared mount and query harness for the chat-composer-input-row mounted
// suites. This module is imported by the test files, whose hoisted vi.mock
// registrations are already in place when these imports evaluate; the split
// keeps each suite under the max-lines budget (same pattern as
// fixed-part-row.mounted.test-helpers.tsx).

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';

import { ChatComposerInputRow } from './chat-composer-input-row';

export type RenderProps = {
  canSend?: boolean;
  hasSendableContent?: boolean;
  inputEditable: boolean;
  isStreaming?: boolean;
  onSubmit?: () => void;
  returnSendsMessage?: boolean;
  voiceInputAvailable?: boolean;
};

export function makeProps(overrides: Partial<RenderProps> = {}) {
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
    onInputContentSizeChange: () => undefined,
    onInsertNewline: () => undefined,
    onSelectionChange: () => undefined,
    onStop: () => undefined,
    onSubmit: () => undefined,
    onToggleVoice: () => undefined,
    paperclipDisabled: false,
    // oxlint-disable-next-line no-literal-copy/no-literal-copy -- the placeholder is fixture input for the row; no test reads it
    placeholder: 'Message the agent',
    returnSendsMessage: false,
    textInputStyle: {},
    voiceDisabled: false,
    voiceInputAvailable: false,
    voiceInputStatus: 'idle' as const,
    ...overrides,
  };
}

export function findTextInput(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance {
  return root.find(node => typeof node.type === 'string' && (node.type as string) === 'TextInput');
}

export function findAllByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

export function findByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | null {
  const matches = root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

export async function renderRow(props: RenderProps): Promise<TestRenderer.ReactTestRenderer> {
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
