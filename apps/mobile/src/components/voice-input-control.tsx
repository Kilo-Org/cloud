import { Mic, Square } from 'lucide-react-native';
import { ActivityIndicator, Pressable, Text } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type VoiceInputStatus } from '@/lib/voice-input/voice-input-state';
import { resolveVoiceInputControlState } from '@/lib/voice-input/voice-input-view-state';

type VoiceInputButtonProps = {
  disabled: boolean;
  onPress(): void;
  status: VoiceInputStatus;
};

const ICON_SIZE = 18;
const HIT_SLOP = { top: 2, bottom: 2, left: 2, right: 2 } as const;
const LISTENING_BG = 'bg-red-600 dark:bg-red-500';
const RESTING_BG = 'bg-secondary';

/**
 * Compact voice-input toggle for composer toolbars. Renders a 10x10 visual
 * square that expands to a 44pt touch target via `hitSlop`. While the
 * controller is in `starting` or `stopping`, an ActivityIndicator replaces
 * the icon and the press is ignored. While `listening`, a destructive
 * treatment signals the active session.
 */
export function VoiceInputButton({
  disabled,
  onPress,
  status,
}: Readonly<VoiceInputButtonProps>): React.ReactElement {
  const colors = useThemeColors();
  const control = resolveVoiceInputControlState(status, disabled);
  const isListeningOrStopping = status === 'listening' || status === 'stopping';
  const showSpinner = control.busy;
  const iconColor = isListeningOrStopping ? colors.destructiveForeground : colors.foreground;
  const restingBg = isListeningOrStopping ? LISTENING_BG : RESTING_BG;
  const containerClass = cn(
    'h-10 w-10 items-center justify-center rounded-md active:opacity-70',
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
      hitSlop={HIT_SLOP}
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
