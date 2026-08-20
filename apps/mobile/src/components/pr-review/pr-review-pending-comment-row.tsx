// Pending-comment list pieces for the review-submit sheet: mono
// location label, 2-line body excerpt, trash → confirm-delete, and a
// pressable body that opens the comment composer in edit mode.

import { type RefObject } from 'react';
import { Trash2 } from '@/components/ui/icons';
import { Pressable, TextInput, View } from 'react-native';

import { announceForA11y, moveA11yFocus } from '@/lib/a11y/announce';
import { useFormSheetKeyboardVisible } from '@/components/pr-review/pr-form-sheet-chrome';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';
import { cn } from '@/lib/utils';

type PrReviewPendingCommentRowProps = Readonly<{
  item: PendingReviewItem;
  onPress: () => void;
  onDelete: () => void;
  disabled?: boolean;
  /** True when the comment was written against an older commit than the PR head. */
  stale?: boolean;
}>;

export function PrReviewPendingCommentRow({
  item,
  onPress,
  onDelete,
  disabled = false,
  stale = false,
}: PrReviewPendingCommentRowProps) {
  const colors = useThemeColors();
  const location = pendingCommentLocationLabel(item);

  return (
    <View className="flex-row items-center gap-2 border-t border-hair-soft pt-2">
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={
          stale
            ? `Edit outdated pending comment on ${location}`
            : `Edit pending comment on ${location}`
        }
        className="min-h-9 flex-1 gap-0.5 active:opacity-70"
      >
        <Text className="font-mono-medium text-[11px] text-muted-foreground" numberOfLines={1}>
          {location}
        </Text>
        <Text className="text-xs leading-4 text-foreground" numberOfLines={1}>
          {item.body.trim().length > 0 ? item.body : '(empty)'}
        </Text>
        {stale ? (
          <View className="flex-row items-center gap-1.5">
            <View className="rounded-full border border-warn-tile-border bg-warn-tile-bg px-2 py-0.5">
              <Text className="text-[10px] font-medium uppercase tracking-wide text-warn">
                Outdated
              </Text>
            </View>
            <Text className="flex-1 text-[10px] text-muted-foreground">
              the PR moved since you wrote this.
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Pressable
        onPress={onDelete}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Delete pending comment on ${location}`}
        className="h-8 w-8 items-center justify-center rounded-md active:opacity-60"
      >
        <Trash2 size={14} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

/**
 * Announce a confirmed pending-comment removal and land focus on the
 * always-mounted Review summary input. A toast would paint behind the form
 * sheet on iOS, so the announcement is imperative. `removed` is the caller's
 * confirmed synchronous remove; a stale id announces nothing.
 */
export function focusAfterPendingCommentRemoval(
  inputRef: RefObject<TextInput | null>,
  removed: boolean
): void {
  if (!removed) {
    return;
  }
  announceForA11y('Pending comment deleted');
  moveA11yFocus(inputRef);
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
  staleCount,
}: {
  queuedCount: number;
  staleCount: number;
}) {
  let message = '';
  if (queuedCount === 0) {
    message = 'No comments queued. The review will be submitted with just the event above.';
  } else if (staleCount > 0) {
    message =
      'Comments written against an older commit are not sent. They stay in your queue so you can edit or delete them.';
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
  const keyboardVisible = useFormSheetKeyboardVisible();
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
      // Compact so half-detent and keyboard-open keep footer CTAs at y=0.
      className={cn(
        'rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground',
        'focus:border-ring',
        keyboardVisible ? 'max-h-16 min-h-12' : 'min-h-14 max-h-24'
      )}
    />
  );
}
