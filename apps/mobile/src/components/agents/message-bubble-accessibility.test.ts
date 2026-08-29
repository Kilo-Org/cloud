import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import type * as React from 'react';
import { type AccessibilityActionEvent } from 'react-native';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  assistantMessage,
  findElementByType,
  isActionsOverlayProps,
  userMessage,
} from './message-bubble-test-utils';

const clipboard = vi.hoisted(() => ({ text: '' }));
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
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));
vi.mock('./compaction-separator', () => ({ CompactionSeparator: 'CompactionSeparator' }));
vi.mock('./file-part-renderer', () => ({ FilePartRenderer: 'FilePartRenderer' }));
vi.mock('./part-renderer', () => ({ PartRenderer: 'PartRenderer' }));

describe.each([
  { role: 'user', makeMessage: userMessage, label: 'User message' },
  { role: 'assistant', makeMessage: assistantMessage, label: 'Assistant message' },
])('MessageBubble accessibility: $role', ({ makeMessage, label }) => {
  it.each([
    { text: true, callback: true, actions: ['details', 'copy'], copied: 'hi' },
    { text: false, callback: true, actions: ['details'], copied: 'unchanged' },
    { text: true, callback: false, actions: ['copy'], copied: 'hi' },
    { text: false, callback: false, actions: [], copied: 'unchanged' },
  ])(
    'preserves descendants and executes actions with text=$text callback=$callback',
    async ({ text, callback, actions, copied }) => {
      const message = makeMessage('message-1');
      message.parts = [
        ...(text ? userMessage('message-1').parts : []),
        {
          id: 'file-1',
          sessionID: 'ses_1',
          messageID: message.info.id,
          type: 'file',
          mime: 'text/plain',
          url: 'file:///attachment.txt',
        },
      ];
      const selected: StoredMessage[] = [];
      const { MessageBubble } = await import('./message-bubble');
      // eslint-disable-next-line new-cap
      const tree = MessageBubble.type({
        message,
        onLongPressDetails: callback
          ? value => {
              selected.push(value);
            }
          : undefined,
      });
      const wrapper = findElementByType(tree, 'Pressable');
      expect(wrapper?.props.accessible).toBe(false);
      expect(wrapper?.props.accessibilityRole).toBeUndefined();
      expect(wrapper?.props.accessibilityLabel).toBeUndefined();
      expect(wrapper?.props.accessibilityHint).toBeUndefined();
      expect(wrapper?.props.accessibilityActions).toBeUndefined();
      expect(wrapper?.props.accessibilityElementsHidden).toBeUndefined();
      const body = findElementByType(tree, label === 'User message' ? 'Bubble' : 'View', props =>
        Boolean(props.children)
      );
      expect(body).not.toBeNull();
      expect(body?.props.accessible).not.toBe(true);
      clipboard.text = 'unchanged';
      if (!wrapper) {
        throw new Error('Message wrapper is missing');
      }
      (wrapper.props.onLongPress as () => void)();
      expect(selected).toEqual(callback ? [message] : []);
      expect(clipboard.text).toBe('unchanged');

      const host = findElementByType(tree, 'View', isActionsOverlayProps);
      if (actions.length === 0) {
        expect(host).toBeNull();
        return;
      }
      expect(host?.props.accessibilityRole).toBe('text');
      expect(host?.props.accessibilityLabel).toBe(label);
      expect(host?.props.children).toBeUndefined();
      const exposed = host?.props.accessibilityActions as { name: string; label: string }[];
      expect(exposed.map(action => action.name)).toEqual(actions);
      if (callback) {
        expect(exposed).toContainEqual({ name: 'details', label: 'Message details' });
        expect(host?.props.accessibilityHint).toBe('Long press for message details');
      }
      const invoke = host?.props.onAccessibilityAction as (
        event: Pick<AccessibilityActionEvent, 'nativeEvent'>
      ) => void;
      invoke({ nativeEvent: { actionName: 'details' } });
      expect(selected).toEqual(callback ? [message, message] : []);
      expect(clipboard.text).toBe('unchanged');
      invoke({ nativeEvent: { actionName: 'copy' } });
      await Promise.resolve();
      expect(clipboard.text).toBe(copied);
      expect(selected).toEqual(callback ? [message, message] : []);
    }
  );
});
