// Presentational pieces for the comment composer (body field, context
// chrome, footer actions). Kept separate so the main composer stays
// under the line cap.

import { type ReactNode, type RefObject } from 'react';
import { TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type DiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { cn } from '@/lib/utils';

const BODY_PLACEHOLDER = 'Leave a comment';

export function CommentBodyField({
  inputRef,
  isDisabled,
  defaultValue,
  onChangeText,
}: {
  inputRef: RefObject<TextInput | null>;
  isDisabled: boolean;
  defaultValue: string;
  onChangeText: (value: string) => void;
}) {
  const colors = useThemeColors();
  return (
    <TextInput
      ref={inputRef}
      defaultValue={defaultValue}
      editable={!isDisabled}
      placeholder={BODY_PLACEHOLDER}
      placeholderTextColor={colors.mutedForeground}
      accessibilityLabel="Comment body"
      onChangeText={onChangeText}
      multiline
      textAlignVertical="top"
      // Explicit line-height (no `text-center` per the repo's iOS rule).
      className={cn(
        'min-h-32 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
        'focus:border-ring'
      )}
    />
  );
}

export function ComposerFooter({
  isEdit,
  isSubmitting,
  primaryDisabled,
  onSave,
  onCommentNow,
  onAddToReview,
  onCancel,
}: {
  isEdit: boolean;
  isSubmitting: boolean;
  primaryDisabled: boolean;
  onSave: () => void;
  onCommentNow: () => void;
  onAddToReview: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <View className="border-t-[0.5px] border-hair-soft bg-background px-6 pb-6 pt-3">
      {isEdit ? (
        <Button onPress={onSave} disabled={primaryDisabled} accessibilityLabel="Save">
          <Text>Save</Text>
        </Button>
      ) : (
        <>
          <Button
            onPress={onCommentNow}
            loading={isSubmitting}
            disabled={primaryDisabled}
            accessibilityLabel="Comment now"
          >
            <Text>Comment now</Text>
          </Button>
          <Button
            variant="secondary"
            onPress={onAddToReview}
            disabled={isSubmitting}
            className="mt-2"
            accessibilityLabel="Add to review"
          >
            <Text>Add to review</Text>
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        onPress={onCancel}
        disabled={isSubmitting}
        className="mt-2"
        accessibilityLabel="Cancel"
      >
        <Text>Cancel</Text>
      </Button>
    </View>
  );
}

export function ContextPreview({
  selection,
  fallbackPath,
  fallbackLineLabel,
  fallbackSide,
  preferFallback,
}: {
  selection: DiffSelection | null;
  fallbackPath: string;
  fallbackLineLabel: string;
  fallbackSide: 'LEFT' | 'RIGHT';
  /** When true, never prefer the live bridge over route/item params. */
  preferFallback: boolean;
}) {
  const path = preferFallback ? fallbackPath : (selection?.path ?? fallbackPath);
  const side = preferFallback ? fallbackSide : (selection?.side ?? fallbackSide);
  const lineLabel =
    preferFallback || !selection
      ? fallbackLineLabel
      : composerRangeLabel(selection.line, selection.startLine);
  const previewText = preferFallback ? '' : (selection?.selectedText ?? '');
  return (
    <View className="gap-2 rounded-lg border border-hair-soft bg-secondary p-3">
      <Text className="font-mono-medium text-[11px] text-muted-foreground" numberOfLines={1}>
        {path} {side} {lineLabel}
      </Text>
      {previewText.length > 0 ? (
        <Text className="font-mono-medium text-[12px] leading-5 text-foreground" numberOfLines={6}>
          {previewText}
        </Text>
      ) : (
        <Text variant="muted" className="text-xs">
          {preferFallback ? 'Editing a queued comment.' : 'Selected line context will appear here.'}
        </Text>
      )}
    </View>
  );
}

export function composerRangeLabel(line: number, startLine?: number): string {
  if (startLine !== undefined && startLine !== line) {
    return `L${startLine}–L${line}`;
  }
  return `L${line}`;
}
