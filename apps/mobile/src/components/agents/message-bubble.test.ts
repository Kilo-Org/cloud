import { describe, expect, it, vi } from 'vitest';

import {
  assistantMessage,
  findElementByType,
  findText,
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
  isFilePart: () => false,
  isTextPart: () => false,
}));
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
    expect(badge!.props.accessible).toBe(true);
    expect(badge!.props.accessibilityRole).toBe('text');
    expect(badge!.props.accessibilityLabel).toBe('Message queued');
    expect(badge!.props.accessibilityElementsHidden).toBeUndefined();
    expect(badge!.props.importantForAccessibility).toBeUndefined();
    expect(badge!.props.pointerEvents).toBe('auto');
    expect(typeof badge!.props.className).toBe('string');
    expect(badge!.props.className).toContain('opacity-100');
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
    expect(badge!.props.accessible).toBe(false);
    expect(badge!.props.accessibilityRole).toBeUndefined();
    expect(badge!.props.accessibilityLabel).toBeUndefined();
    expect(badge!.props.accessibilityElementsHidden).toBe(true);
    expect(badge!.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(badge!.props.pointerEvents).toBe('none');
    expect(typeof badge!.props.className).toBe('string');
    expect(badge!.props.className).toContain('opacity-0');
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
    // Both render as plain Views with the same structural Tailwind classes
    // (only opacity differs).
    const baseClass = 'flex-row items-center gap-1 self-end pr-1';
    expect(typeof queuedBadge!.props.className).toBe('string');
    expect((queuedBadge!.props.className as string).replace(/ opacity-[^\s]+/, '')).toBe(baseClass);
    expect(typeof heldBadge!.props.className).toBe('string');
    expect((heldBadge!.props.className as string).replace(/ opacity-[^\s]+/, '')).toBe(baseClass);
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
    expect(badge!.props.accessible).toBe(false);
    expect(badge!.props.pointerEvents).toBe('none');
  });

  it('does not render badge when holdQueuedSlot is not set after dequeue', async () => {
    const message = userMessage('m8');
    const heldTree = await renderBubble(message);
    expect(findText(heldTree, t => t === 'Queued')).toBe(false);
  });
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
