/* eslint-disable max-lines -- Queued-badge, delivery, a11y, and time-label seams share the direct-invocation MessageBubble harness. */
import { describe, expect, it, vi } from 'vitest';

import { formatTranscriptTimeLabel } from './message-time-label';
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
  isFilePart: vi.fn(() => false),
  isTextPart: vi.fn(() => false),
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

describe('MessageBubble time label', () => {
  it('renders a same-day time label matching the formatter evaluated in the test', async () => {
    const created = Date.now();
    const message = userMessage('m-time-same-day');
    message.info.time = { created };
    const tree = await renderBubble(message);
    const expected = formatTranscriptTimeLabel(created, Date.now());
    expect(expected).not.toBeNull();
    expect(findText(tree, t => t === expected)).toBe(true);
  });

  it('renders the user time label in the meta row after the queued badge slot', async () => {
    const tree = await renderBubble(userMessage('m-time-user'), { status: 'queued' });
    const metaRow = findElementByType(
      tree,
      'View',
      p =>
        typeof p.className === 'string' &&
        p.className.includes('flex-row items-center gap-2 self-end pr-1')
    );
    expect(metaRow).not.toBeNull();
    if (!metaRow) {
      throw new Error('expected meta row');
    }
    const children = Array.isArray(metaRow.props.children)
      ? metaRow.props.children
      : [metaRow.props.children];
    expect(children.length).toBe(2);
    const badge = children[0] as { props?: Record<string, unknown> };
    const badgeClass = typeof badge.props?.className === 'string' ? badge.props.className : null;
    expect(badgeClass).not.toBeNull();
    expect(badgeClass?.includes(BADGE_CLASS)).toBe(true);
    const label = children[1] as { props?: Record<string, unknown> };
    const labelClass = typeof label.props?.className === 'string' ? label.props.className : null;
    expect(labelClass).not.toBeNull();
    expect(labelClass?.includes('tabular-nums')).toBe(true);
    expect(typeof label.props?.children).toBe('string');
  });

  it('renders the assistant time label after the parts view', async () => {
    const tree = await renderBubble(assistantMessage('m-time-asst'));
    const pressable = findElementByType(tree, 'Pressable');
    expect(pressable).not.toBeNull();
    if (!pressable) {
      throw new Error('expected pressable');
    }
    const children = Array.isArray(pressable.props.children)
      ? pressable.props.children
      : [pressable.props.children];
    const partsIndex = children.findIndex(child =>
      subtreeContains(child, p => typeof p.className === 'string' && p.className.includes('gap-2'))
    );
    const labelIndex = children.findIndex(child => subtreeContainsTimeLabel(child));
    expect(partsIndex).toBeGreaterThanOrEqual(0);
    expect(labelIndex).toBeGreaterThan(partsIndex);
  });

  it('does not render a time label when time.created is absent', async () => {
    const message = userMessage('m-time-absent');
    (message.info.time as { created?: number }).created = undefined;
    const tree = await renderBubble(message);
    expect(findTimeLabel(tree)).toBeNull();
  });

  it('does not render a time label when time.created is invalid', async () => {
    const message = assistantMessage('m-time-invalid');
    message.info.time = { created: Number.NaN };
    const tree = await renderBubble(message);
    expect(findTimeLabel(tree)).toBeNull();
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

function subtreeContains(
  node: unknown,
  predicate: (props: Record<string, unknown>) => boolean
): boolean {
  if (node == null || typeof node !== 'object') {
    return false;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (predicate(element.props ?? {})) {
    return true;
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    return children.some(child => subtreeContains(child, predicate));
  }
  if (children && typeof children === 'object') {
    return subtreeContains(children, predicate);
  }
  return false;
}

function subtreeContainsTimeLabel(node: unknown): boolean {
  return subtreeContains(
    node,
    p => typeof p.className === 'string' && p.className.includes('tabular-nums')
  );
}

function findTimeLabel(node: unknown): { props: Record<string, unknown> } | null {
  if (node == null || typeof node !== 'object') {
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  const props = element.props ?? {};
  if (typeof props.className === 'string' && props.className.includes('tabular-nums')) {
    return { props };
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findTimeLabel(child);
      if (hit) {
        return hit;
      }
    }
  } else if (children && typeof children === 'object') {
    return findTimeLabel(children);
  }
  return null;
}
