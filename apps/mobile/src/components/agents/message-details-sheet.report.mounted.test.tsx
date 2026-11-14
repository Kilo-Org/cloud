// Mounted regression for the report phase (04-K7): two messages can report at
// once through one mutation instance, so each invocation awaits its own call and
// settles the attempt it captured. Real TanStack mutations over a faked
// transport, because per-call callbacks would be replaced by a later call.

import {
  type AssistantMessage,
  type Part,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { MessageDetailsSheet } from './message-details-sheet';

/** One report call the transport recorded, with the settle handles its test holds. */
type ReportCall = { targetId: string; settle: (ok: boolean) => void };

const native = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: native.announce },
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
// The confirmation renders through the real hook; only its native sheet is a
// marker, so the test can read the request and accept it.
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: 'DestructiveConfirmDialog',
}));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'View' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#000', mutedForeground: '#999' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

const reportCalls = vi.hoisted(() => ({
  /** One pending report call per invocation, settled by the test. */
  calls: [] as ReportCall[],
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      reportContent: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: (input: { targetId: string }) =>
            new Promise((resolve, reject) => {
              reportCalls.calls.push({
                targetId: input.targetId,
                settle: (ok: boolean) => {
                  if (ok) {
                    resolve({ receiptId: `receipt-${input.targetId}` });
                    return;
                  }
                  reject(new Error('The report could not be filed.'));
                },
              });
            }),
        }),
      },
    },
  }),
}));

function assistantInfo(id: string): AssistantMessage {
  return {
    id,
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
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function textPart(messageId: string, text: string): Part {
  return { id: `p-${messageId}`, sessionID: 'ses-1', messageID: messageId, type: 'text', text };
}

function storedMessage(id: string, text: string): StoredMessage {
  return { info: assistantInfo(id), parts: [textPart(id, text)] };
}

const MESSAGE_A = storedMessage('msg-a', 'first response');
const MESSAGE_B = storedMessage('msg-b', 'second response');

function sheetElement(message: StoredMessage) {
  return createElement(MessageDetailsSheet, {
    visible: true,
    message,
    modelOptions: [],
    onClose: vi.fn<() => void>(),
  });
}

/** An update tree keeps the provider the renderer mounted with, or the sheet loses it. */
function withinProviders(queryClient: QueryClient, message: StoredMessage) {
  return createElement(QueryClientProvider, { client: queryClient }, sheetElement(message));
}

function reportButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => node.props.testID === 'message-details-report')[0];
}

/** Presses Report and accepts its confirmation, then lets the call reach the transport. */
async function report(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  const button = reportButton(renderer);
  if (!button) {
    throw new Error('no Report button');
  }
  act(() => {
    (button.props.onPress as () => void)();
  });
  const confirmation = renderer.root.findAllByType('DestructiveConfirmDialog')[0];
  if (!confirmation) {
    throw new Error('missing report confirmation');
  }
  await act(async () => {
    (confirmation.props.onConfirm as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  reportCalls.calls.length = 0;
  native.announce.mockClear();
});

describe('MessageDetailsSheet report phase', () => {
  it('a report for A that fails after B started leaves B pending and returns A its button', async () => {
    const first = await renderWithProviders(sheetElement(MESSAGE_A));
    await report(first.renderer);
    expect(reportCalls.calls.map(call => call.targetId)).toEqual(['msg-a']);
    // A's own button is gone while its report is in flight.
    expect(reportButton(first.renderer)).toBeUndefined();

    // The sheet switches to B while A is still reporting, and B is reported too.
    await act(async () => {
      first.renderer.update(withinProviders(first.queryClient, MESSAGE_B));
      await Promise.resolve();
    });
    await report(first.renderer);
    expect(reportCalls.calls.map(call => call.targetId)).toEqual(['msg-a', 'msg-b']);
    expect(reportButton(first.renderer)).toBeUndefined();

    // A fails after B started: only A's attempt settles.
    await act(async () => {
      reportCalls.calls[0]?.settle(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    // B is still pending, so its button stays hidden.
    expect(reportButton(first.renderer)).toBeUndefined();

    // Back on A, its Report button is live again for the retry.
    await act(async () => {
      first.renderer.update(withinProviders(first.queryClient, MESSAGE_A));
      await Promise.resolve();
    });
    expect(reportButton(first.renderer)).toBeDefined();

    await act(async () => {
      reportCalls.calls[1]?.settle(true);
      await Promise.resolve();
    });
    first.renderer.unmount();
  });

  it('a second confirm while A is reporting files one report', async () => {
    const mounted = await renderWithProviders(sheetElement(MESSAGE_A));

    await report(mounted.renderer);
    expect(reportCalls.calls).toHaveLength(1);

    // A second confirm for the same message is refused by admission: the
    // button is hidden, and even a repeated confirm settles nothing new.
    const confirmation = mounted.renderer.root.findAllByType('DestructiveConfirmDialog')[0];
    if (confirmation) {
      act(() => {
        (confirmation.props.onConfirm as () => void)();
      });
    }
    expect(reportCalls.calls).toHaveLength(1);

    await act(async () => {
      reportCalls.calls[0]?.settle(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    // A completed report keeps its button hidden.
    expect(reportButton(mounted.renderer)).toBeUndefined();
    mounted.renderer.unmount();
  });
});