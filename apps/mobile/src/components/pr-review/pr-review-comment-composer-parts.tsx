// Presentational pieces for the comment composer (body field, context
// chrome, footer actions). Kept separate so the main composer stays
// under the line cap.

import { type ReactNode, type RefObject } from 'react';
import { TextInput, View } from 'react-native';

import {
  PrFormSheetFooter,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
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
  const keyboardVisible = useFormSheetKeyboardVisible();
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
      // Compact min-height so half-detent + keyboard-open both keep footer
      // CTAs on-screen at scroll offset 0; multiline still grows on type.
      className={cn(
        'rounded-md border border-input bg-background px-3 py-1.5 text-sm leading-5 text-foreground',
        'focus:border-ring',
        keyboardVisible ? 'max-h-16 min-h-12' : 'min-h-14 max-h-28'
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
    // Lives inside the formSheet ScrollView (not a sticky sibling).
    // size=sm + tight footer: half-detent + empty-body error must keep Cancel
    // above the closed-sheet limit (~874) without scrolling.
    <PrFormSheetFooter className="pb-1 pt-1">
      {isEdit ? (
        <Button size="sm" onPress={onSave} disabled={primaryDisabled} accessibilityLabel="Save">
          <Text>Save</Text>
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            onPress={onCommentNow}
            loading={isSubmitting}
            disabled={primaryDisabled}
            accessibilityLabel="Comment now"
          >
            <Text>Comment now</Text>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={onAddToReview}
            disabled={isSubmitting}
            className="mt-0.5"
            accessibilityLabel="Add to review"
          >
            <Text>Add to review</Text>
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        onPress={onCancel}
        disabled={isSubmitting}
        className="mt-0.5"
        accessibilityLabel="Cancel"
      >
        <Text>Cancel</Text>
      </Button>
    </PrFormSheetFooter>
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
  // Single-line context keeps half-detent + keyboard-open room for CTAs.
  return (
    <View className="gap-0.5 rounded-lg border border-hair-soft bg-secondary px-3 py-1.5">
      <Text className="font-mono-medium text-[11px] text-muted-foreground" numberOfLines={1}>
        {path} {side} {lineLabel}
      </Text>
      {previewText.length > 0 ? (
        <Text className="font-mono-medium text-[12px] leading-4 text-foreground" numberOfLines={1}>
          {previewText}
        </Text>
      ) : null}
    </View>
  );
}

export function composerRangeLabel(line: number, startLine?: number): string {
  if (startLine !== undefined && startLine !== line) {
    return `L${startLine}–L${line}`;
  }
  return `L${line}`;
}
