import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  type ActiveProfileIndicatorLayer,
  type ActiveProfileIndicatorState,
} from '@/components/agents/active-profile-indicator-model';
import { SlidersHorizontal } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ActiveProfileIndicatorProps = {
  state: ActiveProfileIndicatorState | null;
  /** Opens the profile picker (new session) or the profile editor (session). */
  onPress: () => void;
  className?: string;
};

/**
 * The active-profile chip: a translated label plus its layers in the
 * accessibility label. Renders nothing when no profile or manual config
 * applies, so the caller never reserves space for an absent state.
 */
export function ActiveProfileIndicator({
  state,
  onPress,
  className,
}: Readonly<ActiveProfileIndicatorProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  if (!state) {
    return null;
  }

  const layerText = (layer: ActiveProfileIndicatorLayer): string => {
    const label = t(layer.labelKey);
    const detail = layer.detail ?? layer.detailKeys?.map(key => t(key)).join(', ');
    return detail ? `${label}: ${detail}` : label;
  };
  const accessibleLabel = [
    t(state.labelKey),
    ...state.layers.map(layerText),
    t('agentChat.newSession.openSettingsToReview'),
  ].join('. ');

  return (
    <Pressable
      className={cn(
        'min-h-8 flex-row items-center gap-1.5 rounded-full border px-2.5 py-1 active:opacity-70',
        state.needsAttention
          ? 'border-warn-tile-border bg-warn-tile-bg'
          : 'border-border bg-secondary',
        className
      )}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibleLabel}
    >
      <SlidersHorizontal
        size={14}
        color={state.needsAttention ? colors.warn : colors.mutedForeground}
      />
      <Text
        className={cn(
          'text-sm font-medium',
          state.needsAttention ? 'text-warn' : 'text-foreground'
        )}
        numberOfLines={1}
      >
        {t(state.labelKey)}
      </Text>
    </Pressable>
  );
}
