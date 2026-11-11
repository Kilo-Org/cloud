import { Mic, Square } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { type Insets, Pressable } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type VoiceInputStatus } from '@/lib/voice-input/voice-input-state';
import { resolveVoiceInputControlState } from '@/lib/voice-input/voice-input-view-state';

type VoiceInputButtonSize = 'sm' | 'md' | 'lg';

type VoiceInputButtonProps = {
  disabled: boolean;
  onPress(): void;
  status: VoiceInputStatus;
  size?: VoiceInputButtonSize;
  /**
   * Replaces the size's own slop when a neighbour sits closer than it. `lg`
   * ignores it: its box is the whole target.
   */
  hitSlop?: Insets;
};

// `sm` and `md` render the visual frame on the pressable and carry the rest of
// the tap area as a coupled slop pair: the tap area is the visual frame plus
// 2 * hitSlop per side. `lg` has no entry: it renders the shared 48dp box on the
// pressable, so no call site can ship it below 44pt iOS / 48dp Android.
const SIZE_STYLES = {
  sm: {
    className: 'h-8 w-8 rounded-full',
    hitSlop: { top: 6, bottom: 6, left: 6, right: 6 },
  },
  md: {
    className: 'h-9 w-9 rounded-full',
    hitSlop: { top: 4, bottom: 4, left: 4, right: 4 },
  },
} satisfies Record<'sm' | 'md', { className: string; hitSlop: Insets }>;

// Default (no prop) preserves the original kilo-chat look.
const DEFAULT_STYLE = {
  className: 'h-10 w-10 rounded-md',
  hitSlop: { top: 2, bottom: 2, left: 2, right: 2 },
} as const;

const ICON_SIZE = 18;
const LISTENING_BG = 'bg-red-600 dark:bg-red-500';
const RESTING_BG = 'bg-secondary';

/**
 * Compact voice-input toggle for composer toolbars. Visual size is controlled
 * by `size`; the default renders a 10x10 square that expands to a 44pt touch
 * target via `hitSlop`, and `lg` puts the platform touch-target minimum
 * (44pt iOS / 48dp Android) on the pressable's own node — the frame a screen
 * reader focuses and a control-size audit reads — and draws a bare icon there,
 * because a resting circle smaller than the send control's filled circle beside
 * it reads as a mismatched dot. While the controller is in `starting` or
 * `stopping`, an ActivityIndicator replaces the icon and the press is ignored.
 * While `listening`, the whole box fills, which is the destructive treatment
 * that signals the active session.
 */
export function VoiceInputButton({
  disabled,
  hitSlop,
  onPress,
  size,
  status,
}: Readonly<VoiceInputButtonProps>): React.ReactElement {
  const colors = useThemeColors();
  const control = resolveVoiceInputControlState(status, disabled);
  const isListeningOrStopping =
    status === 'listening' || status === 'stopping' || status === 'transcribing';
  const showSpinner = control.busy;
  const iconColor = isListeningOrStopping ? colors.destructiveForeground : colors.foreground;
  const activeBg = isListeningOrStopping && LISTENING_BG;
  // `lg` renders the shared 48dp box on the pressable, so its own node is the
  // whole target; the smaller sizes render the visual frame on the node and the
  // slop carries the reach.
  const fullTarget = size === 'lg';
  const smallStyle = size && size !== 'lg' ? SIZE_STYLES[size] : DEFAULT_STYLE;
  const containerClass = fullTarget
    ? cn(ICON_TARGET_BOX_CLASS, 'rounded-full', 'active:opacity-70', activeBg)
    : cn(
        smallStyle.className,
        'items-center justify-center',
        'active:opacity-70',
        activeBg || RESTING_BG
      );
  const renderIcon = (): React.ReactElement => {
    if (showSpinner) {
      return <ActivityIndicator color={iconColor} size="small" />;
    }
    if (control.icon === 'microphone') {
      return <Mic color={iconColor} size={ICON_SIZE} />;
    }
    return <Square color={iconColor} size={ICON_SIZE} />;
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={control.accessibilityLabel}
      accessibilityState={{ busy: control.busy, disabled: control.disabled }}
      className={containerClass}
      disabled={control.disabled}
      hitSlop={fullTarget ? undefined : (hitSlop ?? smallStyle.hitSlop)}
      onPress={onPress}
    >
      {renderIcon()}
    </Pressable>
  );
}

type VoiceInputStatusProps = {
  status: VoiceInputStatus;
};

/**
 * Visible "Listening..." caption rendered under the composer while the
 * voice session is live. Returns `null` in every other status to keep the
 * composer's footprint unchanged outside of an active session.
 */
export function VoiceInputStatus({
  status,
}: Readonly<VoiceInputStatusProps>): React.ReactElement | null {
  const { t } = useTranslation();
  if (status === 'listening') {
    return (
      <AccessibleStatus message={t('voiceInput.listening')} tone="status" className="text-xs" />
    );
  }
  if (status === 'transcribing') {
    return (
      <AccessibleStatus message={t('voiceInput.transcribing')} tone="status" className="text-xs" />
    );
  }
  return null;
}
