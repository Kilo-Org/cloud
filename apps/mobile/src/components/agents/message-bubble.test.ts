import { type MessageDeliveryState, type StoredMessage } from 'cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';

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
  isFilePart: () => false,
  isTextPart: () => false,
}));
vi.mock('./use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
}));
vi.mock('./message-bubble-a11y', async () => {
  const actual = await vi.importActual<{
    buildAgentMessageBubbleAccessibilityProps: typeof buildAgentMessageBubbleAccessibilityProps;
  }>('./message-bubble-a11y');
  return {
    ...actual,
    buildAgentMessageBubbleAccessibilityProps: vi.fn(
      actual.buildAgentMessageBubbleAccessibilityProps
    ),
  };
});

function userMessage(id: string): StoredMessage {
  return {
    info: {
      id,
      sessionID: 'ses_1',
      role: 'user',
      time: { created: 1_761_000_000_000 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    },
    parts: [
      {
        id: `${id}-text`,
        sessionID: 'ses_1',
        messageID: id,
        type: 'text',
        text: 'hi',
      },
    ],
  };
}

async function renderBubble(
  message: StoredMessage,
  deliveryState?: MessageDeliveryState
): Promise<unknown> {
  const { MessageBubble } = await import('./message-bubble');
  // eslint-disable-next-line new-cap
  return MessageBubble({ message, deliveryState });
}

function findText(node: unknown, predicate: (text: string) => boolean): boolean {
  if (typeof node === 'string') {
    return predicate(node);
  }
  if (node == null || typeof node !== 'object') {
    return false;
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  // The mock for the Text component is a plain function; we inspect the
  // unrendered React element tree, so the string sits in props.children.
  if (typeof element.props?.children === 'string' && predicate(element.props.children)) {
    return true;
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    return children.some(child => findText(child, predicate));
  }
  if (children && typeof children === 'object') {
    return findText(children, predicate);
  }
  return false;
}

function hasAnimatedBadge(node: unknown): boolean {
  if (node == null || typeof node !== 'object') {
    return false;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === 'Animated.View') {
    return true;
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    return children.some(child => hasAnimatedBadge(child));
  }
  if (children && typeof children === 'object') {
    return hasAnimatedBadge(children);
  }
  return false;
}

function findElementByType(
  node: unknown,
  typeName: string,
  predicate?: (props: Record<string, unknown>) => boolean
): { type: string; props: Record<string, unknown> } | null {
  if (node == null || typeof node !== 'object') {
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === typeName) {
    const props = element.props ?? {};
    if (!predicate || predicate(props)) {
      return { type: typeName, props };
    }
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findElementByType(child, typeName, predicate);
      if (hit) {
        return hit;
      }
    }
  } else if (children && typeof children === 'object') {
    return findElementByType(children, typeName, predicate);
  }
  return null;
}

function isActionsOverlayProps(props: Record<string, unknown>): boolean {
  return (
    props.accessible === true &&
    props.pointerEvents === 'none' &&
    typeof props.className === 'string' &&
    props.className.includes('opacity-0') &&
    props.className.includes('absolute')
  );
}

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
    const base = userMessage('m4');
    const assistant: StoredMessage = {
      info: {
        id: base.info.id,
        sessionID: base.info.sessionID,
        role: 'assistant',
        time: { created: base.info.time.created },
        parentID: 'm0',
        modelID: 'anthropic/claude-sonnet-4',
        providerID: 'kilo',
        mode: 'code',
        agent: 'build',
        path: { cwd: '/', root: '/' },
        cost: 0,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    };
    const tree = await renderBubble(assistant, { status: 'queued' });
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

describe('MessageBubble accessibility', () => {
  function assistantMessage(id: string): StoredMessage {
    const base = userMessage(id);
    return {
      info: {
        id: base.info.id,
        sessionID: base.info.sessionID,
        role: 'assistant',
        time: { created: base.info.time.created },
        parentID: 'm0',
        modelID: 'anthropic/claude-sonnet-4',
        providerID: 'kilo',
        mode: 'code',
        agent: 'build',
        path: { cwd: '/', root: '/' },
        cost: 0,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    };
  }

  it('renders the wrapping Pressable as non-accessible on a user message so the subtree stays navigable', async () => {
    const tree = await renderBubble(userMessage('m-user-a11y'));
    const wrapper = findElementByType(tree, 'Pressable');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.props.accessible).toBe(false);
    // The wrapper must not also be the focusable element; the role/label/hint
    // would otherwise shadow interactive descendants (permission/question
    // `Button`s, child-session "open" `Pressable`, file parts).
    expect(wrapper?.props.accessibilityRole).toBeUndefined();
    expect(wrapper?.props.accessibilityLabel).toBeUndefined();
    expect(wrapper?.props.accessibilityHint).toBeUndefined();
    expect(wrapper?.props.accessibilityActions).toBeUndefined();
  });

  it('hosts the user-message label, role, hint, and copy action on a dedicated inner overlay', async () => {
    const tree = await renderBubble(userMessage('m-user-overlay'));
    const host = findElementByType(tree, 'View', isActionsOverlayProps);
    expect(host).not.toBeNull();
    expect(host?.props.accessibilityRole).toBe('text');
    expect(host?.props.accessibilityLabel).toBe('User message');
    expect(host?.props.accessibilityHint).toBe('Long press to copy message text');
    expect(host?.props.accessibilityActions).toEqual([{ name: 'copy', label: 'Copy message' }]);
    expect(typeof host?.props.onAccessibilityAction).toBe('function');
  });

  it('renders the wrapping Pressable as non-accessible on an assistant message so the subtree stays navigable', async () => {
    const tree = await renderBubble(assistantMessage('m-asst-a11y'));
    const wrapper = findElementByType(tree, 'Pressable');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.props.accessible).toBe(false);
    expect(wrapper?.props.accessibilityRole).toBeUndefined();
    expect(wrapper?.props.accessibilityLabel).toBeUndefined();
    expect(wrapper?.props.accessibilityHint).toBeUndefined();
    expect(wrapper?.props.accessibilityActions).toBeUndefined();
  });

  it('hosts the assistant-message label, role, hint, and copy action on a dedicated inner overlay', async () => {
    const tree = await renderBubble(assistantMessage('m-asst-overlay'));
    const host = findElementByType(tree, 'View', isActionsOverlayProps);
    expect(host).not.toBeNull();
    expect(host?.props.accessibilityRole).toBe('text');
    expect(host?.props.accessibilityLabel).toBe('Assistant message');
    expect(host?.props.accessibilityHint).toBe('Long press to copy message text');
    expect(host?.props.accessibilityActions).toEqual([{ name: 'copy', label: 'Copy message' }]);
    expect(typeof host?.props.onAccessibilityAction).toBe('function');
  });

  it('omits the inner accessibility actions host when no custom actions are exposed', async () => {
    vi.mocked(buildAgentMessageBubbleAccessibilityProps).mockReturnValue({
      accessible: false,
      accessibilityLabel: 'Assistant message',
      accessibilityHint: 'Long press to copy message text',
      accessibilityRole: 'text',
      accessibilityActions: [],
    });

    const userTree = await renderBubble(userMessage('m-user-no-actions'));
    expect(findElementByType(userTree, 'View', isActionsOverlayProps)).toBeNull();

    const asstTree = await renderBubble(assistantMessage('m-asst-no-actions'));
    expect(findElementByType(asstTree, 'View', isActionsOverlayProps)).toBeNull();

    vi.mocked(buildAgentMessageBubbleAccessibilityProps).mockRestore();
  });

  it('keeps the long-press accelerator wired on the wrapping Pressable for both user and assistant messages', async () => {
    const userTree = await renderBubble(userMessage('m-user-lp'));
    const userWrapper = findElementByType(userTree, 'Pressable');
    expect(typeof userWrapper?.props.onLongPress).toBe('function');

    const asstTree = await renderBubble(assistantMessage('m-asst-lp'));
    const asstWrapper = findElementByType(asstTree, 'Pressable');
    expect(typeof asstWrapper?.props.onLongPress).toBe('function');
  });
});
