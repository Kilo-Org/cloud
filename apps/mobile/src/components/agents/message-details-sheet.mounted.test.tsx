/* eslint-disable max-lines -- The mounted sheet suite shares native boundaries across actions, selection, and announcements. */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import {
  type AssistantMessage,
  type Part,
  type StoredMessage,
  type UserMessage,
} from '@kilocode/cloud-agent-sdk';
import { type ComponentProps, createElement, type ReactElement } from 'react';
import { ActivityIndicator, Alert, Modal, ScrollView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetHeader } from '@/components/sheet-header';
import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';

import { MessageDetailsSheet } from './message-details-sheet';

const native = vi.hoisted(() => ({ clipboard: '', announce: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#000', mutedForeground: '#999' }),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: native.announce },
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    onSuccess: (result: { receiptId: string }, input: unknown) => void;
  }) => ({
    mutate: (input: unknown) => {
      options.onSuccess({ receiptId: 'receipt-1' }, input);
    },
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      reportContent: { mutationOptions: (options: unknown) => options },
    },
  }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'View' }));
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
vi.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => {
    native.clipboard = text;
  },
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  native.clipboard = '';
  native.announce.mockClear();
  vi.mocked(Alert.alert).mockClear();
});

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

type SheetOverrides = Partial<ComponentProps<typeof MessageDetailsSheet>>;

function sheetElement(message: StoredMessage | null, overrides: SheetOverrides = {}): ReactElement {
  return createElement(MessageDetailsSheet, {
    visible: true,
    message,
    modelOptions: [],
    onClose: vi.fn<() => void>(),
    ...overrides,
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

async function mountSheet(
  message: StoredMessage | null,
  overrides: SheetOverrides = {}
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(sheetElement(message, overrides));
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
  it('presses cancellation and follows eligible, busy, ineligible, empty, and file-only states', async () => {
    const message = storedMessage(userInfo(), [textPart('queued')]);
    const selected: StoredMessage[] = [];
    const onCancelQueued = (value: StoredMessage) => {
      selected.push(value);
    };
    const renderer = await mountSheet(message, { canCancelQueued: true, onCancelQueued });
    const row = () => findByTestID(renderer.root, 'message-details-cancel-queued')[0];
    act(() => {
      press(row());
    });
    expect(selected).toEqual([message]);
    act(() => {
      renderer.update(
        sheetElement(message, { canCancelQueued: false, isCancelingQueued: true, onCancelQueued })
      );
    });
    expect(row()?.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(row()?.props.accessibilityLabel).toBe('Cancel queued message');
    expect(row()?.props.disabled).toBe(true);
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    act(() => {
      press(row());
    });
    expect(selected).toEqual([message]);
    act(() => {
      renderer.update(sheetElement(message, { canCancelQueued: false, onCancelQueued }));
    });
    expect(row()).toBeUndefined();
    act(() => {
      renderer.update(sheetElement(null, { canCancelQueued: true, onCancelQueued }));
    });
    expect(row()).toBeUndefined();
    const fileOnly = storedMessage(userInfo({ id: 'file-message' }), [
      {
        id: 'file-1',
        sessionID: 'ses-1',
        messageID: 'file-message',
        type: 'file',
        mime: 'text/plain',
        url: 'file:///attachment.txt',
      },
    ]);
    act(() => {
      renderer.update(sheetElement(fileOnly, { canCancelQueued: true, onCancelQueued }));
    });
    expect(findByTestID(renderer.root, 'message-details-copy')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'message-details-select-text')).toHaveLength(0);
    act(() => {
      press(row());
    });
    expect(selected).toEqual([message, fileOnly]);
    await unmount(renderer);
  });

  it('announces an identical failure again after a cleared retry, without speech on hiding', async () => {
    const message = storedMessage(userInfo(), [textPart('queued')]);
    const failure = 'Could not cancel the queued message.';
    const renderer = await mountSheet(message, {
      cancelQueuedFeedback: { message: failure, attempt: 1 },
    });
    expect(
      renderer.root.findAll(node => node.type === Text && node.props.children === failure)
    ).toHaveLength(1);
    expect(native.announce.mock.calls).toEqual([[failure]]);
    act(() => {
      renderer.update(
        sheetElement(message, { cancelQueuedFeedback: null, isCancelingQueued: true })
      );
    });
    expect(
      renderer.root.findAll(node => node.type === Text && node.props.children === failure)
    ).toHaveLength(0);
    expect(native.announce.mock.calls).toEqual([[failure]]);
    act(() => {
      renderer.update(
        sheetElement(message, { cancelQueuedFeedback: { message: failure, attempt: 2 } })
      );
    });
    expect(native.announce.mock.calls).toEqual([[failure], [failure]]);
    act(() => {
      renderer.update(
        sheetElement(message, {
          visible: false,
          cancelQueuedFeedback: { message: failure, attempt: 2 },
        })
      );
    });
    expect(native.announce.mock.calls).toEqual([[failure], [failure]]);
    await unmount(renderer);
  });

  it('keeps upgrade guidance readable on reopening without announcing the outcome again', async () => {
    const message = storedMessage(userInfo(), [textPart('queued')]);
    const guidance =
      'Canceling queued messages requires a newer Kilo CLI. Update Kilo CLI and reconnect.';
    const renderer = await mountSheet(message, {
      cancelQueuedGuidance: guidance,
      cancelQueuedFeedback: { message: guidance, attempt: 1 },
    });
    const guidanceNodes = () =>
      renderer.root.findAll(node => node.type === Text && node.props.children === guidance);
    expect(guidanceNodes()).toHaveLength(1);
    expect(native.announce.mock.calls).toEqual([[guidance]]);
    act(() => {
      renderer.update(sheetElement(message, { visible: false, cancelQueuedGuidance: guidance }));
    });
    expect(guidanceNodes()).toHaveLength(0);
    act(() => {
      renderer.update(sheetElement(message, { cancelQueuedGuidance: guidance }));
    });
    expect(guidanceNodes()).toHaveLength(1);
    expect(guidanceNodes()[0]?.props.accessibilityLiveRegion).toBeUndefined();
    expect(native.announce.mock.calls).toEqual([[guidance]]);
    expect(findByTestID(renderer.root, 'message-details-cancel-queued')).toHaveLength(0);
    act(() => {
      renderer.update(sheetElement(null, { cancelQueuedGuidance: guidance }));
    });
    expect(guidanceNodes()).toHaveLength(0);
    await unmount(renderer);
  });

  it('keeps real Copy and confirmed Report outcomes on the details sheet', async () => {
    const message = storedMessage(assistantInfo(), [textPart('copy this response')]);
    const renderer = await mountSheet(message);
    await act(async () => {
      press(findByTestID(renderer.root, 'message-details-copy')[0]);
      await Promise.resolve();
    });
    expect(native.clipboard).toBe('copy this response');
    act(() => {
      press(findByTestID(renderer.root, 'message-details-report')[0]);
    });
    expect(findByTestID(renderer.root, 'message-details-report')).toHaveLength(1);
    const confirm = vi
      .mocked(Alert.alert)
      .mock.calls.at(-1)?.[2]
      ?.find(button => button.style === 'destructive');
    act(() => confirm?.onPress?.());
    expect(findByTestID(renderer.root, 'message-details-report')).toHaveLength(0);
    act(() => {
      renderer.update(
        sheetElement(
          storedMessage(assistantInfo({ id: 'another-response' }), [textPart('another response')])
        )
      );
    });
    expect(findByTestID(renderer.root, 'message-details-report')).toHaveLength(1);
    await unmount(renderer);
  });

  it('renders Copy message and Select text for a finished copyable user message', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('hello world')]));

    expect(findByTestID(renderer.root, 'message-details-copy')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'message-details-select-text')).toHaveLength(1);

    await unmount(renderer);
  });

  it('sizes the details ScrollView to fill the sheet surface with flex-1', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('hello world')]));

    const scrollViews = renderer.root.findAll(node => node.type === ScrollView);
    expect(scrollViews).toHaveLength(1);
    expect(scrollViews[0]?.props.className).toBe('flex-1');

    await unmount(renderer);
  });

  it('swaps the details Modal content to the select view when Select text is pressed', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('selectable body')]));

    const modals = () => renderer.root.findAll(node => node.type === Modal);
    const sheetHeaderTitles = () =>
      renderer.root
        .findAll(node => node.type === SheetHeader)
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

    const selectable = renderer.root.findAll(node => node.type === SelectableText);
    expect(selectable).toHaveLength(1);
    expect(selectable[0]?.props.children).toBe('selectable body');

    await unmount(renderer);
  });

  it('returns to the details view when Android back is pressed in the Select text view', async () => {
    const renderer = await mountSheet(storedMessage(userInfo(), [textPart('selectable body')]));

    const modal = () => {
      const found = renderer.root.findAll(node => node.type === Modal);
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
        .findAll(node => node.type === SheetHeader)
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
