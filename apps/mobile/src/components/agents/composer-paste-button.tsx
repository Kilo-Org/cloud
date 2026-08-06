import { ClipboardPaste } from 'lucide-react-native';
import { Pressable } from 'react-native';

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
 * state (the composer's paperclip rule). Pressing reads the clipboard image
 * through the shared `useClipboardImageHint` paste path, which routes a
 * readable image through the attachment upload pipeline and toasts when the
 * clipboard has no readable image.
 */
export function ComposerPasteButton({
  onPress,
  disabled = false,
  size = 'md',
  className,
}: Readonly<ComposerPasteButtonProps>) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      className={cn(
        SIZE_CLASSES[size],
        'items-center justify-center rounded-full active:opacity-70',
        disabled && 'opacity-50',
        className
      )}
      accessibilityRole="button"
      accessibilityLabel="Paste image from clipboard"
      accessibilityState={{ disabled }}
    >
      <ClipboardPaste size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}
