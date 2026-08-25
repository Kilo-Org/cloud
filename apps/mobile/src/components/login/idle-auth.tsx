import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
  isAvailableAsync as isAppleAuthAvailableAsync,
} from 'expo-apple-authentication';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Platform, useColorScheme, View } from 'react-native';
import { toast } from 'sonner-native';
import * as WebBrowser from 'expo-web-browser';

import { EmailOtpForm } from '@/components/login/email-otp-form';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { useNativeAuth } from '@/lib/auth/use-native-auth';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';
import { setLoginEmailDraft, setSsoRecoveryDraft, type SsoRecoveryDraft } from '@/lib/login-draft';

export function IdleAuth({
  start,
  initialEmail = '',
  initialSsoRecovery = null,
  onBusyChange,
}: Readonly<{
  start: (mode: 'signin' | 'signup' | 'sso', ssoEmail?: string) => Promise<void>;
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
    const ok = await requestEmailCode(emailRef.current);
    if (ok) {
      setView('otp');
    }
  };

  const showApple = Platform.OS === 'ios' && appleAvailable;
  const showDivider = showApple || googleConfigured;
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
          // Apple-parity 44pt floor and full-width rounded chrome.
          className="min-h-[44px] w-full flex-row flex-wrap gap-2 rounded-[8px] py-2.5"
          disabled={authBusy}
          onPress={() => void signInWithGoogle()}
          accessibilityLabel={t('login.signInWithGoogle')}
        >
          {busy === 'google' ? <ActivityIndicator size="small" /> : <GoogleLogo size={18} />}
          <Text className="shrink text-center text-[17px] font-medium">
            {t('login.signInWithGoogle')}
          </Text>
        </Button>
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
        <Text>{t('login.continue')}</Text>
      </Button>
      <Text className="text-xs text-muted-foreground">
        {t('login.termsPrefix')}{' '}
        <Text
          className="text-xs text-primary underline"
          onPress={() => void WebBrowser.openBrowserAsync(TERMS_URL)}
        >
          {t('login.terms')}
        </Text>
        {t('login.termsConnector')}
        <Text
          className="text-xs text-primary underline"
          onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}
        >
          {t('login.privacyPolicy')}
        </Text>
        {t('login.termsSuffix')}
      </Text>
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
