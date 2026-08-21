import { memo } from 'react';
import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { Clock } from '@/components/ui/icons';
import { type AccessibilityActionEvent, Pressable, View } from 'react-native';

import { Bubble } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { InMessageBubbleContext } from './bubble-text-selection-context';
import { ChatMarkdownText } from './chat-markdown-text';
import { CompactionSeparator } from './compaction-separator';
import { FilePartRenderer } from './file-part-renderer';
import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';
import { selectMessageFailure } from './message-failure-state';
import { PartRenderer } from './part-renderer';
import { firstHumanText, isFilePart, isTextPart } from './part-types';
import { useMessageCopy } from './use-message-copy';
import { type OpenChildSession } from './child-session-section';

type MessageBubbleProps = {
  message: StoredMessage;
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
  /** Copies a failed user message's text back into the composer. */
  onCopyToComposer?: (text: string) => void;
};

function MessageBubbleImpl({
  message,
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
  onCopyToComposer,
}: Readonly<MessageBubbleProps>) {
  const isUser = message.info.role === 'user';
  const { copyMessage } = useMessageCopy();
  const colors = useThemeColors();

  const handleLongPress = () => {
    onLongPressDetails?.(message);
  };

  // Long-press opens the details sheet; the VoiceOver/TalkBack rotor "copy"
  // action stays available so a11y tooling still reaches the existing
  // ActionSheet copy path. The wrapping `Pressable` is explicitly
  // `accessible={false}` so iOS does not collapse the message subtree
  // (permission/question `Button`s, child-session "open" `Pressable`, tool
  // cards, file parts, markdown link handlers) into a single, unnavigable
  // node; the role/label/hint/copy action live on a dedicated,
  // non-interactive focusable overlay so the rotor still has a target.
  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'copy') {
      void copyMessage(message);
    }
  };

  // Compaction-only message renders as a separator
  const firstPart = message.parts[0];
  if (message.parts.length === 1 && firstPart?.type === 'compaction') {
    return (
      <View className="px-4">
        <CompactionSeparator />
      </View>
    );
  }

  // Failed-row footer. Renders only when the relevant handler is wired
  // (mobile-w2b wires onRetryMessage/onCopyToComposer); a delivery row needs
  // Retry or Copy, an assistant row needs Retry only.
  const failure = selectMessageFailure({ deliveryState, info: message.info });
  const relevantHandlerWired =
    failure?.kind === 'delivery'
      ? onRetryMessage !== undefined || onCopyToComposer !== undefined
      : onRetryMessage !== undefined;
  const userTextContent = isUser
    ? message.parts
        .filter(isTextPart)
        .map(p => p.text)
        .join('\n\n')
    : '';
  // Copy-to-composer re-sends only the first human-authored text part, so a
  // synthesized attachment notice is not copied and a file-only row hides the
  // button entirely.
  const copyText = isUser ? firstHumanText(message.parts) : '';
  const failureFooter =
    failure !== null && relevantHandlerWired ? (
      <View className="gap-1 px-4 py-1">
        <Text
          className="text-sm text-destructive"
          accessibilityLabel={`${failure.title}.${failure.canRetry ? ' Retry available.' : ''}`}
        >
          {failure.title}
        </Text>
        <Text className="text-xs text-muted-foreground">{failure.detail}</Text>
        <View className="flex-row gap-2">
          {failure.canRetry && onRetryMessage ? (
            <Button
              variant="outline"
              size="sm"
              onPress={() => {
                onRetryMessage(message);
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Text>Retry</Text>
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
              accessibilityLabel="Copy to composer"
            >
              <Text>Copy to composer</Text>
            </Button>
          ) : null}
        </View>
      </View>
    ) : null;

  if (isUser) {
    // Composer, queued-message synthesis, and slash commands emit exactly one
    // human-authored text part, so the separator separates it from synthesized
    // attachment notices.
    const fileParts = message.parts.filter(isFilePart);
    const isQueued = deliveryState?.status === 'queued';
    const hasBadgeSlot = isQueued || holdQueuedSlot;
    const a11y = buildAgentMessageBubbleAccessibilityProps({ isUser: true, canCopy: true });

    return (
      <>
        <Pressable onLongPress={handleLongPress} accessible={a11y.accessible} className="px-4 py-1">
          <View className="items-end gap-1">
            <Bubble side="user">
              <InMessageBubbleContext.Provider value>
                {userTextContent ? (
                  <ChatMarkdownText value={userTextContent} variant="user" selectable={false} />
                ) : null}
                {fileParts.map(part => (
                  <FilePartRenderer key={part.id} part={part} />
                ))}
              </InMessageBubbleContext.Provider>
            </Bubble>
            {hasBadgeSlot ? (
              <View className="flex-row items-center gap-2 self-end pr-1">
                <View
                  accessibilityRole={isQueued ? 'text' : undefined}
                  accessibilityLabel={isQueued ? 'Message queued' : undefined}
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
                  <Text className="text-xs text-muted-foreground">Queued</Text>
                </View>
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
      </>
    );
  }

  // Assistant messages: render parts sequentially without a bubble.
  // Row-rhythm contract: py-1 on each of two adjacent wrappers sums to the
  // same value as the gap-2 between parts of one message and the user
  // wrapper's py-1 — every adjacent transcript row pair sits one gap apart.
  const isStreaming = isLastAssistantMessage && isSessionStreaming;
  const a11y = buildAgentMessageBubbleAccessibilityProps({ isUser: false, canCopy: true });

  return (
    <>
      <Pressable className="px-4 py-1" onLongPress={handleLongPress} accessible={a11y.accessible}>
        <InMessageBubbleContext.Provider value>
          <View className="gap-2">
            {message.parts.map(part => (
              <PartRenderer
                key={part.id}
                part={part}
                isStreaming={isStreaming}
                getChildMessages={getChildMessages}
                defaultReasoningExpanded={defaultReasoningExpanded}
                onOpenChildSession={onOpenChildSession}
                modelOptions={modelOptions}
              />
            ))}
          </View>
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
      {failureFooter}
    </>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
