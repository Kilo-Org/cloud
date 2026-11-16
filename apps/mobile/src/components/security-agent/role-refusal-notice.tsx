import { Info } from '@/components/ui/icons';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useStatusAnnouncement } from '@/lib/a11y/status-announcement';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type RoleRefusalNoticeProps = {
  /** Why this reader has no action to take, once the server answered for their role. */
  message: string;
  /** Spacing owned by the caller; the callout keeps its own geometry. */
  className?: string;
};

/**
 * The one info callout that stands in an action's place when the server's answer
 * is that this reader's role may not act. Both surfaces that receive that answer
 * — the connect screen and the repository picker — word and draw it identically.
 *
 * It fills the action's own slot: full width, the same padding as the
 * description above it, so an answer that arrives after mount changes what the
 * block says without re-centring it under the reader's eyes. It is drawn as a
 * callout at the description's own size and colour: as a bare line in the
 * action's gap it read as a footnote, the faintest text on the screen, leaving
 * the state looking unfinished.
 *
 * It arrives without a press — on the repository picker it replaces the action
 * the reader just used — so it is announced through the shared status channel
 * instead of appearing silently: the polite live region carries it on Android,
 * one imperative announcement carries it elsewhere, never both.
 */
export function RoleRefusalNotice({ message, className }: Readonly<RoleRefusalNoticeProps>) {
  const colors = useThemeColors();
  useStatusAnnouncement(message);

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
      className={cn(
        'min-h-[44px] w-full flex-row items-start gap-2.5 rounded-lg border border-info-tile-border bg-info-tile-bg px-4 py-3',
        className
      )}
    >
      <Info size={16} color={colors.mutedForeground} />
      {/* The sentence takes `foreground`, not the description's muted token: on
          the light info tile the composite surface lifts that token to 4.45:1,
          under the 4.5 text floor the theme test holds it to. The size stays
          the description's. */}
      <Text className="flex-1 text-sm text-foreground">{message}</Text>
    </View>
  );
}
