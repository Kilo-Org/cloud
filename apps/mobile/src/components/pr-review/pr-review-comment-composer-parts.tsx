// Presentational pieces for the comment composer (body field, context
// chrome, footer actions). Kept separate so the main composer stays
// under the line cap.

import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, type RefObject, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TextInput,
  type TextInputScrollEvent,
  View,
} from 'react-native';

import {
  BODY_LINE_HEIGHT,
  BODY_MAX_LINES_CLOSED,
  BODY_MAX_LINES_OPEN,
  resolveCommentBodyMaxHeight,
} from '@/components/pr-review/comment-body-geometry';
import {
  PrFormSheetFooter,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type DiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { cn } from '@/lib/utils';

// Body field geometry (line box, whole-line caps) lives in
// comment-body-geometry.ts, kept separate so it stays testable without the
// component import chain.

const BOTTOM_FADE_RADIUS = 6;

// Inset 1 and the radius match the field's border so the fade never draws
// past the rounded corners. LinearGradient is not NativeWind-mapped; the
// physical style object follows the skeleton.tsx overlay pattern.
const BOTTOM_FADE_STYLE = {
  position: 'absolute',
  left: 1,
  right: 1,
  bottom: 1,
  borderRadius: BOTTOM_FADE_RADIUS,
} as const;

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
  const { t } = useTranslation();
  const maxHeight = keyboardVisible
    ? resolveCommentBodyMaxHeight(BODY_MAX_LINES_OPEN)
    : resolveCommentBodyMaxHeight(BODY_MAX_LINES_CLOSED);
  // Content and frame heights come from the same scroll view, so their
  // comparison is scrollability regardless of padding conventions. The fade
  // hides once the user scrolls the last line fully into view, and reappears
  // when they scroll back up.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(false);
  const overflowing =
    contentHeight !== null && frameHeight !== null && contentHeight > frameHeight + 0.5;

  // Android's TextInput onScroll payload only declares contentOffset; the
  // runtime includes contentSize and layoutMeasurement like any ScrollView.
  // onContentSizeChange/onLayout carry the same numbers, so the comparison
  // stays consistent even where the extra fields are absent (tests).
  function handleScroll(event: { nativeEvent: TextInputScrollEvent['nativeEvent'] }) {
    const native = event.nativeEvent as TextInputScrollEvent['nativeEvent'] & {
      contentSize?: { height: number };
      layoutMeasurement?: { height: number };
    };
    if (native.contentSize === undefined || native.layoutMeasurement === undefined) {
      return;
    }
    const nextAtBottom =
      native.contentOffset.y >=
      native.contentSize.height - native.layoutMeasurement.height - 1;
    setAtBottom(current => (current === nextAtBottom ? current : nextAtBottom));
  }

  return (
    <View>
      <TextInput
        ref={inputRef}
        defaultValue={defaultValue}
        editable={!isDisabled}
        placeholder={t('prReview.composer.commentBodyPlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={t('prReview.composer.commentBody')}
        onChangeText={onChangeText}
        onScroll={handleScroll}
        onContentSizeChange={event => {
          setContentHeight(event.nativeEvent.contentSize.height);
        }}
        onLayout={event => {
          setFrameHeight(event.nativeEvent.layout.height);
        }}
        multiline
        textAlignVertical="top"
        // Explicit line-height (no `text-center` per the repo's iOS rule).
        // Whole-line max height so the bottom line is never clipped mid-glyph;
        // multiline still grows on type until the cap, then scrolls.
        className={cn(
          'rounded-md border border-input bg-background pl-3 pr-3 py-1.5 text-sm leading-5 text-foreground',
          'focus:border-ring',
          keyboardVisible ? 'min-h-12' : 'min-h-14'
        )}
        style={{ maxHeight }}
      />
      {overflowing && !atBottom ? (
        <LinearGradient
          pointerEvents="none"
          colors={[`${colors.foreground}00`, `${colors.foreground}0f`]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={[BOTTOM_FADE_STYLE, { height: BODY_LINE_HEIGHT }]}
        />
      ) : null}
    </View>
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
  const { t } = useTranslation();
  return (
    // Lives inside the formSheet ScrollView (not a sticky sibling).
    // Half detent stays a drag-down; keep Cancel above the closed-sheet
    // limit (~874) without scrolling.
    <PrFormSheetFooter>
      {isEdit ? (
        <Button onPress={onSave} disabled={primaryDisabled} accessibilityLabel={t('common.save')}>
          <Text>{t('common.save')}</Text>
        </Button>
      ) : (
        <>
          <Button
            onPress={onCommentNow}
            loading={isSubmitting}
            disabled={primaryDisabled}
            accessibilityLabel={t('prReview.composer.commentNow')}
          >
            <Text>{t('prReview.composer.commentNow')}</Text>
          </Button>
          <Button
            variant="secondary"
            onPress={onAddToReview}
            disabled={isSubmitting}
            className="mt-2"
            accessibilityLabel={t('prReview.composer.addToReview')}
          >
            <Text>{t('prReview.composer.addToReview')}</Text>
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        onPress={onCancel}
        disabled={isSubmitting}
        className="mt-2"
        accessibilityLabel={t('common.cancel')}
      >
        <Text>{t('common.cancel')}</Text>
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
    <View className="gap-0.5 rounded-lg border border-hair-soft bg-secondary px-4 py-2">
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
