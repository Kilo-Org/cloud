import { Mic, Square } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
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
const LISTENING_BG = 'bg-red-600 dark:bg-red-500';

/**
 * Voice-input toggle for composer toolbars and the voice test field. It has
 * one geometry: the pressable's own node is the shared 48dp box, which
 * carries the 44pt design target and the 48dp platform minimum, so a
 * control-size audit reads the target itself. Slop is not used — the box is
 * the whole reach — so the toggle cannot reach into a neighbour. A bare icon
 * sits on the box, because a resting circle smaller than the send control's
 * filled circle beside it reads as a mismatched dot, while a live session
 * fills the whole box, which is the destructive treatment that signals the
 * active session. While the controller is in `starting` or `stopping`, an
 * ActivityIndicator replaces the icon and the press is ignored.
 */
export function VoiceInputButton({
  disabled,
  onPress,
  status,
}: Readonly<VoiceInputButtonProps>): React.ReactElement {
  const colors = useThemeColors();
  const control = resolveVoiceInputControlState(status, disabled);
  const isListeningOrStopping =
    status === 'listening' || status === 'stopping' || status === 'transcribing';
  const showSpinner = control.busy;
  const iconColor = isListeningOrStopping ? colors.destructiveForeground : colors.foreground;
  const activeBg = isListeningOrStopping && LISTENING_BG;
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
      className={cn(ICON_TARGET_BOX_CLASS, 'rounded-full', 'active:opacity-70', activeBg)}
      disabled={control.disabled}
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
