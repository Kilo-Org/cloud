import { ClipboardPaste } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const SIZE_CLASSES = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
} as const;

type ComposerPasteButtonProps = {
  onPress: () => void;
  disabled?: boolean;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
};

/**
 * Always-present paste control for the agent composers. Replaces the old
 * image-detected `AttachmentPasteHint` row: the button never appears or
 * disappears with clipboard state, so the row it lives in keeps a stable
 * footprint. The caller owns presence (attachment capability) and the disabled
 * state (the composer's input rule, so a full attachment list still pastes
 * text). Pressing reads the clipboard through the shared `useClipboardPaste`
 * path, which attaches a readable image, pastes clipboard text at the caret,
 * and toasts only when the clipboard holds neither.
 *
 * The hit slop lifts each size's frame to Android's 48dp minimum
 * (WCAG 2.5.8 AA) without growing the visual: h-8 (28pt) carries 10pt per
 * side, h-9 (31.5pt) carries 8.25pt.
 */
export function ComposerPasteButton({
  onPress,
  disabled = false,
  size = 'md',
  className,
}: Readonly<ComposerPasteButtonProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={
        size === 'md'
          ? { top: 8.25, bottom: 8.25, left: 8.25, right: 8.25 }
          : { top: 10, bottom: 10, left: 10, right: 10 }
      }
      className={cn(
        SIZE_CLASSES[size],
        'items-center justify-center rounded-full active:opacity-70',
        disabled && 'opacity-50',
        className
      )}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.composer.pasteFromClipboard')}
      accessibilityState={{ disabled }}
    >
      <ClipboardPaste size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}
