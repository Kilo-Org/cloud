import { ClipboardPaste } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

// `md` is the box a control-size audit measures, so its own frame carries the
// target; `sm` keeps its compact frame and lifts the touch region with slop.
const SIZE_CLASSES = {
  sm: 'h-8 w-8',
  md: ICON_TARGET_BOX_CLASS,
} as const;

// Per-side slop of the compact size: the 28dp `sm` frame plus 10dp a side is
// 48dp, Android's minimum (WCAG 2.5.8 AA). `md` needs none, because its box is
// the target.
const SIZE_HIT_SLOP = {
  sm: { top: 10, bottom: 10, left: 10, right: 10 },
  md: undefined,
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
 * The default `md` size renders the shared 48dp box on its own node, because a
 * control-size audit reads that rect and `hitSlop` does not move it. The
 * compact `sm` size keeps its 28pt frame and lifts the touch region with 10pt
 * per side to the same 48dp minimum (WCAG 2.5.8 AA).
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
      hitSlop={SIZE_HIT_SLOP[size]}
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
