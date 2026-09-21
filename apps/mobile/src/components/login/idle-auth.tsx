/* eslint-disable max-lines -- the idle login screen owns every provider control, the SSO recovery block, and the email/OTP switch in one surface */
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
  isAvailableAsync as isAppleAuthAvailableAsync,
} from 'expo-apple-authentication';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, useColorScheme, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { toast } from 'sonner-native';
import * as WebBrowser from 'expo-web-browser';

import { EmailOtpForm } from '@/components/login/email-otp-form';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_HIT_SLOP_DP,
} from '@/lib/a11y/tap-target';
import { useNativeAuth } from '@/lib/auth/use-native-auth';
import { passkeysSupported } from '@/lib/auth/passkey-client';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';
import { setLoginEmailDraft, setSsoRecoveryDraft, type SsoRecoveryDraft } from '@/lib/login-draft';
import { cn } from '@/lib/utils';

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
  const colorScheme = useColorScheme();
  const {
    busy,
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
  const [view, setView] = useState<'main' | 'otp'>('main');
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [browserAuthStarting, setBrowserAuthStarting] = useState(false);
  const emailRef = useRef(initialEmail);
  const browserAuthStartingRef = useRef(false);
  // Field-level validation message for the email input. Rendered under the
  // field through FormField's `error` slot (AccessibleStatus announces it and
  // keeps it on screen) instead of a toast, which is not part of the
  // accessibility hierarchy.
  const [emailError, setEmailError] = useState<string | null>(null);

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

  // A verify-step SSO_ERROR sets ssoRecovery while the user is on the OTP view,
  // which hides the recovery block. Return to the main view so the block (and
  // its "Continue with SSO" control) becomes visible.
  useEffect(() => {
    if (ssoRecovery) {
      setView('main');
    }
  }, [ssoRecovery]);

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
    if (!emailRef.current.trim()) {
      // Empty input is a field-level error: show it under the field so the
      // landing never looks dead, and never post an empty address.
      setEmailError(t('login.pleaseEnterEmail'));
      return;
    }
    setEmailError(null);
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
            onPress={() => void startSsoAuth(ssoRecovery.email)}
            accessibilityLabel={t('login.continueWithSso')}
          >
            {browserAuthStarting ? <ActivityIndicator size="small" /> : null}
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
        <View
          className={authBusy ? 'opacity-50' : undefined}
          pointerEvents={authBusy ? 'none' : 'auto'}
        >
          <AppleAuthenticationButton
            buttonType={AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={
              colorScheme === 'dark'
                ? AppleAuthenticationButtonStyle.WHITE
                : AppleAuthenticationButtonStyle.BLACK
            }
            cornerRadius={8}
            // eslint-disable-next-line react-native/no-inline-styles -- AppleAuthenticationButton isn't NativeWind-aware; height/width must be set via style, not className
            style={{ height: 44, width: '100%' }}
            onPress={() => {
              if (!authBusy) {
                void signInWithApple();
              }
            }}
            accessibilityLabel={t('login.signInWithApple')}
          />
        </View>
      )}

      {googleConfigured && (
        <Button
          variant="outline"
          size="lg"
          // min-h (not fixed h) so Dynamic Type can grow the control; keep
          // Apple-parity 44pt floor and full-width rounded chrome. No
          // `flex-wrap`: a catalog whose label is longer than the row (Arabic
          // at a small width) wrapped the label onto its own lines with the
          // logo stranded above them, turning the button into a card. The
          // single-line label shrinks and ellipsizes instead.
          className="min-h-[44px] w-full flex-row gap-2 rounded-[8px] py-2.5"
          disabled={authBusy}
          onPress={() => void signInWithGoogle()}
          accessibilityLabel={t('login.signInWithGoogle')}
        >
          {busy === 'google' ? <ActivityIndicator size="small" /> : <GoogleLogo size={18} />}
          <Text className="shrink text-center text-[17px] font-medium" numberOfLines={1}>
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
            // the Google button's Apple-parity 44pt floor. Single line, like the
            // Google button: a wrapped label must not turn the control into a
            // stacked card.
            className="min-h-[44px] w-full flex-row gap-2 rounded-[8px] py-2.5"
            disabled={authBusy}
            onPress={() => {
              void signInWithPasskey();
            }}
            accessibilityLabel={t('login.signInWithPasskey')}
          >
            {busy === 'passkey' ? <ActivityIndicator size="small" /> : null}
            <Text className="shrink text-center text-[17px] font-medium" numberOfLines={1}>
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
        placeholder={t('login.emailPlaceholder')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        defaultValue={initialEmail || undefined}
        error={emailError ?? undefined}
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
          setLoginEmailDraft(value);
          // Clear the validation message as soon as the user starts fixing it.
          if (emailError !== null) {
            setEmailError(null);
          }
        }}
      />
      <Button
        size="lg"
        className="flex-row gap-2"
        disabled={authBusy}
        onPress={() => void handleSendCode()}
        accessibilityLabel={t('login.continueWithEmail')}
      >
        {busy === 'otp-send' ? <ActivityIndicator size="small" /> : null}
        <Text>{t('common.continue')}</Text>
      </Button>
      <View className="flex-row flex-wrap items-center justify-center">
        {/* The sentence is a row of nodes, not one Text with nested handlers: an
            inline link's own box is what the control-size audit measures, so
            each link carries the shared inline-link box and its own reach. The
            connector between them reserves at least both facing slops, so the
            two touch regions never overlap in a catalog with a short
            conjunction. */}
        <Text className="text-xs text-muted-foreground">{t('login.termsPrefix')} </Text>
        <Pressable
          className={cn(INLINE_LINK_BOX_CLASS, 'px-1')}
          hitSlop={INLINE_LINK_HIT_SLOP_DP}
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
          className={cn(INLINE_LINK_BOX_CLASS, 'px-1')}
          hitSlop={INLINE_LINK_HIT_SLOP_DP}
          accessibilityRole="link"
          accessibilityLabel={t('common.privacyPolicy')}
          onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}
        >
          <Text className="text-xs text-primary underline">{t('common.privacyPolicy')}</Text>
        </Pressable>
        <Text className="text-xs text-muted-foreground">{t('login.termsSuffix')}</Text>
      </View>
      <Button
        variant="ghost"
        disabled={authBusy}
        onPress={() => {
          void startBrowserAuth();
        }}
        accessibilityLabel={t('login.moreSignInOptions')}
      >
        <Text>{t('login.moreSignInOptions')}</Text>
      </Button>
    </View>
  );
}
