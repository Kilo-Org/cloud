import { memo, useCallback, useMemo } from 'react';
import {
  type MessageDeliveryState,
  type Part,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import { Clock } from '@/components/ui/icons';
import { type AccessibilityActionEvent, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Bubble } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { cn } from '@/lib/utils';

import { InMessageBubbleContext } from './bubble-text-selection-context';
import { ChatMarkdownText } from './chat-markdown-text';
import { CompactionSeparator } from './compaction-separator';
import { hasCopyableText, messageTextParts } from './collect-copyable-text';
import { FilePartRenderer } from './file-part-renderer';
import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';
import { MessageErrorBoundary } from './message-error-boundary';
import { MessageLongPressProvider } from './message-long-press-context';
import { messageFailureLabel, selectMessageFailure } from './message-failure-state';
import { partRendersContent } from './message-visibility';
import { PartRenderer } from './part-renderer';
import { firstHumanText, humanTextParts, isFilePart } from './part-types';
import { groupMessageParts } from './session-tool-run';
import { CondensedToolRunRow } from './tool-run-rows';
import { useMessageCopy } from './use-message-copy';
import { type OpenChildSession } from './child-session-section';

/** Restore keeps the platform minimum target despite the compact button size. */
const QUEUED_CONTROL_MIN_HEIGHT = Platform.OS === 'android' ? 'min-h-12' : 'min-h-11';

type MessageBubbleProps = {
  message: StoredMessage;
  /**
   * Renders only this subset of `message.parts`, in order. Set by the transcript
   * when a condensed run split the message around its visible parts; omitted for
   * an unchanged message, whose full part list is rendered.
   */
  partsOverride?: readonly Part[];
  isLastAssistantMessage?: boolean;
  isSessionStreaming?: boolean;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  modelOptions?: SessionModelOption[];
  defaultReasoningExpanded?: boolean;
  onOpenChildSession?: OpenChildSession;
  /** Per-user-message delivery state. v1 surfaces only a "Queued" badge. */
  deliveryState?: MessageDeliveryState;
  /** Opens the message-details sheet; long-press never triggers the copy ActionSheet. */
  onLongPressDetails?: (message: StoredMessage) => void;
  /**
   * When true, the badge row stays mounted for layout stability even after the
   * message has dequeued (during streaming). Visible badge is gated on
   * deliveryState !== 'queued'; the hidden slot retains the same height.
   */
  holdQueuedSlot?: boolean;
  /** Retries a failed message. The failure footer renders only when supplied. */
  onRetryMessage?: (message: StoredMessage) => void;
  /**
   * Whether this row's session can accept a re-send now. When false the failure
   * footer keeps its statement and drops the Retry, so a read-only transcript or
   * a session without a live transport still says why the turn failed. Defaults
   * to true.
   */
  retryAvailable?: boolean;
  /** Copies a failed user message's text back into the composer. */
  onCopyToComposer?: (text: string) => void;
  /** Restores a canceled queued message's prompt back into the composer. */
  onRestoreQueued?: (message: StoredMessage) => void;
  /**
   * When true, consecutive tool parts of an assistant message render as one
   * condensed run row. Off (or omitted) keeps the per-part rendering exactly as
   * it was.
   */
  condenseToolCalls?: boolean;
};

function MessageBubbleImpl({
  message,
  partsOverride,
  isLastAssistantMessage,
  isSessionStreaming,
  getChildMessages,
  modelOptions,
  defaultReasoningExpanded,
  onOpenChildSession,
  deliveryState,
  onLongPressDetails,
  holdQueuedSlot,
  onRetryMessage,
  retryAvailable,
  onCopyToComposer,
  onRestoreQueued,
  condenseToolCalls,
}: Readonly<MessageBubbleProps>) {
  const isUser = message.info.role === 'user';
  const parts = partsOverride ?? message.parts;
  const { copyMessage } = useMessageCopy();
  const colors = useThemeColors();
  const { t } = useTranslation();
  // Copy message offers only the message's own text, so a reasoning-only or
  // tool-only row exposes no copy action.
  const canCopy = hasCopyableText({ parts: messageTextParts(message.parts) });
  const a11y = buildAgentMessageBubbleAccessibilityProps({
    isUser,
    canCopy,
    canOpenDetails: onLongPressDetails !== undefined,
  });

  const handleLongPress = useCallback(() => {
    onLongPressDetails?.(message);
  }, [message, onLongPressDetails]);

  // The bubble is memo-wrapped, but the transcript still re-renders its rows
  // while a message streams. Memoize the derived text on the parts identity so
  // the filter/map/join and the first-human-part scan run once per part list
  // instead of on every one of those renders.
  const userTextContent = useMemo(
    () =>
      isUser
        ? humanTextParts(parts)
            .map(p => p.text)
            .join('\n\n')
        : '',
    [isUser, parts]
  );
  // Copy-to-composer re-sends only the first human-authored text part, so a
  // synthesized attachment notice is not copied and a file-only row hides the
  // button entirely.
  const copyText = useMemo(() => (isUser ? firstHumanText(parts) : ''), [isUser, parts]);

  // Keep actions on the separate host so interactive descendants remain reachable.
  // Accessible Copy retains the existing ActionSheet path; details matches long-press.
  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'copy' && canCopy) {
      void copyMessage(message);
    } else if (event.nativeEvent.actionName === 'details') {
      handleLongPress();
    }
  };

  // Compaction-only message renders as a separator
  const firstPart = parts[0];
  if (parts.length === 1 && firstPart?.type === 'compaction') {
    return (
      <View className="px-4">
        <CompactionSeparator />
      </View>
    );
  }

  // Failed-row footer. Renders when the relevant handler is wired
  // (mobile-w2b wires onRetryMessage/onCopyToComposer); a delivery row needs
  // Retry or Copy, an assistant row needs Retry only. A caller that already
  // knows the session cannot accept a re-send passes `retryAvailable: false`:
  // the footer then still states the failure, with no action that could not
  // act.
  const failure = selectMessageFailure({ deliveryState, info: message.info, retryAvailable });
  const relevantHandlerWired =
    retryAvailable === false ||
    (failure?.kind === 'delivery'
      ? onRetryMessage !== undefined || onCopyToComposer !== undefined
      : onRetryMessage !== undefined);
  // The footer is the failed turn's status, so it sits in the column that turn
  // occupies rather than the row that carries it: a message that never reached
  // the agent is the user's own row, and its title, detail and action row stay
  // under that bubble, which is end-aligned; a failed response — the
  // assistant's own error, and an execution failure carried by the question —
  // takes the assistant's leading edge like every other block of that turn.
  // `items-end` is logical, so the user's column mirrors with the interface.
  // `text-right` is how a line end-aligns here: NativeWind drops
  // `text-align: end`, and RN resolves `right` against the interface direction,
  // so the copy still ends on the trailing side in an RTL interface. The
  // assistant's column names no alignment: its title and detail keep the
  // interface's own start edge, as the assistant rows around them do.
  const trailingFailure = failure?.side === 'user';
  const failureFooter =
    failure !== null && relevantHandlerWired ? (
      <View className={cn('gap-1 px-4 py-1', trailingFailure && 'items-end')}>
        <Text
          className={cn('text-sm text-destructive', trailingFailure && 'text-right')}
          accessibilityLabel={messageFailureLabel(failure)}
        >
          {failure.title}
        </Text>
        {failure.detail !== null ? (
          <Text className={cn('text-xs text-muted-foreground', trailingFailure && 'text-right')}>
            {failure.detail}
          </Text>
        ) : null}
        <View className="flex-row gap-2">
          {failure.canRetry && onRetryMessage ? (
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                onRetryMessage(message);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          ) : null}
          {failure.canCopy && onCopyToComposer && copyText !== '' ? (
            <Button
              variant="outline"
              size="sm"
              onPress={() => {
                onCopyToComposer(copyText);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('agentChat.messageBubble.copyToComposer')}
            >
              <Text>{t('agentChat.messageBubble.copyToComposer')}</Text>
            </Button>
          ) : null}
        </View>
      </View>
    ) : null;

  if (isUser) {
    // Composer, queued-message synthesis, and slash commands emit exactly one
    // human-authored text part, so the separator separates it from synthesized
    // attachment notices.
    const fileParts = parts.filter(part => isFilePart(part));
    const isQueued = deliveryState?.status === 'queued';
    const hasBadgeSlot = isQueued || holdQueuedSlot;
    // A message the transport gave up on is drawn as failed, so the bubble and
    // the status under it read as one item rather than a normal message with a
    // stray note beside it. A destructive hairline marks it without touching the
    // ink: dimming the bubble would composite the message text over the page and
    // drop it below the contrast the 15px copy needs. A message the person
    // stopped, and every failure of the response, leaves the bubble whole.
    const undelivered = failureFooter !== null && failure?.undelivered === true;

    return (
      <View>
        <Pressable onLongPress={handleLongPress} accessible={a11y.accessible} className="px-4 py-1">
          <View className="items-end gap-1">
            {message.parts.some(partRendersContent) ? (
              <Bubble
                side="user"
                className={undelivered ? 'border border-destructive' : undefined}
              >
                <InMessageBubbleContext.Provider value>
                  {userTextContent ? (
                    <ChatMarkdownText value={userTextContent} variant="user" selectable={false} />
                  ) : null}
                  {fileParts.map(part => (
                    <FilePartRenderer
                      key={part.id}
                      part={part}
                      onLongPress={onLongPressDetails ? handleLongPress : undefined}
                    />
                  ))}
                </InMessageBubbleContext.Provider>
              </Bubble>
            ) : null}
            {hasBadgeSlot || onRestoreQueued ? (
              <View className="flex-row items-center gap-2 self-end pr-1">
                {hasBadgeSlot ? (
                  <View
                    accessibilityRole={isQueued ? 'text' : undefined}
                    accessibilityLabel={
                      isQueued ? t('agentChat.messageBubble.queuedAccessibility') : undefined
                    }
                    accessible={isQueued}
                    {...(!isQueued
                      ? {
                          accessibilityElementsHidden: true as const,
                          importantForAccessibility: 'no-hide-descendants' as const,
                        }
                      : {})}
                    pointerEvents={isQueued ? 'auto' : 'none'}
                    className={`flex-row items-center gap-1 self-end pr-1 ${isQueued ? 'opacity-100' : 'opacity-0'}`}
                  >
                    <Clock size={12} color={colors.mutedForeground} />
                    <Text className="text-xs text-muted-foreground">{t('common.queued')}</Text>
                  </View>
                ) : null}
                {!isQueued && onRestoreQueued ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className={QUEUED_CONTROL_MIN_HEIGHT}
                    accessibilityRole="button"
                    accessibilityLabel={t('agentChat.messageBubble.restoreQueuedAccessibility')}
                    onPress={() => {
                      onRestoreQueued(message);
                    }}
                  >
                    <Text>{t('agentChat.messageBubble.restoreQueued')}</Text>
                  </Button>
                ) : null}
              </View>
            ) : null}
          </View>
          {a11y.accessibilityActions.length > 0 ? (
            <View
              accessible
              accessibilityRole={a11y.accessibilityRole}
              accessibilityLabel={a11y.accessibilityLabel}
              accessibilityHint={a11y.accessibilityHint}
              accessibilityActions={a11y.accessibilityActions}
              onAccessibilityAction={handleAccessibilityAction}
              className="absolute inset-0 opacity-0"
              pointerEvents="none"
            />
          ) : null}
        </Pressable>
        {failureFooter}
      </View>
    );
  }

  // Assistant messages: render parts sequentially without a bubble.
  // Row-rhythm contract: py-1 on each of two adjacent wrappers sums to the
  // same value as the gap-2 between parts of one message and the user
  // wrapper's py-1 — every adjacent transcript row pair sits one gap apart.
  const isStreaming = isLastAssistantMessage && isSessionStreaming;
  const renderPart = (part: (typeof message.parts)[number]) => (
    <PartRenderer
      key={part.id}
      part={part}
      isStreaming={isStreaming}
      getChildMessages={getChildMessages}
      defaultReasoningExpanded={defaultReasoningExpanded}
      onOpenChildSession={onOpenChildSession}
      modelOptions={modelOptions}
    />
  );

  return (
    <View>
      {parts.some(part => partRendersContent(part)) ? (
        <Pressable className="px-4 py-1" onLongPress={handleLongPress} accessible={a11y.accessible}>
          <InMessageBubbleContext.Provider value>
            <MessageLongPressProvider message={message} onLongPressDetails={onLongPressDetails}>
              <View className="gap-2">
                {condenseToolCalls
                  ? groupMessageParts(parts, { condense: true }).map(group =>
                      group.kind === 'tool-run' ? (
                        <MessageErrorBoundary key={group.parts[0]?.id}>
                          <CondensedToolRunRow parts={group.parts} />
                        </MessageErrorBoundary>
                      ) : (
                        group.parts.map(renderPart)
                      )
                    )
                  : parts.map(part => renderPart(part))}
              </View>
            </MessageLongPressProvider>
          </InMessageBubbleContext.Provider>
          {a11y.accessibilityActions.length > 0 ? (
            <View
              accessible
              accessibilityRole={a11y.accessibilityRole}
              accessibilityLabel={a11y.accessibilityLabel}
              accessibilityHint={a11y.accessibilityHint}
              accessibilityActions={a11y.accessibilityActions}
              onAccessibilityAction={handleAccessibilityAction}
              className="absolute inset-0 opacity-0"
              pointerEvents="none"
            />
          ) : null}
        </Pressable>
      ) : null}
      {failureFooter}
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
