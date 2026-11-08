import { Mic, Square } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { type Insets, Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import {
  VOICE_INPUT_LG_FRAME_DP,
  VOICE_INPUT_LG_HIT_SLOP_DP,
  VOICE_INPUT_LG_VISUAL_DP,
} from '@/lib/a11y/tap-target';
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
  /** Replaces the size's own slop when a neighbour sits closer than it. */
  hitSlop?: Insets;
};

// For `sm`/`md` the visual class and hitSlop travel as a coupled pair: the tap
// area is the visual frame plus 2 * hitSlop per side, and the pressable node's
// own rect is the visual frame. `lg` is different: its pressable renders the
// platform-minimum frame (`VOICE_INPUT_LG_FRAME_DP`), and the visible circle
// shrinks to `VOICE_INPUT_LG_VISUAL_DP` inside it, so the composer row's look
// stays as shipped while the accessibility frame a screen reader focuses is the
// whole tap area. The composer input row still zeroes the slop on the side that
// faces the send control (`composerFacingHitSlop`, `chat-composer-input-row.tsx`).
const SIZE_STYLES = {
  sm: {
    className: 'h-8 w-8 rounded-full',
    hitSlop: { top: 6, bottom: 6, left: 6, right: 6 },
  },
  md: {
    className: 'h-9 w-9 rounded-full',
    hitSlop: { top: 4, bottom: 4, left: 4, right: 4 },
  },
  lg: {
    className: 'items-center justify-center rounded-full',
    // One frame serves both platforms: 48dp clears iOS's 44pt minimum too,
    // the same convention as `ICON_TARGET_DP` (`tap-target.ts`). The visual
    // circle is identical either way, so a per-platform difference would have
    // nothing to show for it.
    frame: { width: VOICE_INPUT_LG_FRAME_DP, height: VOICE_INPUT_LG_FRAME_DP },
    visual: VOICE_INPUT_LG_VISUAL_DP,
    hitSlop: {
      top: VOICE_INPUT_LG_HIT_SLOP_DP,
      bottom: VOICE_INPUT_LG_HIT_SLOP_DP,
      left: VOICE_INPUT_LG_HIT_SLOP_DP,
      right: VOICE_INPUT_LG_HIT_SLOP_DP,
    },
  },
} satisfies Record<
  VoiceInputButtonSize,
  {
    className: string;
    hitSlop: { top: number; bottom: number; left: number; right: number };
    frame?: { width: number; height: number };
    visual?: number;
  }
>;

type SizeStyle = (typeof SIZE_STYLES)[VoiceInputButtonSize] & {
  frame?: { width: number; height: number };
  visual?: number;
};

// Default (no prop) preserves the original kilo-chat look.
const DEFAULT_STYLE: SizeStyle = {
  className: 'h-10 w-10 rounded-md',
  hitSlop: { top: 2, bottom: 2, left: 2, right: 2 },
} as const;

const ICON_SIZE = 18;
const LISTENING_BG = 'bg-red-600 dark:bg-red-500';
const RESTING_BG = 'bg-secondary';

/**
 * Compact voice-input toggle for composer toolbars. Visual size is controlled
 * by `size`; the `lg` toolbar size puts the platform touch-target minimum
 * (44pt iOS / 48dp Android) on the pressable's own node — the frame a screen
 * reader focuses and a control-size audit reads — and keeps the visible
 * listening circle inside it. While the controller is in `starting` or
 * `stopping`, an ActivityIndicator replaces the icon and the press is ignored.
 * While `listening`, a destructive treatment signals the active session.
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
  const restingBg = isListeningOrStopping ? LISTENING_BG : RESTING_BG;
  const sizeStyle: SizeStyle = size ? SIZE_STYLES[size] : DEFAULT_STYLE;
  const containerClass = cn(
    sizeStyle.className,
    'items-center justify-center active:opacity-70',
    restingBg
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

  if (sizeStyle.frame) {
    // `lg`: the pressable IS the touch target; the circle (background and
    // glyph) is one visual layer inside it.
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={control.accessibilityLabel}
        accessibilityState={{ busy: control.busy, disabled: control.disabled }}
        className={cn(sizeStyle.className, 'active:opacity-70')}
        style={sizeStyle.frame}
        disabled={control.disabled}
        hitSlop={hitSlop ?? sizeStyle.hitSlop}
        onPress={onPress}
      >
        <View
          className={cn('items-center justify-center rounded-full', restingBg)}
          style={{ width: sizeStyle.visual, height: sizeStyle.visual }}
        >
          {renderIcon()}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={control.accessibilityLabel}
      accessibilityState={{ busy: control.busy, disabled: control.disabled }}
      className={containerClass}
      disabled={control.disabled}
      hitSlop={hitSlop ?? sizeStyle.hitSlop}
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
