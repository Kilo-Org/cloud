// Presentational pieces for the comment composer (body field, context
// chrome, footer actions). Kept separate so the main composer stays
// under the line cap.

import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, type RefObject, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

import {
  BODY_LINE_HEIGHT,
  BODY_MAX_LINES_CLOSED,
  BODY_MAX_LINES_OPEN,
  BODY_VERTICAL_PADDING,
  resolveCommentBodyFade,
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

/** `#rrggbb` to an `rgba()` string; expo-linear-gradient ignores 8-digit hex. */
function fadeColor(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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
  const inset = BODY_VERTICAL_PADDING / 2;
  // Content and frame heights come from the same scroll view, so their
  // comparison is scrollability regardless of padding conventions.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const overflowing = resolveCommentBodyFade({ contentHeight, frameHeight });

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
        onContentSizeChange={event => {
          setContentHeight(event.nativeEvent.contentSize.height);
        }}
        onLayout={event => {
          setFrameHeight(event.nativeEvent.layout.height);
        }}
        multiline
        textAlignVertical="top"
        // Geometry is set here, not through utility classes, so the rendered
        // box and the cap arithmetic share one source: the 20pt line box and
        // the 6pt-per-side inset. The cap ends on a whole line, so the bottom
        // line is never clipped mid-glyph; multiline still grows on type until
        // the cap, then scrolls.
        className={cn(
          'rounded-md border border-input bg-background pl-3 pr-3 text-sm text-foreground',
          'focus:border-ring',
          keyboardVisible ? 'min-h-12' : 'min-h-14'
        )}
        style={{
          maxHeight,
          lineHeight: BODY_LINE_HEIGHT,
          paddingTop: inset,
          paddingBottom: inset,
        }}
      />
      {overflowing ? (
        <LinearGradient
          pointerEvents="none"
          colors={[fadeColor(colors.foreground, 0), fadeColor(colors.foreground, 0.06)]}
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
