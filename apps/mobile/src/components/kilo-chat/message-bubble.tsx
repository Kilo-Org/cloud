import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import { AlertCircle, CheckCircle2, Reply, XCircle } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  getSwipeReplyActiveOffsetX,
  resolveLongPressFeedback,
  shouldStartReplyFromSwipe,
  SWIPE_REPLY_DISTANCE,
  SWIPE_REPLY_MAX_TRANSLATE,
} from './message-gesture-state';
import { MessageMarkdown } from './message-markdown';
import {
  getDeliveryFailureLabel,
  getReplyPreviewText,
  isMessageEdited,
  type ReplyPreviewSource,
} from './message-presentation';
import { MessageReactionPills } from './message-reaction-pills';

type Props = {
  message: Message;
  currentUserId: string | null;
  isFromMe: boolean;
  showAuthor: boolean;
  authorLabel: string;
  pendingActionGroupId: string | null;
  replyToMessage?: ReplyPreviewSource | null;
  onExecuteAction: (message: Message, groupId: string, value: ExecApprovalDecision) => void;
  onReactionPress: (message: Message, emoji: string) => void;
  onLongPress?: (m: Message) => void;
  onSwipeReply?: (m: Message) => void;
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function actionStyleToVariant(
  style: 'primary' | 'danger' | 'secondary'
): 'default' | 'destructive' | 'secondary' {
  if (style === 'danger') {
    return 'destructive';
  }
  if (style === 'secondary') {
    return 'secondary';
  }
  return 'default';
}

function MessageBubbleComponent({
  message,
  currentUserId,
  isFromMe,
  showAuthor,
  authorLabel,
  pendingActionGroupId,
  replyToMessage,
  onExecuteAction,
  onReactionPress,
  onLongPress,
  onSwipeReply,
}: Props) {
  const colors = useThemeColors();
  const isPending = message.id.startsWith('pending-');
  const timestamp = message.clientUpdatedAt ?? message.updatedAt;
  const edited = isMessageEdited(message);
  const swipeX = useSharedValue(0);
  const replyProgress = useSharedValue(0);
  const pressScale = useSharedValue(1);
  const longPressHighlight = useSharedValue(0);
  const canSwipeReply =
    onSwipeReply !== undefined && !isPending && !message.deleted && !message.deliveryFailed;

  function handleExecuteAction(groupId: string, value: ExecApprovalDecision) {
    onExecuteAction(message, groupId, value);
  }

  function handleSwipeReply() {
    onSwipeReply?.(message);
  }

  function handlePressIn() {
    const feedback = resolveLongPressFeedback({ pressed: true, longPressed: false });
    pressScale.value = withTiming(feedback.scale, {
      duration: 120,
      easing: Easing.out(Easing.cubic),
    });
  }

  function handlePressOut() {
    const feedback = resolveLongPressFeedback({ pressed: false, longPressed: false });
    pressScale.value = withTiming(feedback.scale, {
      duration: 160,
      easing: Easing.out(Easing.cubic),
    });
    longPressHighlight.value = withTiming(feedback.highlightOpacity, { duration: 180 });
  }

  function handleLongPress() {
    const feedback = resolveLongPressFeedback({ pressed: true, longPressed: true });
    pressScale.value = withSequence(
      withTiming(feedback.scale, { duration: 90, easing: Easing.out(Easing.cubic) }),
      withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) })
    );
    longPressHighlight.value = withSequence(
      withTiming(feedback.highlightOpacity, { duration: 90 }),
      withTiming(0, { duration: 260 })
    );
    onLongPress?.(message);
  }

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Pan().
  const swipeGesture = Gesture.Pan()
    .activeOffsetX(getSwipeReplyActiveOffsetX())
    .onUpdate(event => {
      if (!canSwipeReply) {
        return;
      }
      const nextX = Math.max(Math.min(event.translationX, 0), -SWIPE_REPLY_MAX_TRANSLATE);
      swipeX.value = nextX;
      replyProgress.value = Math.min(Math.abs(nextX) / SWIPE_REPLY_DISTANCE, 1);
    })
    .onEnd(event => {
      const shouldReply = shouldStartReplyFromSwipe({
        canReply: canSwipeReply,
        translationX: event.translationX,
        velocityX: event.velocityX,
      });
      if (shouldReply) {
        scheduleOnRN(handleSwipeReply);
      }
      swipeX.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.cubic) });
      replyProgress.value = withTiming(0, { duration: 140 });
    })
    .onFinalize(() => {
      swipeX.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.cubic) });
      replyProgress.value = withTiming(0, { duration: 140 });
    });

  const swipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeX.value }, { scale: pressScale.value }],
  }));
  const replyHintStyle = useAnimatedStyle(() => ({
    opacity: replyProgress.value,
    transform: [{ scale: 0.85 + replyProgress.value * 0.15 }],
  }));
  const longPressHighlightStyle = useAnimatedStyle(() => ({
    opacity: longPressHighlight.value,
  }));

  const textColor = isFromMe ? 'text-primary-foreground' : 'text-foreground';
  const deliveryFailureLabel = getDeliveryFailureLabel(message);

  return (
    <GestureDetector gesture={swipeGesture}>
      <Pressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onLongPress={onLongPress ? handleLongPress : undefined}
        className={cn(
          'px-4 py-1',
          isFromMe ? 'items-end' : 'items-start',
          isPending && 'opacity-50'
        )}
      >
        {canSwipeReply && (
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-1 right-4 top-1 justify-center"
            style={replyHintStyle}
          >
            <View className="h-9 w-9 items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-700">
              <Reply size={17} color={colors.foreground} />
            </View>
          </Animated.View>
        )}

        <Animated.View style={swipeStyle}>
          {showAuthor && (
            <View className="mb-0.5 flex-row items-baseline gap-2 px-1">
              <Text className="text-xs font-medium text-muted-foreground">{authorLabel}</Text>
              {timestamp !== null && (
                <Text className="text-[10px] text-muted-foreground">
                  {formatTimestamp(timestamp)}
                </Text>
              )}
            </View>
          )}

          <View
            className={cn(
              'relative max-w-[80%] rounded-2xl px-3 py-2',
              isFromMe ? 'bg-primary' : 'border border-border bg-card dark:bg-secondary'
            )}
          >
            <Animated.View
              pointerEvents="none"
              className={cn(
                'absolute inset-0 rounded-2xl bg-black/5',
                !isFromMe && 'dark:bg-white/10'
              )}
              style={longPressHighlightStyle}
            />
            {message.deleted ? (
              <Text className={cn('text-sm italic opacity-50', textColor)}>[deleted message]</Text>
            ) : (
              <>
                {replyToMessage && (
                  <View
                    className={cn(
                      'mb-2 border-l-2 py-1 pl-2',
                      isFromMe ? 'border-primary-foreground' : 'border-muted-foreground'
                    )}
                  >
                    <Text numberOfLines={2} className={cn('text-xs opacity-80', textColor)}>
                      {getReplyPreviewText(replyToMessage)}
                    </Text>
                  </View>
                )}
                {message.content.map((block, index) => {
                  if (block.type === 'text') {
                    return <MessageMarkdown key={index} text={block.text} isFromMe={isFromMe} />;
                  }

                  // block.type === 'actions'
                  if (block.resolved) {
                    const resolvedAction = block.actions.find(
                      action => action.value === block.resolved?.value
                    );
                    const label = resolvedAction?.label ?? block.resolved.value;
                    const Icon = block.resolved.value.startsWith('allow') ? CheckCircle2 : XCircle;
                    return (
                      <View key={block.groupId} className="mt-2 flex-row items-center gap-1.5">
                        <Icon
                          size={14}
                          color={isFromMe ? colors.primaryForeground : colors.mutedForeground}
                        />
                        <Text className={cn('text-xs opacity-70', textColor)}>{label}</Text>
                      </View>
                    );
                  }

                  return (
                    <View key={block.groupId} className="mt-2 flex-row flex-wrap gap-2">
                      {block.actions.map(action => (
                        <Button
                          key={action.value}
                          variant={actionStyleToVariant(action.style)}
                          size="sm"
                          disabled={pendingActionGroupId === block.groupId}
                          onPress={() => {
                            handleExecuteAction(block.groupId, action.value);
                          }}
                        >
                          <Text>{action.label}</Text>
                        </Button>
                      ))}
                    </View>
                  );
                })}
                {deliveryFailureLabel && (
                  <View className="mt-2 flex-row items-center gap-1.5">
                    <AlertCircle size={14} color={colors.destructive} />
                    <Text className="text-xs font-medium text-red-600 dark:text-red-400">
                      {deliveryFailureLabel}
                    </Text>
                  </View>
                )}
              </>
            )}

            {!showAuthor && timestamp !== null && (
              <Text
                className={cn(
                  'mt-1 text-right text-[10px]',
                  isFromMe ? 'text-primary-foreground opacity-70' : 'text-muted-foreground'
                )}
              >
                {formatTimestamp(timestamp)}
                {edited ? ' (edited)' : ''}
              </Text>
            )}
          </View>

          <MessageReactionPills
            message={message}
            currentUserId={currentUserId}
            isFromMe={isFromMe}
            onReactionPress={onReactionPress}
          />
        </Animated.View>
      </Pressable>
    </GestureDetector>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
