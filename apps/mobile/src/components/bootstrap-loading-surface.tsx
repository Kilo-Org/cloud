import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Full-screen loading surface for the post-startup bootstrap window.
 *
 * The root layout hides the navigation tree (`opacity-0`) while it resolves a
 * redirect or the account's consent state, so the screen being left is never
 * shown. On a cold start the native splash covers that window; once startup has
 * settled — after a sign-in (or a sign-out) the splash is already gone — the
 * hidden tree painted an empty `bg-background` with no content, spinner, or
 * message, which read as a broken screen (explorer app-blank-after-oauth).
 *
 * This surface keeps one spinner in that window. It is rendered under
 * `AnimatedSplashOverlay`, so during a launch that is still revealing the
 * splash is the visible indicator and this one only appears after the
 * handover.
 */
export function BootstrapLoadingSurface() {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      accessibilityState={{ busy: true }}
      className="absolute inset-0 items-center justify-center bg-background"
    >
      <ActivityIndicator color={colors.mutedForeground} />
    </View>
  );
}
