import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import type * as React from 'react';
import { type AccessibilityActionEvent } from 'react-native';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';
import {
  assistantMessage,
  findElementByType,
  isActionsOverlayProps,
  userMessage,
} from './message-bubble-test-utils';

const clipboard = vi.hoisted(() => ({ text: '' }));
// The direct element harness needs only the copy hook's callback, not a mounted hook dispatcher.
vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof React>()),
  useCallback: <T>(fn: T) => fn,
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return { ...actual, useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }) };
});
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => {
    clipboard.text = text;
  },
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ Clock: 'Clock' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));
vi.mock('@/components/ui/bubble', () => ({ Bubble: 'Bubble' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));
vi.mock('./compaction-separator', () => ({ CompactionSeparator: 'CompactionSeparator' }));
vi.mock('./file-part-renderer', () => ({ FilePartRenderer: 'FilePartRenderer' }));
vi.mock('./part-renderer', () => ({ PartRenderer: 'PartRenderer' }));

describe.each([
  { role: 'user', makeMessage: userMessage, label: 'User message' },
  { role: 'assistant', makeMessage: assistantMessage, label: 'Assistant message' },
])('message actions for $role messages', ({ makeMessage, label, role }) => {
  it.each([
    { kind: 'text', details: true, actions: ['details', 'copy'], copied: 'hi' },
    { kind: 'files', details: true, actions: ['details'], copied: 'unchanged' },
    { kind: 'text', details: false, actions: ['copy'], copied: 'hi' },
    { kind: 'files', details: false, actions: [], copied: 'unchanged' },
  ])(
    'executes $kind actions with details callback=$details',
    async ({ kind, details, actions, copied }) => {
      const message = makeMessage('message-1');
      message.parts =
        kind === 'text'
          ? userMessage('message-1').parts
          : [
              {
                id: 'file-1',
                sessionID: 'ses_1',
                messageID: message.info.id,
                type: 'file',
                mime: 'text/plain',
                url: 'file:///attachment.txt',
              },
            ];
      const selection: { message?: StoredMessage } = {};
      const props = buildAgentMessageBubbleAccessibilityProps({
        isUser: role === 'user',
        canCopy: kind === 'text',
        canOpenDetails: details,
      });
      expect(props.accessibilityActions.map(action => action.name)).toEqual(actions);
      expect(props.accessibilityLabel).toBe(label);
      expect(props.accessibilityHint).toBe(details ? 'Long press for message details' : '');

      const { MessageBubble } = await import('./message-bubble');
      // eslint-disable-next-line new-cap
      const tree = MessageBubble.type({
        message,
        onLongPressDetails: details
          ? selected => {
              selection.message = selected;
            }
          : undefined,
      });
      const wrapper = findElementByType(tree, 'Pressable');
      expect(wrapper?.props.accessible).toBe(false);
      expect(wrapper?.props.accessibilityActions).toBeUndefined();
      const host = findElementByType(tree, 'View', isActionsOverlayProps);
      if (actions.length === 0) {
        expect(host).toBeNull();
        return;
      }
      expect(host?.props.accessibilityActions).toEqual(props.accessibilityActions);
      expect(host?.props.accessibilityRole).toBe('text');
      const invoke = host?.props.onAccessibilityAction as (
        event: Pick<AccessibilityActionEvent, 'nativeEvent'>
      ) => void;
      clipboard.text = 'unchanged';
      invoke({ nativeEvent: { actionName: 'details' } });
      expect(selection.message).toBe(details ? message : undefined);
      expect(clipboard.text).toBe('unchanged');
      invoke({ nativeEvent: { actionName: 'copy' } });
      await Promise.resolve();
      expect(clipboard.text).toBe(copied);
      expect(selection.message).toBe(details ? message : undefined);
    }
  );
});
