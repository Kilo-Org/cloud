/* eslint-disable max-lines -- Queued-badge, delivery, and a11y seams share the direct-invocation MessageBubble harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { readKilo2Messages } from '@kilocode/cloud-agent-sdk/kilo2-source-messages';
import type * as React from 'react';

import type * as PartTypes from './part-types';
import { type MessageDeliveryStatement } from './message-failure-state';
import { type AddCreditsDestination } from '@/lib/credits/add-credits-destination';
import {
  assistantMessage,
  findElementByType,
  findText,
  pressableProps,
  renderBubble,
  userMessage,
} from './message-bubble-test-utils';

import { i18n } from '@/i18n';
import type * as ReactI18next from 'react-i18next';

/** React compares hook dependencies one position at a time with `Object.is`. */
function sameHookDeps(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined
): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) {
    return false;
  }
  for (const [position, value] of a.entries()) {
    if (!Object.is(value, b[position])) {
      return false;
    }
  }
  return true;
}

// The harness invokes the memoized component directly (no React renderer), so
// the identity `useCallback` mock keeps the stabilized handler callable there,
// and `useMemo` replays React's contract from one slot per hook position: the
// slot's value is reused while its dependencies are referentially equal.
// `useCallback` is the component's last hook before its two `useMemo` calls, so
// each call opens a render and points the next `useMemo` at slot 0.
const hooks = vi.hoisted(() => {
  const slots: { deps: readonly unknown[] | undefined; value: unknown }[] = [];
  let index = 0;
  return {
    openRender: () => {
      index = 0;
    },
    memo: <T>(factory: () => T, deps?: readonly unknown[]): T => {
      const slot = slots[index];
      index += 1;
      if (slot && sameHookDeps(slot.deps, deps)) {
        return slot.value as T;
      }
      const value = factory();
      slots[index - 1] = { deps, value };
      return value;
    },
  };
});

vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof React>()),
  useCallback: <T>(fn: T) => {
    hooks.openRender();
    return fn;
  },
  useMemo: hooks.memo,
}));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const instance = actual.getI18n();
      return { t: instance.t.bind(instance), i18n: instance };
    },
  };
});

// Hoisted so the iOS size test can flip the platform OS and re-evaluate the
// QUEUED_CONTROL_MIN_HEIGHT module constant via vi.resetModules().
const { reactNativeMock } = vi.hoisted(() => ({
  reactNativeMock: { Platform: { OS: 'android' } },
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: reactNativeMock.Platform,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: () => null,
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
vi.mock('@/components/add-credits-row', () => ({
  AddCreditsRow: 'AddCreditsRow',
}));
vi.mock('./chat-markdown-text', () => ({
  ChatMarkdownText: () => null,
}));
vi.mock('./compaction-separator', () => ({
  CompactionSeparator: 'CompactionSeparator',
}));
vi.mock('./file-part-renderer', () => ({
  FilePartRenderer: () => null,
}));
vi.mock('./part-renderer', () => ({
  PartRenderer: 'PartRenderer',
}));
vi.mock('./tool-run-rows', () => ({
  CondensedToolRunRow: 'CondensedToolRunRow',
  ToolOneLineRow: 'ToolOneLineRow',
}));
vi.mock('./part-types', async () => {
  const actual = await vi.importActual<typeof PartTypes>('./part-types');
  return {
    ...actual,
    isFilePart: vi.fn(() => false),
    isTextPart: vi.fn(() => false),
    // Wrapped, not replaced: the memoization test counts the scan, and every
    // other test keeps the real first-human-part behaviour.
    firstHumanText: vi.fn(actual.firstHumanText),
  };
});
vi.mock('./use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
}));

const BADGE_CLASS = 'flex-row items-center gap-1 self-end pr-1';

describe('MessageBubble compaction', () => {
  beforeEach(async () => {
    const { isTextPart } = await import('./part-types');
    const actual = await vi.importActual<typeof PartTypes>('./part-types');
    vi.mocked(isTextPart).mockImplementation(actual.isTextPart);
  });

  afterEach(async () => {
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockReturnValue(false);
  });

  it.each([false, true])(
    'keeps the projected Kilo v2 summary out of ordinary markdown (native content: %s)',
    async withNativeContent => {
      const [message] = readKilo2Messages(
        { id: 'ses_1', location: { directory: '/workspace' }, time: { created: 1, updated: 2 } },
        [
          {
            id: 'msg_compaction',
            type: 'compaction',
            status: 'completed',
            summary: 'Saved context summary',
            time: { created: 2 },
            content: withNativeContent ? [{ type: 'text', text: 'Native compaction detail' }] : [],
          },
        ]
      );
      if (message === undefined) {
        throw new Error('expected a projected compaction message');
      }
      expect(message.parts).toHaveLength(withNativeContent ? 3 : 2);
      const tree = await renderBubble(message);
      expect(
        findElementByType(tree, 'PartRenderer', props => props.part === message.parts[1])
      ).toBeNull();
      if (withNativeContent) {
        expect(
          findElementByType(tree, 'PartRenderer', props => props.part === message.parts[2])?.props
            .messageInfo
        ).toBe(message.info);
      } else {
        expect(findElementByType(tree, 'CompactionSeparator')?.props.info).toBe(message.info);
        expect(findElementByType(tree, 'PartRenderer')).toBeNull();
      }
    }
  );

  it.each([true, false])(
    'passes live state %s to the compaction-only separator',
    async isStreaming => {
      const message = assistantMessage('compaction');
      message.parts = [
        {
          id: 'part',
          sessionID: 'ses_1',
          messageID: 'compaction',
          type: 'compaction',
          auto: false,
        },
      ];
      const { MessageBubble } = await import('./message-bubble');
      // eslint-disable-next-line new-cap -- Inspect the component's unrendered tree.
      const tree = MessageBubble.type({
        message,
        isLastAssistantMessage: true,
        isSessionStreaming: isStreaming,
      });
      expect(findElementByType(tree, 'CompactionSeparator')?.props.info).toBe(message.info);
      expect(findElementByType(tree, 'CompactionSeparator')?.props.isStreaming).toBe(isStreaming);
    }
  );

  it('passes assistant status to parts in a mixed message', async () => {
    const message = assistantMessage('compaction');
    message.parts = [
      { id: 'part', sessionID: 'ses_1', messageID: 'compaction', type: 'compaction', auto: false },
      {
        id: 'text',
        sessionID: 'ses_1',
        messageID: 'compaction',
        type: 'text',
        text: 'Other content',
      },
    ];
    const tree = await renderBubble(message);
    expect(findElementByType(tree, 'PartRenderer')?.props.messageInfo).toBe(message.info);
  });
});

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

describe('MessageBubble stored prompt with no reply', () => {
  const NOTE = i18n.t('agentChat.messageBubble.noReplyRecorded');

  it('states that no reply was recorded under the prompt a stored transcript ends on', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-unanswered'), {
      noReplyRecorded: true,
      retryAvailable: false,
    });
    expect(findText(tree, text => text === NOTE)).toBe(true);
    // The record cannot say the send failed, so the note carries no failure
    // marker and no action; the read-only footer owns the one recovery.
    expect(findElementByType(tree, 'Button')).toBeNull();
  });

  it('draws no note for a row that is not the unanswered prompt', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-answered'), {
      retryAvailable: false,
    });
    expect(findText(tree, text => text === NOTE)).toBe(false);
  });

  it('never marks an assistant row, even when a caller sets the prop', async () => {
    const tree = await renderBubbleWithHandlers(assistantMessageWithText('m-asst'), {
      noReplyRecorded: true,
    });
    expect(findText(tree, text => text === NOTE)).toBe(false);
  });
});

async function renderBubbleWithHandlers(
  message: StoredMessage,
  props: {
    deliveryState?: MessageDeliveryStatement;
    onRetryMessage?: (m: StoredMessage) => void;
    addCredits?: AddCreditsDestination;
    retryAvailable?: boolean;
    failureStatedByPreparation?: boolean;
    onCopyToComposer?: (text: string) => void;
    onRestoreQueued?: (m: StoredMessage) => void;
    onLongPressDetails?: (m: StoredMessage) => void;
    condenseToolCalls?: boolean;
    partsOverride?: readonly StoredMessage['parts'][number][];
    noReplyRecorded?: boolean;
  }
): Promise<unknown> {
  const { MessageBubble } = await import('./message-bubble');
  // eslint-disable-next-line new-cap
  return MessageBubble.type({ message, ...props });
}

function assistantMessageWithText(id: string): StoredMessage {
  const message = assistantMessage(id);
  message.parts = [
    { id: `${id}-text`, sessionID: 'ses_1', messageID: id, type: 'text', text: 'answer' },
  ];
  return message;
}

function assistantMessageWithError(
  id: string,
  errorName: string,
  options: {
    content?: boolean;
    isRetryable?: boolean;
    statusCode?: number;
    responseBody?: string;
  } = {}
): StoredMessage {
  const message = options.content === false ? assistantMessage(id) : assistantMessageWithText(id);
  if (message.info.role !== 'assistant') {
    throw new Error('the fixture builders write an assistant row');
  }
  // The name is the case under test, so the payload is written before any one
  // member of the error union can claim it.
  const error = {
    name: errorName,
    data: {
      message: 'raw',
      isRetryable: options.isRetryable ?? true,
      ...(options.statusCode === undefined ? {} : { statusCode: options.statusCode }),
      ...(options.responseBody === undefined ? {} : { responseBody: options.responseBody }),
    },
  };
  // The APIError payload is the only shape these cases carry.
  message.info.error = error as NonNullable<typeof message.info.error>;
  return message;
}

/** The Kilo gateway's answer to a paid request from an account with no balance. */
const GATEWAY_CREDITS_BODY = JSON.stringify({
  error: {
    title: 'Paid Model - Credits Required',
    message: 'Add credits to continue, or switch to a free model',
    balance: 0,
  },
  error_type: 'usage_limit_exceeded',
});

describe('MessageBubble failure footer', () => {
  it('wraps the failed bubble and delivery row in one measurable list item', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-measured'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
    });

    expect((tree as { type?: unknown }).type).toBe('View');
  });

  it('renders the failed-delivery footer with Retry and Copy to composer', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-fail'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });
    expect(findText(tree, t => t === 'Message not sent')).toBe(true);
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

  it('sets the failure detail at the transcript secondary body size under one uniform gap', async () => {
    const tree = await renderBubbleWithHandlers(assistantMessageWithError('m-scale', 'APIError'), {
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
    });

    // The failed turn's detail line is the same secondary body copy as the
    // collapsed reasoning row, not a smaller caption, so the block reads at the
    // transcript's text size.
    const footer = footerOf(tree);
    const detail = classNamesIn(footer?.props.children).find(name =>
      name.includes('text-muted-foreground')
    );
    expect(detail?.split(' ')).toEqual(
      expect.arrayContaining(['text-sm', 'leading-[1.25rem]', 'text-muted-foreground'])
    );

    // One gap separates the title, the detail and the action row.
    const gapClasses = String(footer?.props.className)
      .split(' ')
      .filter(name => /^gap-\d/.test(name));
    expect(gapClasses).toHaveLength(1);
  });

  it('end-aligns a failed user row’s footer under its bubble and leaves an assistant row’s on its leading edge', async () => {
    const userTree = await renderBubbleWithHandlers(userMessage('m-align-user'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });
    const assistantTree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-align-asst', 'APIError'),
      { onRetryMessage: vi.fn<(message: StoredMessage) => void>() }
    );
    // A question whose answer failed: the row is the user's, the statement is
    // the assistant's, so the footer takes the assistant's column — the same
    // layout an assistant error draws.
    const executionTree = await renderBubbleWithHandlers(userMessage('m-align-exec'), {
      deliveryState: { status: 'failed', error: '', reason: 'execution' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });

    const userFooter = footerOf(userTree);
    expect(String(userFooter?.props.className)).toBe('gap-2 px-4 pt-1 pb-[24px] items-end');
    const userFooterClasses = String(userFooter?.props.className).split(' ');
    expect(userFooterClasses).toEqual(expect.arrayContaining(['px-4', 'items-end']));
    // The title and the detail line end-align with the bubble's trailing edge,
    // so a wrapped line does not fall back to the leading edge, and each keeps
    // its own colour. The action row is unchanged: the column places it.
    const userFooterChildren = classNamesIn(userFooter?.props.children);
    expect(
      userFooterChildren.some(
        name => name.includes('text-destructive') && name.includes('text-right')
      )
    ).toBe(true);
    expect(
      userFooterChildren.some(
        name => name.includes('text-muted-foreground') && name.includes('text-right')
      )
    ).toBe(true);
    expect(userFooterChildren).toContain('flex-row gap-2');

    // An assistant row's footer keeps its existing leading layout.
    const assistantFooter = footerOf(assistantTree);
    expect(String(assistantFooter?.props.className)).toBe('gap-2 px-4 pt-1 pb-[24px]');
    const assistantFooterClasses = String(assistantFooter?.props.className).split(' ');
    expect(assistantFooterClasses).toEqual(expect.arrayContaining(['px-4']));
    expect(
      classNamesIn(assistantFooter?.props.children).filter(name =>
        name.split(' ').includes('text-right')
      )
    ).toEqual([]);

    const executionFooter = footerOf(executionTree);
    expect(String(executionFooter?.props.className)).toBe('gap-2 px-4 pt-1 pb-[24px]');
    expect(
      classNamesIn(executionFooter?.props.children).filter(name =>
        name.split(' ').includes('text-right')
      )
    ).toEqual([]);
    // The failed response states its reason under the title, the same way the
    // provider's own failures do.
    expect(findText(executionTree, t => t === 'The agent could not run this message.')).toBe(true);
    // The failed response still offers both recovery actions.
    expect(
      findElementByType(executionTree, 'Button', p => p.accessibilityLabel === 'Retry')
    ).not.toBeNull();
    expect(
      findElementByType(executionTree, 'Button', p => p.accessibilityLabel === 'Copy to composer')
    ).not.toBeNull();

    // No start/end text class: NativeWind drops `text-align: end`, and RN
    // already resolves `text-right` against the interface direction.
    const footerClasses = [
      ...classNamesIn(userFooter?.props.children),
      ...classNamesIn(assistantFooter?.props.children),
      ...classNamesIn(executionFooter?.props.children),
      String(userFooter?.props.className),
      String(assistantFooter?.props.className),
      String(executionFooter?.props.className),
    ];
    expect(footerClasses.filter(name => /\btext-(start|end)\b/.test(name))).toEqual([]);
  });

  it('keeps the actions and drops the generic statement a preparation group already states', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-prep-failed'), {
      deliveryState: { status: 'failed', error: 'boom', reason: 'execution' },
      failureStatedByPreparation: true,
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });

    // The group names the stage and the reason, so neither generic line is
    // drawn a second time above it.
    expect(findText(tree, t => t === 'Response failed')).toBe(false);
    expect(findText(tree, t => t === 'The agent could not run this message.')).toBe(false);
    // The turn keeps the recovery it had, in the column of the failed response.
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).not.toBeNull();
    expect(
      findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Copy to composer')
    ).not.toBeNull();
    expect(footerOf(tree)).not.toBeNull();
  });

  it('draws no footer when the group states the failure and no action can render', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-prep-empty'), {
      deliveryState: { status: 'failed', error: '', reason: 'execution' },
      failureStatedByPreparation: true,
      retryAvailable: false,
    });

    // Nothing but a padded block would be left above the group, so the footer
    // is skipped rather than drawn empty.
    expect(footerOf(tree)).toBeNull();
    expect(findText(tree, t => t === 'Response failed')).toBe(false);
  });

  it('keeps a classified statement on a turn whose preparation also failed', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-prep-credits'), {
      deliveryState: { status: 'failed', error: '', reason: 'credits' },
      failureStatedByPreparation: true,
      addCredits: { kind: 'inApp', onPress: vi.fn<() => void>() },
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });

    // The balance refusal is a cause the preparation group does not carry, so
    // its statement stays.
    expect(findText(tree, t => t === 'Not enough credits to send this message.')).toBe(true);
  });

  it('states a refused send under the person’s bubble with Add credits and no Retry', async () => {
    const onAddCredits = vi.fn<() => void>();
    const tree = await renderBubbleWithHandlers(userMessage('m-credits'), {
      deliveryState: { status: 'failed', error: '', reason: 'credits' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      addCredits: { kind: 'inApp', onPress: onAddCredits },
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });

    expect(findText(tree, t => t === 'Not enough credits to send this message.')).toBe(true);
    // The cause is the whole statement: neither the generic title line nor the
    // agent-failure line repeats or contradicts it.
    expect(findText(tree, t => t === 'Response failed')).toBe(false);
    expect(findText(tree, t => t === 'The agent could not run this message.')).toBe(false);
    // The send never left, so the statement sits in the bubble's own column.
    expect(String(footerOf(tree)?.props.className)).toBe('gap-2 px-4 pt-1 pb-[24px] items-end');
    const addCredits = findElementByType(tree, 'AddCreditsRow');
    if (!addCredits) {
      throw new Error('the footer drew no Add credits action');
    }
    (addCredits.props.onPress as () => void)();
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    // A re-send meets the same balance, so the only other action keeps the
    // words for the send that follows the purchase.
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
    expect(
      findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Copy to composer')
    ).not.toBeNull();
  });

  it('renders only the failure footer when the user text sanitizes to empty', async () => {
    const actual = await vi.importActual<typeof PartTypes>('./part-types');
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockImplementation(actual.isTextPart);
    const { Bubble: MockBubble } = await import('@/components/ui/bubble');
    const message = userMessage('m-sanitized');
    const firstPart = message.parts[0];
    if (firstPart?.type !== 'text') {
      throw new Error('expected text part');
    }
    firstPart.text = '<script>hidden</script>';

    try {
      const tree = await renderBubbleWithHandlers(message, {
        deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
        onRetryMessage: vi.fn<(value: StoredMessage) => void>(),
      });

      expect(findElementByTypeFn(tree, MockBubble)).toBeNull();
      expect(findText(tree, text => text === 'Message not sent')).toBe(true);
      expect(
        findElementByType(tree, 'Button', props => props.accessibilityLabel === 'Retry')
      ).not.toBeNull();
    } finally {
      vi.mocked(isTextPart).mockReturnValue(false);
    }
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

  it('gives both recovery controls the shared state-surface target', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-targets'), {
      deliveryState: { status: 'failed', error: '', reason: 'execution' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });
    /* The footer's actions are the failure's whole recovery, so both take the
       48 dp frame the shared state surface gives them. */
    for (const label of ['Retry', 'Copy to composer']) {
      const control = findElementByType(tree, 'Button', p => p.accessibilityLabel === label);
      expect(String(control?.props.className).split(' ')).toContain('min-h-[48px]');
    }
  });

  it('omits the Retry button for a non-retryable assistant error', async () => {
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-nr', 'ProviderAuthError'),
      { onRetryMessage: vi.fn<(message: StoredMessage) => void>() }
    );
    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
  });

  it('states a failed turn without Retry when the session cannot send', async () => {
    // No handler is wired at all: the read-only transcript declares the row
    // cannot be re-sent, and the row must still say why it failed.
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-readonly', 'APIError'),
      { retryAvailable: false }
    );

    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findText(tree, t => t === 'The provider returned an error.')).toBe(true);
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
    expect(findText(tree, t => t.includes('You can retry'))).toBe(false);
  });

  it('keeps a failed delivery’s copy and drops its Retry when the session cannot send', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-fail-readonly'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      retryAvailable: false,
    });

    expect(findText(tree, t => t === 'Message not sent')).toBe(true);
    expect(
      findText(tree, t => t === 'We could not deliver this message after several attempts.')
    ).toBe(true);
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
  });

  it('states a gateway-marked final refusal in the detail line, without Retry', async () => {
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-terminal', 'APIError', { isRetryable: false }),
      { onRetryMessage: vi.fn<(message: StoredMessage) => void>() }
    );
    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(
      findText(tree, t => t === 'The provider refused this request and it cannot be retried.')
    ).toBe(true);
    // The transient failure's line is what the terminal row used to repeat.
    expect(findText(tree, t => t === 'The provider returned an error.')).toBe(false);
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
  });

  it('states a credits refusal with the cause and offers Add credits', async () => {
    const onAddCredits = vi.fn<() => void>();
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-credits', 'APIError', {
        isRetryable: false,
        statusCode: 402,
        responseBody: GATEWAY_CREDITS_BODY,
      }),
      {
        onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
        addCredits: { kind: 'inApp', onPress: onAddCredits },
      }
    );

    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findText(tree, t => t === 'Not enough credits for this request.')).toBe(true);

    const addCredits = findElementByType(tree, 'AddCreditsRow');
    if (!addCredits) {
      throw new Error('the footer drew no Add credits action');
    }
    // The row's one recovery action fills with the accent surface the person's
    // own bubble uses, so it reads as that row's primary action.
    expect(addCredits.props.emphasis).toBe('primary');
    const press = addCredits.props.onPress as () => void;
    press();
    expect(onAddCredits).toHaveBeenCalledTimes(1);

    // A retry of the same request meets the same block, so the row offers the
    // action that can settle it instead.
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).toBeNull();
    expect(
      findText(tree, t => t === 'The provider refused this request and it cannot be retried.')
    ).toBe(false);
  });

  it('keeps the final-refusal line for a payment block the account provider caused', async () => {
    const onAddCredits = vi.fn<() => void>();
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-byok-402', 'APIError', {
        isRetryable: false,
        statusCode: 402,
        responseBody: '{"error":{"message":"Upstream request failed"}}',
      }),
      {
        onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
        addCredits: { kind: 'inApp', onPress: onAddCredits },
      }
    );

    expect(
      findText(tree, t => t === 'The provider refused this request and it cannot be retried.')
    ).toBe(true);
    expect(findElementByType(tree, 'AddCreditsRow')).toBeNull();
  });

  it('keeps Add credits on a transcript that cannot resend', async () => {
    const onAddCredits = vi.fn<() => void>();
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-credits-stored', 'APIError', {
        isRetryable: false,
        statusCode: 402,
        responseBody: GATEWAY_CREDITS_BODY,
      }),
      { retryAvailable: false, addCredits: { kind: 'inApp', onPress: onAddCredits } }
    );

    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findElementByType(tree, 'AddCreditsRow')).not.toBeNull();
  });

  it('renders no pressable host for an assistant row with nothing to show', async () => {
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-empty', 'APIError', { content: false }),
      { onRetryMessage: vi.fn<(message: StoredMessage) => void>() }
    );

    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findElementByType(tree, 'Pressable', () => true)).toBeNull();
  });

  it('states a generic assistant failure once, without a detail line repeating the title', async () => {
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-laconic', 'APIError'),
      {
        onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      }
    );
    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findText(tree, t => t === 'The response failed.')).toBe(false);
  });

  it('keeps the classified detail line for a known assistant error', async () => {
    const tree = await renderBubbleWithHandlers(
      assistantMessageWithError('m-asst-known', 'ProviderAuthError'),
      { onRetryMessage: vi.fn<(message: StoredMessage) => void>() }
    );
    expect(findText(tree, t => t === 'Response failed')).toBe(true);
    expect(findText(tree, t => t === 'The provider rejected the request.')).toBe(true);
  });

  it('does not render the footer when no handler is supplied', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-nohandler'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
    });
    expect(findText(tree, t => t === 'Message not sent')).toBe(false);
  });

  it('names the failure row on the title text without grouping the CTA buttons', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-a11y'), {
      deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
      onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      onCopyToComposer: vi.fn<(text: string) => void>(),
    });

    // The footer container is a plain View: no accessible, no role, no label,
    // so Retry and Copy stay individually focusable.
    const footer = footerOf(tree);
    expect(footer).not.toBeNull();
    expect(footer?.props.accessible).toBeUndefined();
    expect(footer?.props.accessibilityRole).toBeUndefined();
    expect(footer?.props.accessibilityLabel).toBeUndefined();

    // The row name lives on the title Text, which still announces the row.
    const title = findElementByLabel(tree, 'Message not sent. Retry available.');
    expect(title).not.toBeNull();
    expect(title?.props.children).toBe('Message not sent');
  });

  it('names a German failure row with one full stop, keeping the title line as translated', async () => {
    await i18n.changeLanguage('de');
    try {
      const tree = await renderBubbleWithHandlers(userMessage('m-a11y-de'), {
        deliveryState: { status: 'failed', error: 'nope', reason: 'exhausted' },
        onRetryMessage: vi.fn<(message: StoredMessage) => void>(),
      });

      // The title already ends its own sentence in German, so the label must not
      // add a second stop before the retry line.
      expect(
        findElementByLabel(
          tree,
          'Die Zustellung ist fehlgeschlagen. Du kannst es erneut versuchen.'
        )
      ).not.toBeNull();
      expect(
        findElementByLabel(
          tree,
          'Die Zustellung ist fehlgeschlagen.. Du kannst es erneut versuchen.'
        )
      ).toBeNull();
      // The visible line is the catalog's title, unchanged.
      expect(findText(tree, text => text === 'Die Zustellung ist fehlgeschlagen.')).toBe(true);
    } finally {
      await i18n.changeLanguage('en');
    }
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

describe('MessageBubble queue indicator and restore', () => {
  it('keeps Queued without a standalone cancellation control', async () => {
    const tree = await renderBubbleWithHandlers(userMessage('m-queued'), {
      deliveryState: { status: 'queued' },
    });
    expect(findText(tree, text => text === 'Queued')).toBe(true);
    expect(findText(tree, text => text === 'Cancel message')).toBe(false);
    expect(
      findElementByType(
        tree,
        'Button',
        props => props.accessibilityLabel === 'Cancel queued message'
      )
    ).toBeNull();
  });

  it.each([
    ['android', 'min-h-12'],
    ['ios', 'min-h-11'],
  ])('keeps Restore targeting and the minimum target on %s', async (platform, minHeight) => {
    reactNativeMock.Platform.OS = platform;
    vi.resetModules();
    try {
      const message = userMessage('m-restore');
      let restored: StoredMessage | undefined = undefined;
      const tree = await renderBubbleWithHandlers(message, {
        onRestoreQueued: selected => {
          restored = selected;
        },
      });
      expect(findText(tree, text => text === 'Restore')).toBe(true);
      const restore = findElementByType(
        tree,
        'Button',
        props => props.accessibilityLabel === 'Restore canceled message to the composer'
      );
      expect(restore?.props.accessibilityRole).toBe('button');
      expect(restore?.props.className).toBe(minHeight);
      expect(restore?.props.size).toBe('sm');
      if (!restore) {
        throw new Error('Restore control is missing');
      }
      (restore.props.onPress as () => void)();
      expect(restored).toBe(message);
    } finally {
      reactNativeMock.Platform.OS = 'android';
      vi.resetModules();
    }
  });
});

describe('MessageBubble attachment details entry', () => {
  it.each([false, true])(
    'selects the whole message from an attachment, with text=%s',
    async withText => {
      const actual = await vi.importActual<typeof PartTypes>('./part-types');
      const { isFilePart, isTextPart } = await import('./part-types');
      const { FilePartRenderer } = await import('./file-part-renderer');
      vi.mocked(isFilePart).mockImplementation(actual.isFilePart);
      vi.mocked(isTextPart).mockImplementation(actual.isTextPart);
      try {
        const message = userMessage('attachment-message');
        const file = {
          id: 'attachment-part',
          sessionID: 'ses_1',
          messageID: message.info.id,
          type: 'file' as const,
          mime: 'image/png',
          url: 'https://example.test/image.png',
        };
        message.parts = [...(withText ? message.parts : []), file];
        const selected: StoredMessage[] = [];
        const tree = await renderBubbleWithHandlers(message, {
          deliveryState: { status: 'queued' },
          onLongPressDetails: value => {
            selected.push(value);
          },
        });
        const attachment = findElementByTypeFn(tree, FilePartRenderer);
        if (!attachment) {
          throw new Error('Attachment control is missing');
        }
        expect(attachment.props.part).toBe(file);
        (attachment.props.onLongPress as () => void)();
        expect(selected).toEqual([message]);
        expect(findText(tree, text => text === 'Queued')).toBe(true);
        expect(findText(tree, text => text === 'Cancel message')).toBe(false);

        const withoutActions = await renderBubbleWithHandlers(message, {});
        expect(
          findElementByTypeFn(withoutActions, FilePartRenderer)?.props.onLongPress
        ).toBeUndefined();
      } finally {
        vi.mocked(isFilePart).mockReturnValue(false);
        vi.mocked(isTextPart).mockReturnValue(false);
      }
    }
  );
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

  it('passes the prompt, not injected server context, to Copy', async () => {
    const message = userMessage('m-copy-context');
    message.parts = [
      {
        id: 'm-copy-context-synthetic',
        sessionID: 'ses_1',
        messageID: 'm-copy-context',
        type: 'text',
        text: '<cloud-agent-context session-id="workspace_123" />',
        synthetic: true,
      },
      {
        id: 'm-copy-context-prompt',
        sessionID: 'ses_1',
        messageID: 'm-copy-context',
        type: 'text',
        text: 'prompt',
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

describe('MessageBubble derived text memoization', () => {
  it('derives the user text and copy text once per parts array', async () => {
    const { firstHumanText } = await import('./part-types');
    const firstHumanTextSpy = vi.mocked(firstHumanText);
    firstHumanTextSpy.mockClear();

    const message = userMessage('m-memo');
    await renderBubble(message);
    expect(firstHumanTextSpy).toHaveBeenCalledTimes(1);

    // The same parts array is the memo key, so the second render reuses the
    // slot and never re-scans the parts for the copy text or the join.
    await renderBubble(message);
    expect(firstHumanTextSpy).toHaveBeenCalledTimes(1);

    // A fresh parts array misses the memo, so the derivation is keyed on the
    // part list rather than skipped outright.
    await renderBubble(userMessage('m-memo-next'));
    expect(firstHumanTextSpy).toHaveBeenCalledTimes(2);
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

  it('renders only the prompt, not injected server context', async () => {
    const { ChatMarkdownText: MockChatMarkdownText } = await import('./chat-markdown-text');

    const message = userMessage('m-context');
    message.parts = [
      {
        id: 'm-context-synthetic',
        sessionID: 'ses_1',
        messageID: 'm-context',
        type: 'text',
        text: '<cloud-agent-context session-id="workspace_123" />',
        synthetic: true,
      },
      {
        id: 'm-context-prompt',
        sessionID: 'ses_1',
        messageID: 'm-context',
        type: 'text',
        text: 'prompt',
      },
    ] as typeof message.parts;

    const tree = await renderBubble(message);

    const element = findElementByTypeFn(tree, MockChatMarkdownText);
    expect(element).not.toBeNull();
    expect(element?.props.value).toBe('prompt');
  });
});

describe('MessageBubble assistant treatment', () => {
  // The user treatment (Bubble side="user": right-aligned accent tile) is
  // reserved for a user-role info. An assistant message at any point of its
  // life — before the first token, mid-stream, completed — and a message whose
  // role is missing or unknown must never take it.
  async function findUserBubble(tree: unknown): Promise<{ side: unknown } | null> {
    const { Bubble: MockBubble } = await import('@/components/ui/bubble');
    const element = findElementByTypeFn(tree, MockBubble);
    return element ? { side: element.props.side } : null;
  }

  it('renders streaming assistant text through the part renderer, never the user bubble', async () => {
    const { PartRenderer: MockPartRenderer } = await import('./part-renderer');
    const message = assistantMessage('m-treatment-streaming');
    message.parts = [
      {
        id: 'm-treatment-streaming-text',
        sessionID: 'ses_1',
        messageID: 'm-treatment-streaming',
        type: 'text',
        text: 'AI Gateway abuse classification is an external, fail-mostly-open integration',
      },
    ] as typeof message.parts;

    const tree = await renderBubble(message);
    expect(await findUserBubble(tree)).toBeNull();
    expect(findElementByTypeFn(tree, MockPartRenderer)).not.toBeNull();
  });

  it('renders an assistant message with no content yet without the user bubble', async () => {
    // Before the first token the assistant row has no visible parts; the
    // transcript drops it, and the bubble itself must not render user ink.
    const tree = await renderBubble(assistantMessage('m-treatment-empty'));
    expect(await findUserBubble(tree)).toBeNull();
  });

  it('renders a message with an undefined role without the user bubble', async () => {
    // A payload quirk must never fall back to the user treatment: the missing
    // role renders the assistant path (no bubble), never Bubble side="user".
    const message = assistantMessage('m-treatment-unknown-role');
    (message.info as { role?: string }).role = undefined;

    const tree = await renderBubble(message);
    expect(await findUserBubble(tree)).toBeNull();
  });

  it('reserves Bubble side="user" for a user-role message', async () => {
    const tree = await renderBubble(userMessage('m-treatment-user'));
    const userBubble = await findUserBubble(tree);
    expect(userBubble).not.toBeNull();
    expect(userBubble?.side).toBe('user');
  });
});

describe('MessageBubble in-bubble text selection context', () => {
  it('wraps the assistant parts view in InMessageBubbleContext.Provider with value true', async () => {
    const { InMessageBubbleContext } = await import('./bubble-text-selection-context');
    const tree = await renderBubble(assistantMessageWithText('m6'));

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

describe('MessageBubble part-row long-press context', () => {
  it('mounts the message long-press provider on the assistant parts when the details sheet is wired', async () => {
    const onLongPressDetails = vi.fn<(m: StoredMessage) => void>();
    const message = assistantMessageWithText('m-long-press');
    const tree = await renderBubbleWithHandlers(message, { onLongPressDetails });

    const { MessageLongPressProvider } = await import('./message-long-press-context');
    const provider = findElementByTypeFn(tree, MessageLongPressProvider);
    expect(provider).not.toBeNull();
    expect(provider?.props.message).toBe(message);
    expect(provider?.props.onLongPressDetails).toBe(onLongPressDetails);
  });

  it('keeps assistant part rows tap-only when no details sheet is wired', async () => {
    const tree = await renderBubble(assistantMessageWithText('m-long-press-plain'));

    const { MessageLongPressProvider } = await import('./message-long-press-context');
    const provider = findElementByTypeFn(tree, MessageLongPressProvider);
    expect(provider).not.toBeNull();
    expect(provider?.props.onLongPressDetails).toBeUndefined();
  });
});

describe('MessageBubble row rhythm', () => {
  // Spacing class contract: two parts of one assistant message sit gap-2
  // apart; two adjacent messages sit py-1 + py-1 apart, the same value; the
  // user wrapper carries the same py-1, so user/assistant boundaries keep the
  // rhythm. One value, three class assertions.
  it('applies the uniform row-rhythm class contract', async () => {
    // The wrapper is drawn for a row with a visible part, so the text part has
    // to be visible: install the real predicate rather than the file's default
    // "no text part renders" stub.
    const actual = await vi.importActual<typeof PartTypes>('./part-types');
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockImplementation(actual.isTextPart);
    try {
      const assistantTree = await renderBubble(assistantMessageWithText('rhythm-a'));
      const parts = findElementByType(assistantTree, 'View', p => p.className === 'gap-2');
      expect(parts).not.toBeNull();

      const assistantPressable = pressableProps(assistantTree);
      expect(assistantPressable?.className).toBe('px-4 py-1');

      const userTree = await renderBubble(userMessage('rhythm-b'));
      const userPressable = pressableProps(userTree);
      expect(userPressable?.className).toBe('px-4 py-1');
    } finally {
      vi.mocked(isTextPart).mockReturnValue(false);
    }
  });
});

describe('MessageBubble rows with nothing to draw', () => {
  // The transcript keeps a message item while a live turn streams its parts in,
  // so a row can exist with no visible part. Its wrapper carries the row's
  // padding and the long-press surface, so drawing it around nothing left an
  // empty interactive strip in the transcript (and an invisible focus stop in
  // the accessibility tree).
  it('draws no pressable for a user row with no parts', async () => {
    const message = userMessage('m-empty-user');
    message.parts = [];

    const tree = await renderBubble(message);

    expect(pressableProps(tree)).toBeNull();
    expect(countElementsByType(tree, 'Pressable')).toBe(0);
  });

  it('draws no pressable for an assistant row with no parts', async () => {
    const tree = await renderBubble(assistantMessage('m-empty-assistant'));

    expect(pressableProps(tree)).toBeNull();
    expect(findElementByType(tree, 'View', p => p.className === 'gap-2')).toBeNull();
  });

  it('draws no pressable for a row whose only text part is blank', async () => {
    const actual = await vi.importActual<typeof PartTypes>('./part-types');
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockImplementation(actual.isTextPart);
    try {
      const message = assistantMessage('m-blank-part');
      message.parts = [
        {
          id: 'm-blank-part-text',
          sessionID: 'ses_1',
          messageID: 'm-blank-part',
          type: 'text',
          text: '   \n ',
        },
      ];

      const tree = await renderBubble(message);

      expect(pressableProps(tree)).toBeNull();
    } finally {
      vi.mocked(isTextPart).mockReturnValue(false);
    }
  });

  it('draws no pressable for a row whose only part is the synthetic routing context', async () => {
    // The server prepends this wrapper to every prompt. The bubble renders
    // human text only, so a row that carries nothing else draws no bubble, and
    // the wrapper drawn around it would be the same empty strip.
    const message = userMessage('m-context-only');
    message.parts = [
      {
        id: 'm-context-only-context',
        sessionID: 'ses_1',
        messageID: 'm-context-only',
        type: 'text',
        text: '<cloud-agent-context session-id="workspace_123" />',
        synthetic: true,
      },
    ];

    const tree = await renderBubble(message);

    expect(pressableProps(tree)).toBeNull();
  });

  it('keeps the failure footer on a user row with no parts', async () => {
    const message = userMessage('m-empty-failed');
    message.parts = [];

    const tree = await renderBubbleWithHandlers(message, {
      deliveryState: { status: 'failed', error: 'boom', reason: 'exhausted' },
      onRetryMessage: vi.fn<(m: StoredMessage) => void>(),
    });

    // The footer is the failed turn's status, not its content: it stays, and
    // the row draws no wrapper above it.
    expect(pressableProps(tree)).toBeNull();
    expect(footerOf(tree)).not.toBeNull();
    expect(findText(tree, t => t === 'Message not sent')).toBe(true);
    expect(findElementByType(tree, 'Button', p => p.accessibilityLabel === 'Retry')).not.toBeNull();
  });

  it('keeps the queued row wrapper while an empty row holds its badge slot', async () => {
    const message = userMessage('m-empty-held');
    message.parts = [];

    const tree = await renderBubble(message, { status: 'queued' }, true);

    // The held slot reserves the badge's height for layout stability as the
    // message dequeues, so the row keeps drawing its wrapper.
    expect(pressableProps(tree)?.className).toBe('px-4 py-1');
    expect(findText(tree, t => t === 'Queued')).toBe(true);
  });
});

function toolPart(id: string, tool = 'read'): ToolPart {
  return {
    id,
    sessionID: 'ses_1',
    messageID: 'm-tool',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input: { filePath: `/${id}.ts` },
      output: '',
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function textPart(id: string): StoredMessage['parts'][number] {
  return {
    id,
    sessionID: 'ses_1',
    messageID: 'm-tool',
    type: 'text',
    text: 'between',
    time: { start: 0, end: 1 },
  };
}

describe('MessageBubble condensed tool runs', () => {
  beforeEach(async () => {
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockReturnValue(false);
  });

  it('condenses three consecutive tool parts into one run row when enabled', async () => {
    const { PartRenderer } = await import('./part-renderer');
    const message = assistantMessage('m-condense-on');
    message.parts = [toolPart('t1'), toolPart('t2'), toolPart('t3')];

    const tree = await renderBubbleWithHandlers(message, { condenseToolCalls: true });

    expect(countElementsByType(tree, PartRenderer)).toBe(0);
    expect(countElementsByType(tree, 'CondensedToolRunRow')).toBe(1);
    const run = findElementByType(tree, 'CondensedToolRunRow');
    expect(run).not.toBeNull();
    if (!run) {
      throw new Error('expected run row');
    }
    expect((run.props.parts as ToolPart[]).map(part => part.id)).toEqual(['t1', 't2', 't3']);
  });

  it.each([false, undefined] as const)(
    'keeps one PartRenderer per tool part when condense is %s',
    async condenseToolCalls => {
      const { PartRenderer } = await import('./part-renderer');
      const message = assistantMessage(`m-condense-off-${String(condenseToolCalls)}`);
      message.parts = [toolPart('t1'), toolPart('t2'), toolPart('t3')];

      const tree = await renderBubbleWithHandlers(
        message,
        condenseToolCalls === undefined ? {} : { condenseToolCalls }
      );

      expect(countElementsByType(tree, PartRenderer)).toBe(3);
      expect(countElementsByType(tree, 'CondensedToolRunRow')).toBe(0);
    }
  );

  it('renders run, text, run in order when a text part sits between tool pairs', async () => {
    const actual = await vi.importActual<typeof PartTypes>('./part-types');
    const { isTextPart } = await import('./part-types');
    vi.mocked(isTextPart).mockImplementation(actual.isTextPart);
    try {
      const { PartRenderer } = await import('./part-renderer');
      const message = assistantMessage('m-condense-split');
      message.parts = [
        toolPart('t1'),
        toolPart('t2'),
        textPart('x'),
        toolPart('t3'),
        toolPart('t4'),
      ];

      const tree = await renderBubbleWithHandlers(message, { condenseToolCalls: true });

      const gapView = findElementByType(tree, 'View', props => props.className === 'gap-2');
      expect(gapView).not.toBeNull();
      const sequence = collectTypeSequence(gapView?.props.children).filter(
        type => type === 'CondensedToolRunRow' || type === PartRenderer
      );
      expect(sequence).toEqual(['CondensedToolRunRow', PartRenderer, 'CondensedToolRunRow']);
    } finally {
      vi.mocked(isTextPart).mockReturnValue(false);
    }
  });

  it('renders a lone tool part as one PartRenderer and no run row', async () => {
    const { PartRenderer } = await import('./part-renderer');
    const message = assistantMessage('m-condense-lone');
    message.parts = [toolPart('t1')];

    const tree = await renderBubbleWithHandlers(message, { condenseToolCalls: true });

    expect(countElementsByType(tree, PartRenderer)).toBe(1);
    expect(countElementsByType(tree, 'CondensedToolRunRow')).toBe(0);
  });

  it('renders only the overridden parts when a condensed run split the message', async () => {
    const { PartRenderer } = await import('./part-renderer');
    const message = assistantMessage('m-condense-fragment');
    const first = toolPart('t1');
    const second = toolPart('t2');
    message.parts = [first, second];

    // The transcript moved t1 into a run and re-emitted the message's remaining
    // parts; the bubble must render exactly the parts it was handed, so the part
    // already shown in the run row never renders a second time.
    const tree = await renderBubbleWithHandlers(message, {
      condenseToolCalls: true,
      partsOverride: [second],
    });

    expect(countElementsByType(tree, PartRenderer)).toBe(1);
    expect(countElementsByType(tree, 'CondensedToolRunRow')).toBe(0);
    const rendered = findElementByTypeFn(tree, PartRenderer);
    expect((rendered?.props.part as ToolPart | undefined)?.id).toBe('t2');
  });
});

function countElementsByType(node: unknown, target: unknown): number {
  if (Array.isArray(node)) {
    let total = 0;
    for (const child of node) {
      total += countElementsByType(child, target);
    }
    return total;
  }
  if (node == null || typeof node !== 'object') {
    return 0;
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  let total = element.type === target ? 1 : 0;
  total += countElementsByType(element.props?.children, target);
  return total;
}

function collectTypeSequence(node: unknown): unknown[] {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const child of node) {
      out.push(...collectTypeSequence(child));
    }
    return out;
  }
  if (node == null || typeof node !== 'object') {
    return [];
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  return [element.type, ...collectTypeSequence(element.props?.children)];
}

function findElementByTypeFn(
  node: unknown,
  typeFn: unknown
): { type: unknown; props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElementByTypeFn(child, typeFn);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
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

/** The failed row's footer container, found by its own spacing classes. */
function footerOf(tree: unknown): { type: string; props: Record<string, unknown> } | null {
  return findElementByType(tree, 'View', p =>
    String(p.className).startsWith('gap-2 px-4 pt-1 pb-[24px]')
  );
}

/** Every className in an unrendered element tree, in document order. */
function classNamesIn(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(child => classNamesIn(child));
  }
  if (node == null || typeof node !== 'object') {
    return [];
  }
  const element = node as { props?: { className?: unknown; children?: unknown } };
  const own = typeof element.props?.className === 'string' ? [element.props.className] : [];
  return [...own, ...classNamesIn(element.props?.children)];
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
