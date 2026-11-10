import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { AppleLogo } from '@/components/login/apple-logo';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { KeyRound } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type BusyAction } from '@/lib/auth/use-native-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// One fixed slot per provider row, taken out of flow at the leading edge. The
// label is centered over the button's own width, so a mark in the row could not
// push it off center; out of flow it also cannot change the row's height or the
// text's box. The slot stretches the row's content height and centers whichever
// of the mark or the inline spinner the row holds, so swapping an 18pt mark for
// the spinner moves nothing. All three rows draw a mark in the slot (the
// passkey row included), so the provider options read as one group.
//
// The slot is inset from the rounded edge by the same 16pt the row insets its
// content: flush at the edge the mark read as cut by the corner, with far less
// inset than the centered label has from the sides (design review, 2026-10-30).
// `start` is the leading edge, so in the right-to-left layout the mark takes the
// same inset from the right edge and clears both corners. Both values are px
// because native rem is 14pt here, so a spacing step would land off the design's
// 16pt.
export const PROVIDER_GLYPH_SLOT_CLASS =
  'absolute start-[16px] top-0 bottom-0 w-[18px] items-center justify-center';

// The mark's 16pt inset plus its own 18pt width: the row's content box starts
// where the mark ends, so the centered label can never run under the mark
// however long the translation is, and the equal start and end insets keep it
// centered on the button.
export const PROVIDER_ROW_CLASS =
  'relative min-h-[44px] w-full flex-row justify-center rounded-[8px] px-[34px] py-2.5';

/** The Apple, Google and passkey rows, shared by the sign-in landing and the pending-link screen. */
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
  busy: BusyAction;
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
        // buttonStyle can match. The label comes from the catalog
        // (`login.signInWithApple`), and the mark and outline chrome match the
        // two rows below it: one border colour and width, one fill, radius,
        // height and label weight across the three. Apple's HIG requires the
        // mark and the exact "Sign in with Apple" wording; a custom control
        // satisfies it, as does the Google button.
        <Button
          variant="outline"
          size="lg"
          // Same chrome and label axis as the Google and passkey rows below:
          // the mark is out of flow at the leading edge, so the label centers
          // on the button's own width at the shared 44pt floor and all three
          // provider rows keep one height.
          className={PROVIDER_ROW_CLASS}
          disabled={disabled}
          onPress={onApple}
          accessibilityLabel={t('login.signInWithApple')}
        >
          <View className={PROVIDER_GLYPH_SLOT_CLASS}>
            {busy === 'apple' ? (
              <ActivityIndicator size="small" />
            ) : (
              <AppleLogo size={18} color={colors.foreground} />
            )}
          </View>
          <Text className="flex-1 text-center text-[17px] font-medium">
            {t('login.signInWithApple')}
          </Text>
        </Button>
      )}

      {showGoogle && (
        <Button
          variant="outline"
          size="lg"
          // min-h (not fixed h) so Dynamic Type can grow the control; keep
          // Apple-parity 44pt floor and full-width rounded chrome. The row is
          // pinned to one line (no flex-wrap) so the Google and passkey buttons
          // keep the same height: a wrapped label made the passkey button a row
          // taller than the Google button above it (2026-09-20 device finding).
          // The label takes the whole content width, so it centers on the
          // button rather than on the space the mark leaves over.
          className={PROVIDER_ROW_CLASS}
          disabled={disabled}
          onPress={onGoogle}
          accessibilityLabel={t('login.signInWithGoogle')}
        >
          <View className={PROVIDER_GLYPH_SLOT_CLASS}>
            {busy === 'google' ? <ActivityIndicator size="small" /> : <GoogleLogo size={18} />}
          </View>
          <Text className="flex-1 text-center text-[17px] font-medium">
            {t('login.signInWithGoogle')}
          </Text>
        </Button>
      )}

      {showPasskey && (
        <View
          className={disabled ? 'opacity-50' : undefined}
          pointerEvents={disabled ? 'none' : 'auto'}
        >
          <Button
            variant="outline"
            size="lg"
            // min-h (not fixed h) so Dynamic Type can grow the control, matching
            // the Google button's Apple-parity 44pt floor. The flex-1 label box
            // gives the copy the whole content width and centers it on the
            // button, but a label wider than that box still wraps and makes this
            // row taller than the Google row above it (the Arabic label once
            // did). The row therefore stays one line only while every catalog's
            // `login.signInWithPasskey` fits the compact 360dp content width
            // (248dp at the 17pt label size); the 14 locales whose label was
            // wider are phrased short for that reason, not for style.
            className={PROVIDER_ROW_CLASS}
            disabled={disabled}
            onPress={onPasskey}
            accessibilityLabel={t('login.signInWithPasskey')}
          >
            <View className={PROVIDER_GLYPH_SLOT_CLASS}>
              {busy === 'passkey' ? (
                <ActivityIndicator size="small" />
              ) : (
                // Same leading-glyph slot as the Apple and Google rows, so the
                // three provider options read as one group.
                <KeyRound size={18} color={colors.foreground} />
              )}
            </View>
            <Text className="flex-1 text-center text-[17px] font-medium">
              {t('login.signInWithPasskey')}
            </Text>
          </Button>
        </View>
      )}
    </>
  );
}
