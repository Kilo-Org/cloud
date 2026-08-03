import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

export function userMessage(id: string): StoredMessage {
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

export function assistantMessage(id: string): StoredMessage {
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

export async function renderBubble(
  message: StoredMessage,
  deliveryState?: MessageDeliveryState,
  holdQueuedSlot?: boolean
): Promise<unknown> {
  const { MessageBubble } = await import('./message-bubble');
  // eslint-disable-next-line new-cap
  return MessageBubble({ message, deliveryState, holdQueuedSlot });
}

export function findText(node: unknown, predicate: (text: string) => boolean): boolean {
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

export function findElementByType(
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

export function isActionsOverlayProps(props: Record<string, unknown>): boolean {
  return (
    props.accessible === true &&
    props.pointerEvents === 'none' &&
    typeof props.className === 'string' &&
    props.className.includes('opacity-0') &&
    props.className.includes('absolute')
  );
}

export function pressableProps(node: unknown): Record<string, unknown> | null {
  if (node == null || typeof node !== 'object') {
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === 'Pressable' && element.props) {
    return element.props;
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = pressableProps(child);
      if (found) {
        return found;
      }
    }
  } else if (children && typeof children === 'object') {
    return pressableProps(children);
  }
  return null;
}
