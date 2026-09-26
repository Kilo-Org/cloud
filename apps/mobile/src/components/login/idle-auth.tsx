/* eslint-disable max-lines -- the idle login screen owns every provider control, the SSO recovery block, and the email/OTP switch in one surface */
import { isAvailableAsync as isAppleAuthAvailableAsync } from 'expo-apple-authentication';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { toast } from 'sonner-native';
import * as WebBrowser from 'expo-web-browser';

import { AppleLogo } from '@/components/login/apple-logo';
import { EmailOtpForm } from '@/components/login/email-otp-form';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { KeyRound } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import {
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_ROW_CLASS,
  inlineLinkHitSlop,
} from '@/lib/a11y/tap-target';
import { useNativeAuth } from '@/lib/auth/use-native-auth';
import { passkeysSupported } from '@/lib/auth/passkey-client';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { setLoginEmailDraft, setSsoRecoveryDraft, type SsoRecoveryDraft } from '@/lib/login-draft';
import { cn } from '@/lib/utils';

// One fixed slot per provider row. It reserves the same width in all three
// rows, so the flex-1 label starts from the same x, and it holds whichever of
// the mark or the inline spinner the row has - swapping an 18pt mark for the
// spinner cannot move the label. All three rows draw a mark in the slot (the
// passkey row included), so the three provider options read as one group.
export const PROVIDER_GLYPH_SLOT_CLASS = 'h-[18px] w-[18px] items-center justify-center';

export function IdleAuth({
  start,
  initialEmail = '',
  initialSsoRecovery = null,
  onBusyChange,
}: Readonly<{
  start: (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;
  initialEmail?: string;
  initialSsoRecovery?: SsoRecoveryDraft | null;
  onBusyChange?: (busy: boolean) => void;
}>) {
  const {
    busy,
    emailError,
    clearEmailError,
    googleConfigured,
    signInWithApple,
    signInWithGoogle,
    signInWithPasskey,
    requestEmailCode,
    verifyEmailCode,
    ssoRecovery,
    clearSsoRecovery,
    handleSsoError,
  } = useNativeAuth();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [view, setView] = useState<'main' | 'otp'>('main');
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [browserAuthStarting, setBrowserAuthStarting] = useState(false);
  const emailRef = useRef(initialEmail);
  const browserAuthStartingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const checkAppleAvailability = async () => {
      if (Platform.OS !== 'ios') {
        return;
      }
      try {
        const available = await isAppleAuthAvailableAsync();
        if (!cancelled) {
          setAppleAvailable(available);
        }
      } catch {
        if (!cancelled) {
          setAppleAvailable(false);
        }
      }
    };
    void checkAppleAvailability();
    return () => {
      cancelled = true;
    };
  }, []);

  // Both SSO recovery and an address rejected during resend need controls on
  // the main view, rather than leaving their feedback hidden behind OTP entry.
  useEffect(() => {
    if (ssoRecovery || emailError) {
      setView('main');
    }
  }, [emailError, ssoRecovery]);

  // Restore an SSO-recovery banner that survived an RTL language reload.
  useEffect(() => {
    if (initialSsoRecovery) {
      handleSsoError(initialSsoRecovery.email, initialSsoRecovery.ssoOrganizationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot restore on mount
  }, []);

  // Seed the module-level email draft so a restored email survives a second
  // RTL reload (the first reload restores it into the field, but only a
  // change event re-seeds the draft).
  useEffect(() => {
    if (initialEmail) {
      setLoginEmailDraft(initialEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot seed on mount
  }, []);

  // Keep the module-level draft in sync so an RTL reload can persist it.
  useEffect(() => {
    setSsoRecoveryDraft(ssoRecovery);
  }, [ssoRecovery]);

  const handleSendCode = async () => {
    // Empty input is a field-level error: `useNativeAuth` sets the message and
    // never posts an empty address, and FormField renders it under the field so
    // the landing never looks dead. The same call clears a stale message and
    // reports a rejected address (`INVALID_REQUEST` / `INVALID_EMAIL`).
    const ok = await requestEmailCode(emailRef.current);
    if (ok) {
      setView('otp');
    }
  };

  const showApple = Platform.OS === 'ios' && appleAvailable;
  // A build whose dev client has no native passkey module exposes no control:
  // the capability is read synchronously, so the button never pops in.
  const showPasskey = passkeysSupported();
  const showDivider = showApple || googleConfigured || showPasskey;
  const authBusy = busy !== undefined || browserAuthStarting;

  // Report the form's busy state to the login shell so it can disable the
  // language Globe while the OTP form or a busy auth action owns the screen.
  const authFormBusy = view === 'otp' || authBusy;
  useEffect(() => {
    onBusyChange?.(authFormBusy);
  }, [authFormBusy, onBusyChange]);

  const startBrowserAuth = async () => {
    if (browserAuthStartingRef.current) {
      return;
    }
    browserAuthStartingRef.current = true;
    setBrowserAuthStarting(true);
    try {
      await start('signin');
    } finally {
      browserAuthStartingRef.current = false;
      setBrowserAuthStarting(false);
    }
  };

  const startSsoAuth = async (email: string) => {
    if (browserAuthStartingRef.current) {
      return;
    }
    browserAuthStartingRef.current = true;
    setBrowserAuthStarting(true);
    try {
      await start('sso', email);
    } finally {
      browserAuthStartingRef.current = false;
      setBrowserAuthStarting(false);
    }
  };

  if (view === 'otp') {
    return (
      <EmailOtpForm
        email={emailRef.current.trim().toLowerCase()}
        busy={busy}
        onVerify={code => {
          void verifyEmailCode(emailRef.current, code);
        }}
        onResend={() => {
          void (async () => {
            const ok = await requestEmailCode(emailRef.current);
            if (ok) {
              toast.success(t('login.codeSent'));
            }
          })();
        }}
        onBack={() => {
          setView('main');
        }}
      />
    );
  }

  return (
    <View className="gap-3">
      {ssoRecovery && (
        <View className="gap-2 rounded-md border border-border bg-card p-3">
          <Text>{t('login.organizationUsesSso')}</Text>
          <Button
            size="lg"
            className="flex-row gap-2"
            disabled={authBusy}
            loading={browserAuthStarting}
            onPress={() => void startSsoAuth(ssoRecovery.email)}
            accessibilityLabel={t('login.continueWithSso')}
          >
            <Text>{t('login.continueWithSso')}</Text>
          </Button>
          <Button
            variant="ghost"
            disabled={authBusy}
            onPress={() => {
              clearSsoRecovery();
            }}
            accessibilityLabel={t('login.useDifferentEmail')}
          >
            <Text>{t('login.useDifferentEmail')}</Text>
          </Button>
        </View>
      )}

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
          // Same chrome and no-flex-wrap row as the Google and passkey rows
          // below: the label must stay on the icon's line at the shared 44pt
          // floor, so all three provider rows keep one height.
          className="min-h-[44px] w-full flex-row gap-2 rounded-[8px] py-2.5"
          disabled={authBusy}
          onPress={() => {
            void signInWithApple();
          }}
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

      {googleConfigured && (
        <Button
          variant="outline"
          size="lg"
          // min-h (not fixed h) so Dynamic Type can grow the control; keep
          // Apple-parity 44pt floor and full-width rounded chrome. The row is
          // pinned to one line (no flex-wrap) so the Google and passkey buttons
          // keep the same height: a wrapped label made the passkey button a row
          // taller than the Google button above it (2026-09-20 device finding).
          className="min-h-[44px] w-full flex-row gap-2 rounded-[8px] py-2.5"
          disabled={authBusy}
          onPress={() => void signInWithGoogle()}
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
          className={authBusy ? 'opacity-50' : undefined}
          pointerEvents={authBusy ? 'none' : 'auto'}
        >
          <Button
            variant="outline"
            size="lg"
            // min-h (not fixed h) so Dynamic Type can grow the control, matching
            // the Google button's Apple-parity 44pt floor. No flex-wrap: the
            // label must stay on the icon's line, never wrap to its own. The
            // Arabic label ("تسجيل الدخول بمفتاح المرور") wrapped onto two lines
            // and made this button visibly taller than the single-line Google
            // button directly above it; the flex-1 label box gives the copy the
            // whole remaining row width, so the stack keeps one row height.
            className="min-h-[44px] w-full flex-row gap-2 rounded-[8px] py-2.5"
            disabled={authBusy}
            onPress={() => {
              void signInWithPasskey();
            }}
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

      {showDivider && (
        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-border" />
          <Text variant="muted" className="text-xs">
            {t('login.or')}
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      )}

      <FormField
        label={t('login.emailAddress')}
        error={emailError}
        placeholder={t('login.emailPlaceholder')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        // Seed from the live ref, not the mount-time draft: the field remounts
        // when an address error (or SSO recovery) returns the view from OTP, and
        // an uncontrolled field reads `defaultValue` only on mount. Using the
        // ref keeps the rejected address visible under its own error instead of
        // blanking the field while `emailRef` still holds it.
        defaultValue={emailRef.current || undefined}
        // Small-phone IME (Defect B / QB-A1): the IME's Go key must submit
        // the same way the "Continue" button does, instead of only
        // dismissing the keyboard as `actionDone` previously did.
        returnKeyType="go"
        onSubmitEditing={() => {
          if (!authBusy) {
            void handleSendCode();
          }
        }}
        onChangeText={value => {
          emailRef.current = value;
          // Clear the validation message as soon as the user starts fixing it.
          clearEmailError();
          setLoginEmailDraft(value);
        }}
      />
      <Button
        size="lg"
        className="flex-row gap-2"
        disabled={authBusy}
        loading={busy === 'otp-send'}
        onPress={() => void handleSendCode()}
        accessibilityLabel={t('login.continueWithEmail')}
      >
        <Text>{t('common.continue')}</Text>
      </Button>
      <View className={cn('flex-row flex-wrap items-center justify-center', INLINE_LINK_ROW_CLASS)}>
        {/* The sentence is a row of nodes, not one Text with nested handlers: an
            inline link's own box is what the control-size audit measures, so
            each link carries the shared inline-link box and its own per-side
            reach — 4dp toward the connector, 12dp away — which still adds to
            44pt from the 28dp floor. The box adds no height to the line (its
            28dp floor is cancelled by the shared layout-neutral form), so the
            only gaps between the words are the sentence's own spaces, and the
            connector's min-width keeps both 4dp facing reaches apart in a
            catalog with a short conjunction. The links' 44pt vertical reach
            needs `(28 - 14) / 2 + 8 = 15dp` of free space above and below the
            `text-xs` line, which the screen's `gap-3` gutter (10.5dp) cannot
            give it, so the row carries the extra 5dp margin: both regions then
            stay clear of the Continue button above and the ghost button
            below. */}

        <Text className="text-xs text-muted-foreground">{t('login.termsPrefix')} </Text>
        <Pressable
          className={INLINE_LINK_BOX_CLASS}
          hitSlop={inlineLinkHitSlop('start')}
          accessibilityRole="link"
          accessibilityLabel={t('login.terms')}
          onPress={() => void WebBrowser.openBrowserAsync(TERMS_URL)}
        >
          <Text className="text-xs text-primary underline">{t('login.terms')}</Text>
        </Pressable>
        <Text className={cn('text-xs text-muted-foreground', INLINE_LINK_CONNECTOR_CLASS)}>
          {t('login.termsConnector')}
        </Text>
        <Pressable
          className={INLINE_LINK_BOX_CLASS}
          hitSlop={inlineLinkHitSlop('end')}
          accessibilityRole="link"
          accessibilityLabel={t('common.privacyPolicy')}
          onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}
        >
          <Text className="text-xs text-primary underline">{t('common.privacyPolicy')}</Text>
        </Pressable>
        <Text className="text-xs text-muted-foreground">{t('login.termsSuffix')}</Text>
      </View>
      <Button
        // A text action that opens the browser sign-in options. It wears the
        // same underlined primary link treatment as the Terms and Privacy
        // Policy links above, so it reads as tappable rather than as plain bold
        // text with no affordance.
        variant="link"
        className="active:opacity-60"
        disabled={authBusy}
        onPress={() => {
          void startBrowserAuth();
        }}
        accessibilityLabel={t('login.moreSignInOptions')}
      >
        <Text className="underline">{t('login.moreSignInOptions')}</Text>
      </Button>
    </View>
  );
}
