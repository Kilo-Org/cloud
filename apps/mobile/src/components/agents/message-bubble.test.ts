import { describe, expect, it, vi } from 'vitest';

import {
  assistantMessage,
  findText,
  hasAnimatedBadge,
  renderBubble,
  userMessage,
} from './message-bubble-test-utils';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('lucide-react-native', () => ({
  Clock: () => null,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('@/components/ui/bubble', () => ({
  Bubble: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./chat-markdown-text', () => ({
  ChatMarkdownText: () => null,
}));
vi.mock('./compaction-separator', () => ({
  CompactionSeparator: () => null,
}));
vi.mock('./file-part-renderer', () => ({
  FilePartRenderer: () => null,
}));
vi.mock('./part-renderer', () => ({
  PartRenderer: () => null,
}));
vi.mock('./part-types', () => ({
  isFilePart: vi.fn(() => false),
  isTextPart: vi.fn(() => false),
}));
vi.mock('./use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
}));

describe('MessageBubble queued badge', () => {
  it('renders the Queued badge when deliveryState is queued on a user message', async () => {
    const tree = await renderBubble(userMessage('m1'), { status: 'queued' });
    expect(findText(tree, t => t === 'Queued')).toBe(true);
    expect(hasAnimatedBadge(tree)).toBe(true);
  });

  it('does not render the Queued badge for a failed delivery state on a user message', async () => {
    const tree = await renderBubble(userMessage('m2'), {
      status: 'failed',
      error: 'nope',
      reason: 'exhausted',
    });
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });

  it('does not render the Queued badge when no delivery state is provided', async () => {
    const tree = await renderBubble(userMessage('m3'));
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });

  it('does not render the Queued badge for assistant messages even when delivery state is queued', async () => {
    const tree = await renderBubble(assistantMessage('m4'), { status: 'queued' });
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });
});

describe('MessageBubble regressions', () => {
  it('renders without error when deliveryState transitions from queued to undefined (badge unmounts on dequeue)', async () => {
    const message = userMessage('m5');
    const queuedTree = await renderBubble(message, { status: 'queued' });
    expect(findText(queuedTree, t => t === 'Queued')).toBe(true);

    // Same message, no more delivery state (as when `pendingMessages` drops
    // the entry once the CLI/cloud-agent starts processing it) — the badge
    // must be absent, not stuck from a prior render.
    const dequeuedTree = await renderBubble(message);
    expect(findText(dequeuedTree, t => t === 'Queued')).toBe(false);
  });
});

describe('MessageBubble user text join', () => {
  it(
    String.raw`joins text parts with \n\n so synthesized attachment notices get a blank line`,
    async () => {
      const { isTextPart } = await import('./part-types');
      vi.mocked(isTextPart).mockReturnValue(true);

      const { ChatMarkdownText: MockChatMarkdownText } = await import('./chat-markdown-text');

      const message = userMessage('m8');
      message.parts = [
        { id: 'm8-prompt', sessionID: 'ses_1', messageID: 'm8', type: 'text', text: 'prompt' },
        {
          id: 'm8-attachment',
          sessionID: 'ses_1',
          messageID: 'm8',
          type: 'text',
          text: 'attachment saved: file.pdf',
        },
      ] as typeof message.parts;

      const tree = await renderBubble(message);

      const element = findElementByTypeFn(tree, MockChatMarkdownText);
      expect(element).not.toBeNull();
      expect(element?.props.value as string).toContain('\n\n');
    }
  );
});

describe('MessageBubble in-bubble text selection context', () => {
  it('wraps the assistant parts view in InMessageBubbleContext.Provider with value true', async () => {
    const { InMessageBubbleContext } = await import('./bubble-text-selection-context');
    const tree = await renderBubble(assistantMessage('m6'));

    const provider = findProvider(tree, InMessageBubbleContext.Provider);
    expect(provider).not.toBeNull();
    expect(provider?.props.value).toBe(true);
  });

  it('wraps the user bubble content in InMessageBubbleContext.Provider with value true', async () => {
    const { InMessageBubbleContext } = await import('./bubble-text-selection-context');
    const tree = await renderBubble(userMessage('m7'));

    const provider = findProvider(tree, InMessageBubbleContext.Provider);
    expect(provider).not.toBeNull();
    expect(provider?.props.value).toBe(true);
  });
});

function findElementByTypeFn(
  node: unknown,
  typeFn: unknown
): { type: unknown; props: Record<string, unknown> } | null {
  if (node == null || typeof node !== 'object') {
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === typeFn) {
    return element as { type: unknown; props: Record<string, unknown> };
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findElementByTypeFn(child, typeFn);
      if (hit) {
        return hit;
      }
    }
  } else if (children && typeof children === 'object') {
    return findElementByTypeFn(children, typeFn);
  }
  return null;
}

function findProvider(
  node: unknown,
  providerType: unknown
): { type: unknown; props: { value?: unknown; children?: unknown } } | null {
  if (node == null || typeof node !== 'object') {
    return null;
  }
  const element = node as { type?: unknown; props?: { value?: unknown; children?: unknown } };
  if (element.type === providerType) {
    return element as { type: unknown; props: { value?: unknown; children?: unknown } };
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findProvider(child, providerType);
      if (hit) {
        return hit;
      }
    }
  } else if (children && typeof children === 'object') {
    return findProvider(children, providerType);
  }
  return null;
}
