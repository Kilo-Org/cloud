/* eslint-disable max-lines -- Queued-badge, delivery, and a11y seams share the direct-invocation MessageBubble harness. */
import { describe, expect, it, vi } from 'vitest';

import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import type * as PartTypes from './part-types';
import {
  assistantMessage,
  findElementByType,
  findText,
  pressableProps,
  renderBubble,
  userMessage,
} from './message-bubble-test-utils';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({
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
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
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
vi.mock('./part-types', async () => {
  const actual = await vi.importActual<typeof PartTypes>('./part-types');
  return {
    ...actual,
    isFilePart: vi.fn(() => false),
    isTextPart: vi.fn(() => false),
  };
});
vi.mock('./use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
}));

const BADGE_CLASS = 'flex-row items-center gap-1 self-end pr-1';

describe('MessageBubble queued badge', () => {
  it('renders the Queued badge visible when deliveryState is queued', async () => {
    const tree = await renderBubble(userMessage('m1'), { status: 'queued' });
    expect(findText(tree, t => t === 'Queued')).toBe(true);
    const badge = findElementByType(
      tree,
      'View',
      p => typeof p.className === 'string' && p.className.includes(BADGE_CLASS)
    );
    expect(badge).not.toBeNull();
    if (!badge) {
      throw new Error('expected badge');
    }
    expect(badge.props.accessible).toBe(true);
    expect(badge.props.accessibilityRole).toBe('text');
    expect(badge.props.accessibilityLabel).toBe('Message queued');
    expect(badge.props.accessibilityElementsHidden).toBeUndefined();
    expect(badge.props.importantForAccessibility).toBeUndefined();
    expect(badge.props.pointerEvents).toBe('auto');
    expect(typeof badge.props.className).toBe('string');
    expect(badge.props.className).toContain('opacity-100');
  });

  it('renders a held badge slot when holdQueuedSlot is set but deliveryState is absent', async () => {
    const tree = await renderBubble(userMessage('m2'), undefined, true);
    expect(findText(tree, t => t === 'Queued')).toBe(true);
    const badge = findElementByType(
      tree,
      'View',
      p => typeof p.className === 'string' && p.className.includes(BADGE_CLASS)
    );
    expect(badge).not.toBeNull();
    if (!badge) {
      throw new Error('expected badge');
    }
    expect(badge.props.accessible).toBe(false);
    expect(badge.props.accessibilityRole).toBeUndefined();
    expect(badge.props.accessibilityLabel).toBeUndefined();
    expect(badge.props.accessibilityElementsHidden).toBe(true);
    expect(badge.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(badge.props.pointerEvents).toBe('none');
    expect(typeof badge.props.className).toBe('string');
    expect(badge.props.className).toContain('opacity-0');
  });

  it('does not render the badge when neither deliveryState nor holdQueuedSlot is set', async () => {
    const tree = await renderBubble(userMessage('m3'));
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });

  it('badge row is structurally identical between queued and held-only states', async () => {
    const queuedTree = await renderBubble(userMessage('m4'), { status: 'queued' });
    const heldTree = await renderBubble(userMessage('m4'), undefined, true);
    const queuedBadge = findElementByType(
      queuedTree,
      'View',
      p => typeof p.className === 'string' && p.className.includes(BADGE_CLASS)
    );
    const heldBadge = findElementByType(
      heldTree,
      'View',
      p => typeof p.className === 'string' && p.className.includes(BADGE_CLASS)
    );
    expect(queuedBadge).not.toBeNull();
    expect(heldBadge).not.toBeNull();
    if (!queuedBadge || !heldBadge) {
      throw new Error('expected badges');
    }
    // Both render as plain Views with the same structural Tailwind classes
    // (only opacity differs).
    const baseClass = 'flex-row items-center gap-1 self-end pr-1';
    expect(typeof queuedBadge.props.className).toBe('string');
    expect((queuedBadge.props.className as string).replace(/ opacity-[^\s]+/, '')).toBe(baseClass);
    expect(typeof heldBadge.props.className).toBe('string');
    expect((heldBadge.props.className as string).replace(/ opacity-[^\s]+/, '')).toBe(baseClass);
    // Both contain the Queued text child
    expect(findText(heldBadge, t => t === 'Queued')).toBe(true);
  });

  it('does not render the badge for assistant messages when delivery state is queued', async () => {
    const tree = await renderBubble(assistantMessage('m5'), { status: 'queued' });
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });
});

describe('MessageBubble failed delivery state', () => {
  it('does not render the badge for a failed delivery state on a user message', async () => {
    const tree = await renderBubble(userMessage('m6'), {
      status: 'failed',
      error: 'nope',
      reason: 'exhausted',
    });
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });
});

async function renderBubbleWithHandlers(
  message: StoredMessage,
  props: {
    deliveryState?: MessageDeliveryState;
    onRetryMessage?: (m: StoredMessage) => void;
    onCopyToComposer?: (text: string) => void;
  }
): Promise<unknown> {
  const { MessageBubble } = await import('./message-bubble');
  // eslint-disable-next-line new-cap
  return MessageBubble.type({ message, ...props });
}

function assistantMessageWithError(id: string, errorName: string): StoredMessage {
  const message = assistantMessage(id);
  (message.info as { error?: { name: string; data: unknown } }).error = {
    name: errorName,
    data: { message: 'raw' },
  };
  return message;
}

describe('MessageBubble failure footer', () => {
  it('renders the failed-delivery footer with Retry and Copy to composer', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-fail'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });
    expect(findText(tree, t => t === 'Failed to deliver')).toBe(true);
    expect(
      findText(tree, t => t === 'We could not deliver this message after several attempts.')
    ).toBe(true);
    const retry = findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry');
    expect(retry).not.toBeNull();
    expect(retry?.props.accessibilityRole).toBe('button');
    const copy = findElementByType(
      tree,
      'Button',
      p => p.accessibilityLabel === 'Copy to composer'
    );
    expect(copy).not.toBeNull();
    expect(copy?.props.accessibilityRole).toBe('button');
  });

  it('renders the assistant failure footer with Retry and no Copy to composer', async () => {
    const tree = await renderBubbleWithHandlers(assistantMessageWithError('m-asst', 'APIError'), {
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
    });
    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    const retry = findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry');
    expect(retry).not.toBeNull();
    expect(
      findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Copy to composer')
    ).toBeNull();
  });

  it('omits the Retry button for a non-retryable assistant error', async () => {
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-nr', 'ProviderAuthError'),
      { onRetryMessage: vi.fn<(message: StoredMessage) => void>() }
    );
    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
  });

  it('does not render the footer when no handler is supplied', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-nohandler'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
    });
    expect(findText(tree, t => t === 'Failed to deliver')).toBe(false);
  });

  it('names the failure row on the title text without grouping the CTA buttons', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-a11y'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'interrupted' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });

    // The footer container is a plain View: no accessible, no role, no label,
    // so Retry and Copy stay individually focusable.
    const footer = findElementByType(tree, 'View', p => p.className === 'gap-1 px-4 py-1');
    expect(footer).not.toBeNull();
    expect(footer?.props.accessible).toBeUndefined();
    expect(footer?.props.accessibilityRole).toBeUndefined();
    expect(footer?.props.accessibilityLabel).toBeUndefined();

    // The row name lives on the title Text, which still announces the row.
    const title = findElementByLabel(tree, 'Failed to deliver. Retry available.');
    expect(title).not.toBeNull();
    expect(title?.props.children).toBe('Failed to deliver');
  });

  it('presses Retry to retry the failed message and Copy to composer to restore the user text', async () => {
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockReturnValue(true);

    const message = userMessage('m-press');
    const onRetryMessage = vi.fn<(message: StoredMessage) => void>();
    const onCopyToComposer = vi.fn<(text: string) => void>();
    const tree = await renderBubbleWithHandlers(message, {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onRetryMessage,
      onCopyToComposer,
    });

    const retry = findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry');
    expect(retry).not.toBeNull();
    if (!retry) {
      throw new Error('expected Retry button');
    }
    (retry.props.onPress as () => void)();
    expect(onRetryMessage).toHaveBeenCalledWith(message);

    const copy = findElementByType(
      tree,
      'Button',
      p => p.accessibilityLabel === 'Copy to composer'
    );
    expect(copy).not.toBeNull();
    if (!copy) {
      throw new Error('expected Copy to composer button');
    }
    (copy.props.onPress as () => void)();
    expect(onCopyToComposer).toHaveBeenCalledWith('hi');
  });

  it('presses Retry on an assistant row to retry the failed message', async () => {
    const message = assistantMessageWithError('m-asst-press', 'APIError');
    const onRetryMessage = vi.fn<(message: StoredMessage) => void>();
    const tree = await renderBubbleWithHandlers(message, { onRetryMessage });

    const retry = findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry');
    expect(retry).not.toBeNull();
    if (!retry) {
      throw new Error('expected Retry button');
    }
    (retry.props.onPress as () => void)();
    expect(onRetryMessage).toHaveBeenCalledWith(message);
  });
});

describe('MessageBubble copy-to-composer human text', () => {
  it('passes only the first human text part to Copy, not the synthesized notice', async () => {
    const message = userMessage('m-copy-human');
    message.parts = [
      {
        id: 'm-copy-human-prompt',
        sessionID: 'ses_1',
        messageID: 'm-copy-human',
        type: 'text',
        text: 'prompt',
      },
      {
        id: 'm-copy-human-notice',
        sessionID: 'ses_1',
        messageID: 'm-copy-human',
        type: 'text',
        text: 'binary attachment saved: … path=…',
        synthetic: true,
      },
    ] as typeof message.parts;

    const onCopyToComposer = vi.fn<(text: string) => void>();
    const tree = await renderBubbleWithHandlers(message, {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onCopyToComposer,
    });

    const copy = findElementByType(
      tree,
      'Button',
      p => p.accessibilityLabel === 'Copy to composer'
    );
    expect(copy).not.toBeNull();
    if (!copy) {
      throw new Error('expected Copy to composer button');
    }
    (copy.props.onPress as () => void)();
    expect(onCopyToComposer).toHaveBeenCalledWith('prompt');
  });

  it('hides Copy for a file-only failed row', async () => {
    const message = userMessage('m-copy-file');
    message.parts = [
      {
        id: 'm-copy-file-file',
        sessionID: 'ses_1',
        messageID: 'm-copy-file',
        type: 'file',
        mime: 'text/plain',
        url: 'x',
      },
    ] as typeof message.parts;

    const onCopyToComposer = vi.fn<(text: string) => void>();
    const tree = await renderBubbleWithHandlers(message, {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onCopyToComposer,
    });

    expect(
      findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Copy to composer')
    ).toBeNull();
  });
});

describe('MessageBubble regressions', () => {
  it('holds badge slot when queued and holdQueuedSlot is set after dequeue', async () => {
    const message = userMessage('m7');
    // Queued: badge visible with Queued text
    const queuedTree = await renderBubble(message, { status: 'queued' });
    expect(findText(queuedTree, t => t === 'Queued')).toBe(true);
    // Dequeued with holdQueuedSlot: badge stays mounted but invisible
    const heldTree = await renderBubble(message, undefined, true);
    expect(findText(heldTree, t => t === 'Queued')).toBe(true);
    const badge = findElementByType(
      heldTree,
      'View',
      p => typeof p.className === 'string' && p.className.includes(BADGE_CLASS)
    );
    expect(badge).not.toBeNull();
    if (!badge) {
      throw new Error('expected badge');
    }
    expect(badge.props.accessible).toBe(false);
    expect(badge.props.pointerEvents).toBe('none');
  });

  it('does not render badge when holdQueuedSlot is not set after dequeue', async () => {
    const message = userMessage('m8');
    const heldTree = await renderBubble(message);
    expect(findText(heldTree, t => t === 'Queued')).toBe(false);
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

describe('MessageBubble row rhythm', () => {
  // Spacing class contract: two parts of one assistant message sit gap-2
  // apart; two adjacent messages sit py-1 + py-1 apart, the same value; the
  // user wrapper carries the same py-1, so user/assistant boundaries keep the
  // rhythm. One value, three class assertions.
  it('applies the uniform row-rhythm class contract', async () => {
    const assistantTree = await renderBubble(assistantMessage('rhythm-a'));
    const parts = findElementByType(assistantTree, 'View', p => p.className === 'gap-2');
    expect(parts).not.toBeNull();

    const assistantPressable = pressableProps(assistantTree);
    expect(assistantPressable?.className).toBe('px-4 py-1');

    const userTree = await renderBubble(userMessage('rhythm-b'));
    const userPressable = pressableProps(userTree);
    expect(userPressable?.className).toBe('px-4 py-1');
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

function findElementByLabel(
  node: unknown,
  label: string
): { type: unknown; props: Record<string, unknown> } | null {
  if (node == null || typeof node !== 'object') {
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.props?.accessibilityLabel === label) {
    return element as { type: unknown; props: Record<string, unknown> };
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findElementByLabel(child, label);
      if (hit) {
        return hit;
      }
    }
  } else if (children && typeof children === 'object') {
    return findElementByLabel(children, label);
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
