import { useTranslation } from 'react-i18next';

import { AppleLogo } from '@/components/login/apple-logo';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { KeyRound } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type BusyAction } from '@/lib/auth/use-native-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The Apple, Google and passkey rows, shared by the sign-in landing and the
 * pending-link screen.
 *
 * Each row is the shared `Button` in its outline variant: one border, fill,
 * radius, height and label role across the three, and the busy state is the
 * button's own spinner, so a row never changes height while its ceremony runs.
 * The provider mark sits beside the label, in the control's content row, so the
 * label centres on the button and no mark can push it off axis.
 */
export function ProviderButtons({
  showApple,
  showGoogle,
  showPasskey,
  busy,
  disabled,
  onApple,
  onGoogle,
  onPasskey,
}: Readonly<{
  showApple: boolean;
  showGoogle: boolean;
  showPasskey: boolean;
  busy: BusyAction | null;
  disabled: boolean;
  onApple: () => void;
  onGoogle: () => void;
  onPasskey: () => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <>
      {showApple && (
        // The provider row is ours, not Apple's native control: the native
        // button titles itself in the device language, which left English
        // "Sign in with Apple" next to the translated Google and passkey rows
        // when the app language differed from the device language, and it draws
        // its own dark border (about twice the design system hairline) that no
        // buttonStyle can match. Apple's HIG requires the mark and the exact
        // "Sign in with Apple" wording; a custom control satisfies it.
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          loading={busy === 'apple'}
          disabled={disabled}
          onPress={onApple}
          accessibilityLabel={t('login.signInWithApple')}
        >
          <AppleLogo size={18} color={colors.foreground} />
          <Text>{t('login.signInWithApple')}</Text>
        </Button>
      )}

      {showGoogle && (
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          loading={busy === 'google'}
          disabled={disabled}
          onPress={onGoogle}
          accessibilityLabel={t('login.signInWithGoogle')}
        >
          <GoogleLogo size={18} />
          <Text>{t('login.signInWithGoogle')}</Text>
        </Button>
      )}

      {showPasskey && (
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          loading={busy === 'passkey'}
          disabled={disabled}
          onPress={onPasskey}
          accessibilityLabel={t('login.signInWithPasskey')}
        >
          <KeyRound size={18} color={colors.foreground} />
          <Text>{t('login.signInWithPasskey')}</Text>
        </Button>
      )}
    </>
  );
}
