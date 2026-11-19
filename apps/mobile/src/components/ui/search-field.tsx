import { type RefObject, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInput, type TextInputProps, View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Search, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { INPUT_FRAME_CLASS } from '@/components/ui/input-frame';
import { Text } from '@/components/ui/text';
import { FIELD_CLEAR_BOX_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const SEARCH_ICON_SIZE = 18;
const CLEAR_ICON_SIZE = 16;

type SearchFieldProps = Omit<
  TextInputProps,
  | 'className'
  | 'style'
  | 'value'
  | 'multiline'
  | 'placeholder'
  | 'placeholderTextColor'
  | 'onChangeText'
  | 'clearButtonMode'
> & {
  /** The visible hint while the field is empty, and its accessible name unless `accessibilityLabel` is set. */
  placeholder: string;
  /**
   * Whether the field holds text: it hides the hint line and shows the in-field
   * clear. The caller derives it from `onChangeText`, so the field itself stays
   * uncontrolled (iOS drops keystrokes when state drives `value`).
   */
  hasText: boolean;
  onChangeText: (text: string) => void;
  /** Runs after the clear control empties the native field; defaults to reporting the empty text. */
  onClear?: () => void;
  inputRef?: RefObject<TextInput | null>;
  /** A spinner takes the magnifier's slot while a search runs; the slot keeps its size. */
  busy?: boolean;
  busyLabel?: string;
  /** Layout only: the margins or flex share the field takes in its parent. */
  className?: string;
};

/**
 * The one search field: the bordered control surface every field draws
 * (`INPUT_FRAME_CLASS`, the contract's control radius), a leading magnifier,
 * the shared single-line `Input` with its 44pt box, and an in-field clear on
 * both platforms.
 *
 * The hint is a one-line, tail-ellipsized `Text` over the field, not the
 * native placeholder: Android lays the native hint out at the field's width
 * with no line cap, so copy wider than a narrow field wraps onto a second line
 * inside the one-line box. Both texts share the field's text size and line box,
 * and the hint row starts at the field's start edge, so it sits where the typed
 * text will in either direction.
 */
export function SearchField({
  placeholder,
  accessibilityLabel,
  hasText,
  onChangeText,
  onClear,
  inputRef,
  busy = false,
  busyLabel,
  className,
  ...inputProps
}: Readonly<SearchFieldProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const ownRef = useRef<TextInput>(null);
  const ref = inputRef ?? ownRef;

  return (
    <View className={cn(INPUT_FRAME_CLASS, 'flex-row items-center gap-2 pl-3 pr-3', className)}>
      <View className="size-5 items-center justify-center">
        {busy ? (
          <ActivityIndicator
            size="small"
            color={colors.mutedForeground}
            accessibilityLabel={busyLabel}
          />
        ) : (
          <Search size={SEARCH_ICON_SIZE} color={colors.mutedForeground} />
        )}
      </View>
      <View className="relative min-w-0 flex-1">
        <Input
          ref={ref}
          accessibilityLabel={accessibilityLabel ?? placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          // Keep Android landscape searches in the app instead of the IME's
          // fullscreen editor.
          disableFullscreenUI
          {...inputProps}
          // The frame owns the inset on both sides, so the field adds none: a
          // physical inset here would push the text past the frame in
          // right-to-left layouts, where the row's children swap sides.
          className="pl-0 pr-0 text-sm text-foreground"
          style={{ color: colors.foreground }}
          onChangeText={onChangeText}
        />
        {hasText ? null : (
          <View
            className="absolute inset-0 flex-row items-center justify-start"
            pointerEvents="none"
          >
            <Text
              accessible={false}
              numberOfLines={1}
              ellipsizeMode="tail"
              className="max-w-full shrink text-sm font-normal leading-[normal] text-muted-foreground"
            >
              {placeholder}
            </Text>
          </View>
        )}
      </View>
      {hasText ? (
        <Pressable
          onPress={() => {
            ref.current?.clear();
            if (onClear) {
              onClear();
            } else {
              onChangeText('');
            }
          }}
          accessibilityLabel={t('common.clearSearch')}
          accessibilityRole="button"
          // The shared clear box carries the whole 48pt target on its own node
          // and cancels its extra height, so the field keeps the input's 44pt
          // box. `-me-3` (the frame's own end inset) puts the box's trailing
          // edge on the frame's inner edge, mirrored in right-to-left layouts.
          className={cn(FIELD_CLEAR_BOX_CLASS, '-me-3 active:opacity-70')}
        >
          <X size={CLEAR_ICON_SIZE} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}
