import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import logo from '@/../assets/images/logo.png';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
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
 * This surface keeps one spinner in that window, branded the same way as the
 * sign-in screen (the Kilo mark above it, `common.loading` below it): the bare
 * spinner alone read as an unbranded blank page (explorer signin-language). It
 * is rendered under `AnimatedSplashOverlay`, so during a launch that is still
 * revealing the splash is the visible indicator and this one only appears after
 * the handover.
 *
 * The login screen renders it directly for its own full-screen hold — the
 * approved device-auth token is written and the root layout redirects while
 * that screen still owns the tree — so the sign-in flow has one branded wait
 * surface instead of a second bare spinner.
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
      <Image source={logo} className="mb-4 h-16 w-16" accessibilityLabel={t('login.logo')} />
      <ActivityIndicator color={colors.mutedForeground} />
      <Text variant="muted" className="mt-4">
        {t('common.loading')}
      </Text>
    </View>
  );
}
