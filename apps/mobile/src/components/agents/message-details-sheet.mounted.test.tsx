/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import {
  type AssistantMessage,
  type Part,
  type StoredMessage,
  type UserMessage,
} from '@kilocode/cloud-agent-sdk';
import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MessageDetailsSheet } from './message-details-sheet';

vi.mock('react-native', () => ({
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: 'SheetHeader',
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/selectable-text', () => ({
  SelectableText: 'SelectableText',
}));
vi.mock('./message-details-copy', () => ({
  handleMessageDetailsCopy: vi.fn(),
}));

function userInfo(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'u-1',
    sessionID: 'ses-1',
    role: 'user',
    time: { created: 1_700_000_000_000 },
    agent: 'test',
    model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    ...overrides,
  };
}

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1_700_000_000_000 },
    parentID: 'msg-0',
    modelID: 'claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'test',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
}

function textPart(text: string, id = 'p-text'): Part {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
  };
}

function textPartWithTime(
  text: string,
  time: { start: number; end?: number },
  id = 'p-text-time'
): Part {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
    time,
  };
}

function storedMessage(info: AssistantMessage | UserMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

function sheetElement(message: StoredMessage | null): ReactElement {
  return createElement(MessageDetailsSheet, {
    visible: true,
    message,
    modelOptions: [],
    onClose: vi.fn<() => void>(),
  });
}

function findByTestID(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.testID === testID);
}

function press(instance: TestRenderer.ReactTestInstance | undefined): void {
  if (!instance) {
    throw new Error('target not found');
  }
  const onPress = instance.props.onPress as (() => void) | undefined;
  if (typeof onPress !== 'function') {
    throw new TypeError('target has no onPress');
  }
  onPress();
}

async function mountSheet(message: StoredMessage | null): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(sheetElement(message));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
}

describe('MessageDetailsSheet mounted', () => {
  it('renders Copy message and Select text for a finished copyable user message', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('hello world')]));

    expect(findByTestID(renderer.root, 'message-details-copy')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'message-details-select-text')).toHaveLength(1);

    await unmount(renderer);
  });

  it('swaps the details Modal content to the select view when Select text is pressed', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('selectable body')]));

    const modals = () =>
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      );
    const sheetHeaderTitles = () =>
      renderer.root
        .findAll(node => typeof node.type === 'string' && (node.type as string) === 'SheetHeader')
        .map(node => node.props.title as string | undefined);

    // Before press: a single Modal shows the details content.
    expect(modals()).toHaveLength(1);
    expect(sheetHeaderTitles()).toContain('Message details');

    await act(async () => {
      await Promise.resolve();
      press(findByTestID(renderer.root, 'message-details-select-text')[0]);
    });

    // After press: the same single Modal swaps to the Select text view.
    expect(modals()).toHaveLength(1);
    expect(sheetHeaderTitles()).toContain('Select text');
    expect(sheetHeaderTitles()).not.toContain('Message details');

    const selectable = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'SelectableText'
    );
    expect(selectable).toHaveLength(1);
    expect(selectable[0]?.props.children).toBe('selectable body');

    await unmount(renderer);
  });

  it('returns to the details view when Android back is pressed in the Select text view', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('selectable body')]));

    const modal = () => {
      const found = renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      );
      if (!found[0]) {
        throw new Error('Modal not found');
      }
      return found[0];
    };

    await act(async () => {
      await Promise.resolve();
      press(findByTestID(renderer.root, 'message-details-select-text')[0]);
    });

    const onRequestClose = modal().props.onRequestClose as (() => void) | undefined;
    expect(typeof onRequestClose).toBe('function');

    await act(async () => {
      await Promise.resolve();
      onRequestClose?.();
    });

    const sheetHeaderTitles = () =>
      renderer.root
        .findAll(node => typeof node.type === 'string' && (node.type as string) === 'SheetHeader')
        .map(node => node.props.title as string | undefined);
    expect(sheetHeaderTitles()).toContain('Message details');
    expect(sheetHeaderTitles()).not.toContain('Select text');

    await unmount(renderer);
  });

  it('hides Select text for a streaming assistant text part but keeps Copy message', async () => {
    const renderer = await mountSheet(
      storedMessage(assistantInfo(), [textPartWithTime('streaming body', { start: 1 })])
    );

    expect(findByTestID(renderer.root, 'message-details-copy')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'message-details-select-text')).toHaveLength(0);

    await unmount(renderer);
  });

  it('renders neither button when there is no copyable text', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), []));

    expect(findByTestID(renderer.root, 'message-details-copy')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'message-details-select-text')).toHaveLength(0);

    await unmount(renderer);
  });
});
