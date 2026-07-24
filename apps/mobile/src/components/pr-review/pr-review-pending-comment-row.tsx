// Pending-comment list pieces for the review-submit sheet: mono
// location label, 2-line body excerpt, trash → confirm-delete, and a
// pressable body that opens the comment composer in edit mode.

import { type RefObject } from 'react';
import { Trash2 } from 'lucide-react-native';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';
import { cn } from '@/lib/utils';

type PrReviewPendingCommentRowProps = Readonly<{
  item: PendingReviewItem;
  onPress: () => void;
  onDelete: () => void;
  disabled?: boolean;
}>;

export function PrReviewPendingCommentRow({
  item,
  onPress,
  onDelete,
  disabled = false,
}: PrReviewPendingCommentRowProps) {
  const colors = useThemeColors();
  const location = pendingCommentLocationLabel(item);

  return (
    <View className="flex-row items-start gap-2 border-t border-hair-soft pt-3">
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Edit pending comment on ${location}`}
        className="min-h-11 flex-1 gap-1 active:opacity-70"
      >
        <Text className="font-mono-medium text-[11px] text-muted-foreground" numberOfLines={1}>
          {location}
        </Text>
        <Text className="text-sm leading-5 text-foreground" numberOfLines={2}>
          {item.body.trim().length > 0 ? item.body : '(empty)'}
        </Text>
      </Pressable>
      <Pressable
        onPress={onDelete}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Delete pending comment on ${location}`}
        className="h-9 w-9 items-center justify-center rounded-md active:opacity-60"
      >
        <Trash2 size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

/** Mono location label matching the composer range format (en dash). */
function pendingCommentLocationLabel(item: {
  path: string;
  line: number;
  startLine?: number;
}): string {
  if (item.startLine !== undefined && item.startLine !== item.line) {
    return `${item.path}:L${item.startLine}–L${item.line}`;
  }
  return `${item.path}:L${item.line}`;
}

export function PendingQueueHint({
  queuedCount,
  hasStaleItems,
}: {
  queuedCount: number;
  hasStaleItems: boolean;
}) {
  let message = '';
  if (queuedCount === 0) {
    message = 'No comments queued. The review will be submitted with just the event above.';
  } else if (hasStaleItems) {
    message =
      'Some comments may be outdated because the PR head changed after they were queued. Submission will use the current head.';
  } else {
    message = 'All comments will be sent in a single batched request.';
  }
  return (
    <Text variant="muted" className="text-xs">
      {message}
    </Text>
  );
}

export function ReviewSummaryField({
  bodyRef,
  inputRef,
  isDisabled,
  onChange,
}: {
  bodyRef: RefObject<string>;
  inputRef: RefObject<TextInput | null>;
  isDisabled: boolean;
  onChange: () => void;
}) {
  const colors = useThemeColors();
  return (
    <TextInput
      ref={inputRef}
      defaultValue=""
      editable={!isDisabled}
      placeholder="Optional summary for the review"
      placeholderTextColor={colors.mutedForeground}
      accessibilityLabel="Review summary"
      onChangeText={value => {
        bodyRef.current = value;
        onChange();
      }}
      multiline
      textAlignVertical="top"
      className={cn(
        'min-h-24 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
        'focus:border-ring'
      )}
    />
  );
}
