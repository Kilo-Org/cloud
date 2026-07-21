import { Mic, Square } from 'lucide-react-native';
import { ActivityIndicator, Pressable, Text } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type VoiceInputStatus } from '@/lib/voice-input/voice-input-state';
import { resolveVoiceInputControlState } from '@/lib/voice-input/voice-input-view-state';

type VoiceInputButtonSize = 'sm' | 'md';

type VoiceInputButtonProps = {
  disabled: boolean;
  onPress(): void;
  status: VoiceInputStatus;
  size?: VoiceInputButtonSize;
};

// Visual class and hitSlop travel as a coupled pair so the effective touch
// target stays >=44pt (visual size + 2 * hitSlop per side) at every size.
const SIZE_STYLES: Record<
  VoiceInputButtonSize,
  {
    className: string;
    hitSlop: { top: number; bottom: number; left: number; right: number };
  }
> = {
  sm: {
    className: 'h-8 w-8 rounded-full',
    hitSlop: { top: 6, bottom: 6, left: 6, right: 6 },
  },
  md: {
    className: 'h-9 w-9 rounded-full',
    hitSlop: { top: 4, bottom: 4, left: 4, right: 4 },
  },
};

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
 * target via `hitSlop`. While the controller is in `starting` or `stopping`,
 * an ActivityIndicator replaces the icon and the press is ignored. While
 * `listening`, a destructive treatment signals the active session.
 */
export function VoiceInputButton({
  disabled,
  onPress,
  size,
  status,
}: Readonly<VoiceInputButtonProps>): React.ReactElement {
  const colors = useThemeColors();
  const control = resolveVoiceInputControlState(status, disabled);
  const isListeningOrStopping = status === 'listening' || status === 'stopping';
  const showSpinner = control.busy;
  const iconColor = isListeningOrStopping ? colors.destructiveForeground : colors.foreground;
  const restingBg = isListeningOrStopping ? LISTENING_BG : RESTING_BG;
  const sizeStyle = size ? SIZE_STYLES[size] : DEFAULT_STYLE;
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={control.accessibilityLabel}
      accessibilityState={{ busy: control.busy, disabled: control.disabled }}
      className={containerClass}
      disabled={control.disabled}
      hitSlop={sizeStyle.hitSlop}
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
  if (status !== 'listening') {
    return null;
  }
  return (
    <Text accessibilityLiveRegion="polite" className="text-muted-foreground text-xs">
      Listening...
    </Text>
  );
}
