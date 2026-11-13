/* eslint-disable max-lines -- the transcript element-tree suite asserts this component's unrendered tree, so splitting the failure footer behind a component boundary would hide every assertion's target */
import { memo, useCallback, useMemo } from 'react';
import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { AlertCircle, Clock } from '@/components/ui/icons';
import { type AccessibilityActionEvent, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AddCreditsRow } from '@/components/add-credits-row';
import { Bubble } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type AddCreditsDestination, addCreditsProps } from '@/lib/credits/add-credits-destination';
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
import {
  isGenericResponseFailure,
  type MessageDeliveryStatement,
  messageFailureLabel,
  selectMessageFailure,
} from './message-failure-state';
import { partRendersContent, userBubbleRendersContent } from './message-visibility';
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
  /**
   * What the turn's delivery did, as the SDK recorded it or as the chat states
   * it (`MessageDeliveryStatement`). v1 surfaces only a "Queued" badge.
   */
  deliveryState?: MessageDeliveryStatement;
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
   * Where the credit a refused turn needs is bought: the in-app purchase screen
   * for the person's own balance, or the organization's billing page for a
   * session the organization pays for. Adding credits never needs the session to
   * accept a re-send, so this action renders even where `retryAvailable` is
   * false. A destination the platform may not open renders no action.
   */
  addCredits?: AddCreditsDestination;
  /**
   * Whether this row's session can accept a re-send now. When false the failure
   * footer keeps its statement and drops the Retry, so a read-only transcript or
   * a session without a live transport still says why the turn failed. Defaults
   * to true.
   */
  retryAvailable?: boolean;
  /** Copies a failed user message's text back into the composer. */
  onCopyToComposer?: (text: string) => void;
  /**
   * Whether this turn's preparation group states its failure. The group names
   * the stage that failed and the reason, so a generic response-failure
   * statement here would state the same turn twice; the footer keeps its
   * actions and drops that statement. A classified failure is still shown.
   * Defaults to false.
   */
  failureStatedByPreparation?: boolean;
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
  addCredits,
  retryAvailable,
  onCopyToComposer,
  failureStatedByPreparation,
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

  // The parts this row draws, and the single list both branches below gate on.
  // A row can arrive with nothing visible: the transcript keeps a message item
  // while a live turn streams its parts in, and a confirmed user row stays until
  // its parts land. Drawing the long-press wrapper around that empty row left an
  // empty interactive strip (its own py-1, plus an invisible focus stop) in the
  // transcript, so the wrapper is rendered only when there is something in it.
  const visibleParts = useMemo(() => parts.filter(part => partRendersContent(part)), [parts]);

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

  // Compaction-only message renders as a separator, excluding hidden display parts.
  const firstPart = visibleParts[0];
  if (visibleParts.length === 1 && firstPart?.type === 'compaction') {
    return (
      <View className="px-4">
        <CompactionSeparator
          info={message.info}
          isStreaming={isLastAssistantMessage && isSessionStreaming}
        />
      </View>
    );
  }

  // Failed-row footer. Renders when the relevant handler is wired
  // (mobile-w2b wires onRetryMessage/onCopyToComposer); a delivery row needs
  // Retry, Copy, or — for the send the balance refused — Add credits, and an
  // assistant row needs Retry or, when the account's balance caused the
  // failure, Add credits. A caller that already knows the session cannot accept
  // a re-send passes `retryAvailable: false`: the footer then still states the
  // failure, with no action that could not act.
  const failure = selectMessageFailure({ deliveryState, info: message.info, retryAvailable });
  // A turn whose preparation failed states that failure in its preparation
  // group, with the stage and the reason. The generic response-failure
  // statement would state the same turn again, so only the statement goes: the
  // actions stay here, because a collapsed group must not be able to hide the
  // turn's recovery.
  const statedByPreparation =
    failureStatedByPreparation === true && failure !== null && isGenericResponseFailure(failure);
  const relevantHandlerWired =
    retryAvailable === false ||
    (failure !== null &&
      (failure.kind === 'delivery'
        ? onRetryMessage !== undefined ||
          onCopyToComposer !== undefined ||
          (failure.canAddCredits && addCredits !== undefined)
        : onRetryMessage !== undefined || (failure.canAddCredits && addCredits !== undefined)));
  // The actions this row would draw, resolved once: the footer is skipped when
  // the preparation group states the failure and no action is left, so a blank
  // padded block never sits above that group.
  const retryAction = failure?.canRetry === true ? onRetryMessage : undefined;
  const creditsAction = failure?.canAddCredits === true ? addCredits : undefined;
  const copyAction = failure?.canCopy === true && copyText !== '' ? onCopyToComposer : undefined;
  const actionRenders =
    retryAction !== undefined || creditsAction !== undefined || copyAction !== undefined;
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
    failure !== null && relevantHandlerWired && (!statedByPreparation || actionRenders) ? (
      /* The actions close the turn rather than opening the next one: the space
         under them is the gap between turns, so a Retry is never read as part of
         the message that follows it. 24 dp is more than twice the gap between a
         bubble and its own status line, which is what keeps a turn's status and
         actions in its own group. `items-end` is logical, so the status stays
         with the end-aligned bubble in either direction. */
      <View className={cn('gap-2 px-4 pt-1 pb-[24px]', trailingFailure && 'items-end')}>
        {statedByPreparation ? null : (
          <>
            <View className={cn('flex-row items-center gap-1.5', trailingFailure && 'justify-end')}>
              {failure.error ? (
                // Every failure that reports an error carries the same marker; a
                // message the person stopped, and a response the person stopped,
                // report a neutral status and carry none. The marker is the
                // state, not copy: the title beside it says what happened, so it
                // carries no text of its own for a screen reader.
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <AlertCircle size={14} color={colors.destructive} />
                </View>
              ) : null}
              <Text
                className={cn(
                  'text-sm',
                  // The ink is the state too: a neutral status takes the muted
                  // ink every other status line in a turn uses, so a stop never
                  // reads as a failure.
                  failure.error ? 'text-destructive' : 'text-muted-foreground',
                  trailingFailure && 'text-right'
                )}
                accessibilityLabel={messageFailureLabel(failure)}
              >
                {failure.title}
              </Text>
            </View>
            {failure.detail !== null ? (
              <Text
                className={cn(
                  'text-sm leading-[1.25rem] text-muted-foreground',
                  trailingFailure && 'text-right'
                )}
              >
                {failure.detail}
              </Text>
            ) : null}
          </>
        )}
        <View className="flex-row gap-2">
          {retryAction ? (
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                retryAction(message);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          ) : null}
          {creditsAction ? (
            // The failure's one recovery action, so it keeps the accent surface
            // the person's own bubble and the enabled send control fill with,
            // in both schemes; the theme's `--primary` is olive in light, which
            // would read as one more secondary action here. The element owns
            // where the credit is bought — the person's own purchase screen or
            // the organization's billing page — and hides itself where the
            // platform may not open the destination.
            <AddCreditsRow inline emphasis="primary" {...addCreditsProps(creditsAction)} />
          ) : null}
          {copyAction ? (
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                copyAction(copyText);
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
    // The wrapper carries the row's padding and its long-press surface, so it
    // is drawn only when the row draws content or holds a control. The bubble's
    // own predicate answers for the bubble: a row whose parts render nothing —
    // or whose only part is the server's synthetic context wrapper — draws no
    // bubble, and must not leave the empty strip around it.
    const drawsBubble = userBubbleRendersContent(parts);
    const drawsControls = hasBadgeSlot === true || onRestoreQueued !== undefined;

    return (
      <View>
        {drawsBubble || drawsControls ? (
          <Pressable
            onLongPress={handleLongPress}
            accessible={a11y.accessible}
            className="px-4 py-1"
          >
            <View className="items-end gap-1">
              {drawsBubble ? (
                <Bubble side="user">
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
        ) : null}
        {failureFooter}
      </View>
    );
  }

  // Assistant messages: render parts sequentially without a bubble.
  // Row-rhythm contract: py-1 on each of two adjacent wrappers sums to the
  // same value as the gap-2 between parts of one message and the user
  // wrapper's py-1 — every adjacent transcript row pair sits one gap apart.
  // The wrapper is drawn only for a row that draws a part, so an assistant row
  // still waiting for its first part leaves no padded strip in the transcript.
  const isStreaming = isLastAssistantMessage && isSessionStreaming;
  const renderPart = (part: (typeof message.parts)[number]) => (
    <PartRenderer
      key={part.id}
      part={part}
      messageInfo={message.info}
      isStreaming={isStreaming}
      getChildMessages={getChildMessages}
      defaultReasoningExpanded={defaultReasoningExpanded}
      onOpenChildSession={onOpenChildSession}
      modelOptions={modelOptions}
    />
  );

  return (
    <View>
      {visibleParts.length > 0 ? (
        <Pressable className="px-4 py-1" onLongPress={handleLongPress} accessible={a11y.accessible}>
          <InMessageBubbleContext.Provider value>
            <MessageLongPressProvider message={message} onLongPressDetails={onLongPressDetails}>
              <View className="gap-2">
                {condenseToolCalls
                  ? groupMessageParts(visibleParts, { condense: true }).map(group =>
                      group.kind === 'tool-run' ? (
                        <MessageErrorBoundary key={group.parts[0]?.id}>
                          <CondensedToolRunRow parts={group.parts} />
                        </MessageErrorBoundary>
                      ) : (
                        group.parts.map(renderPart)
                      )
                    )
                  : visibleParts.map(part => renderPart(part))}
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
