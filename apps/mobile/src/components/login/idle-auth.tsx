/* eslint-disable max-lines -- the idle login screen owns every provider control, the SSO recovery block, the pending-link switch, and the email/OTP switch in one surface */
import { isAvailableAsync as isAppleAuthAvailableAsync } from 'expo-apple-authentication';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';
import * as WebBrowser from 'expo-web-browser';

import { EmailOtpForm } from '@/components/login/email-otp-form';
import { PendingLinkAuth } from '@/components/login/pending-link-auth';
import { ProviderButtons } from '@/components/login/provider-buttons';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_ROW_CLASS,
  inlineLinkHitSlop,
} from '@/lib/a11y/tap-target';
import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';
import { pendingLinkOptions } from '@/lib/auth/pending-link';
import { useNativeAuth } from '@/lib/auth/use-native-auth';
import { passkeysSupported } from '@/lib/auth/passkey-client';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';
import { setLoginEmailDraft, setSsoRecoveryDraft, type SsoRecoveryDraft } from '@/lib/login-draft';
import { cn } from '@/lib/utils';

/** The two links the legal sentence exposes as custom accessibility actions. */
const LEGAL_LINK_ACTIONS = [
  { name: 'openTerms', labelKey: 'login.terms', url: TERMS_URL },
  { name: 'openPrivacy', labelKey: 'common.privacyPolicy', url: PRIVACY_URL },
] as const;

export function IdleAuth({
  start,
  initialEmail = '',
  initialSsoRecovery = null,
  onBusyChange,
  onSignInStart,
  pendingLink = null,
  pendingLinkRefused = false,
  onPendingLink,
  onClearPendingLink,
  onBelowFieldHeightChange,
}: Readonly<{
  start: (mode: 'signin' | 'sso', ssoEmail?: string, pendingLinkToken?: string) => Promise<void>;
  initialEmail?: string;
  initialSsoRecovery?: SsoRecoveryDraft | null;
  onBusyChange?: (busy: boolean) => void;
  /** Fires as a user-initiated sign-in attempt begins, before any request, so
   *  the shell can dismiss a stale error from the previous attempt. */
  onSignInStart?: () => void;
  /** The pending link being resolved. The shell owns it so a browser attempt cannot lose it. */
  pendingLink?: PendingLinkOffer | null;
  /** The browser sign-in route refused `pendingLink` as no longer live. */
  pendingLinkRefused?: boolean;
  /** Without it a `DIFFERENT-OAUTH` refusal stays a toast, as before pending links existed. */
  onPendingLink?: (offer: PendingLinkOffer) => void;
  onClearPendingLink?: () => void;
  /** Reports what the code step renders below its field, for the shell's keyboard reserve. */
  onBelowFieldHeightChange?: (height: number) => void;
}>) {
  const {
    busy,
    emailErrorKey,
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
    pendingLinkFailure,
    clearPendingLinkFailure,
  } = useNativeAuth(
    onPendingLink
      ? {
          pendingLink,
          onPendingLinkOffer: onPendingLink,
          onPendingLinkResolved: () => onClearPendingLink?.(),
        }
      : undefined
  );
  const { t } = useTranslation();
  // The wrapper's label: the translated parts joined the way the row renders
  // them, so the catalog owns every space in the sentence. `termsPrefix` ends
  // with whatever separator the locale puts before the Terms link — a space
  // where words are space-separated, nothing in Chinese — `termsConnector`
  // carries the conjunction with its own spacing, and the suffix is the
  // sentence's final punctuation. The link inside the sentence reads
  // `termsInSentence`, the form the locale's consent verb governs, while
  // `login.terms` is the noun phrase the link announces on its own.
  const legalSentence =
    `${t('login.termsPrefix')}${t('login.termsInSentence')}${t('login.termsConnector')}` +
    `${t('common.privacyPolicy')}${t('login.termsSuffix')}`;
  const [view, setView] = useState<'main' | 'otp'>('main');
  const [verifyError, setVerifyError] = useState<string | undefined>(undefined);
  // Bumps on every user step that retires a refusal (edit, resend, back), so a
  // slow refusal from an earlier attempt cannot re-appear after the user moved on.
  const verifyAttemptRef = useRef(0);
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
    if (ssoRecovery || emailErrorKey) {
      setView('main');
    }
  }, [emailErrorKey, ssoRecovery]);

  // A newly offered pending link takes over the screen, even from the code step
  // whose verification produced it.
  const pendingLinkToken = pendingLink?.token;
  useEffect(() => {
    if (pendingLinkToken) {
      verifyAttemptRef.current += 1;
      setVerifyError(undefined);
      setView('main');
    }
  }, [pendingLinkToken]);

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

  const handleSendCode = async (email: string) => {
    onSignInStart?.();
    // Empty input is a field-level error: `useNativeAuth` sets the message and
    // never posts an empty address, and FormField renders it under the field so
    // the landing never looks dead. The same call clears a stale message and
    // reports a rejected address (`INVALID_REQUEST` / `INVALID_EMAIL`).
    const ok = await requestEmailCode(email);
    if (ok) {
      verifyAttemptRef.current += 1;
      setVerifyError(undefined);
      setView('otp');
    }
  };

  const showApple = Platform.OS === 'ios' && appleAvailable;
  // A build whose dev client has no native passkey module exposes no control:
  // the capability is read synchronously, so the button never pops in.
  const showPasskey = passkeysSupported();
  const showDivider = showApple || googleConfigured || showPasskey;
  const authBusy = busy !== undefined || browserAuthStarting;
  // The code step for a pending link goes to the existing account's address, not the typed one.
  const otpEmail = pendingLink ? pendingLink.email : emailRef.current;

  // Report the form's busy state to the login shell so it can disable the
  // language Globe while the OTP form, the pending-link screen, or a busy auth
  // action owns the screen: the language reload would drop that state.
  const authFormBusy = view === 'otp' || authBusy || pendingLink !== null;
  useEffect(() => {
    onBusyChange?.(authFormBusy);
  }, [authFormBusy, onBusyChange]);

  const startBrowserAuth = async () => {
    if (browserAuthStartingRef.current) {
      return;
    }
    browserAuthStartingRef.current = true;
    setBrowserAuthStarting(true);
    onSignInStart?.();
    try {
      await start('signin', undefined, pendingLink?.token);
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
    onSignInStart?.();
    try {
      await start('sso', email, pendingLink?.token);
    } finally {
      browserAuthStartingRef.current = false;
      setBrowserAuthStarting(false);
    }
  };

  if (view === 'otp') {
    return (
      <EmailOtpForm
        email={otpEmail.trim().toLowerCase()}
        busy={busy}
        // A resend that fails has no field to sit under here, and the pending-link options are off
        // screen, so the code step shows that refusal in its own slot. Without a pending link the
        // hook toasts it instead and this stays the verify message alone.
        error={verifyError ?? pendingLinkFailure?.message}
        onVerify={code => {
          const attempt = verifyAttemptRef.current;
          void (async () => {
            const outcome = await verifyEmailCode(otpEmail, code);
            // A refusal may settle after the user has moved on — edited the
            // code (clearing the message), requested a resend, or gone back.
            // Only the attempt this refusal belongs to may write its message.
            if (!outcome.ok && attempt === verifyAttemptRef.current) {
              setVerifyError(outcome.message);
            }
          })();
        }}
        onCodeChange={() => {
          // Editing the code retires the refusal message above the field and
          // disowns any verify attempt still in flight for the old code.
          verifyAttemptRef.current += 1;
          setVerifyError(undefined);
          clearPendingLinkFailure();
        }}
        onResend={() => {
          verifyAttemptRef.current += 1;
          setVerifyError(undefined);
          clearPendingLinkFailure();
          void (async () => {
            const ok = await requestEmailCode(otpEmail);
            if (ok) {
              toast.success(t('login.codeSent'));
            }
          })();
        }}
        onBack={() => {
          verifyAttemptRef.current += 1;
          setVerifyError(undefined);
          clearPendingLinkFailure();
          setView('main');
        }}
        onBelowFieldHeightChange={onBelowFieldHeightChange}
      />
    );
  }

  const ssoBlock = ssoRecovery && (
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
  );

  const providerHandlers = {
    onApple: () => {
      onSignInStart?.();
      void signInWithApple();
    },
    onGoogle: () => {
      onSignInStart?.();
      void signInWithGoogle();
    },
    onPasskey: () => {
      onSignInStart?.();
      void signInWithPasskey();
    },
  };

  if (pendingLink) {
    return (
      <View className="gap-3">
        {ssoBlock}
        <PendingLinkAuth
          key={pendingLink.token}
          offer={pendingLink}
          options={pendingLinkOptions(pendingLink, {
            apple: showApple,
            google: googleConfigured,
            passkey: showPasskey,
          })}
          busy={busy}
          browserStarting={browserAuthStarting}
          refused={pendingLinkRefused}
          // An address the code route rejects has no field here, so it reads beside the options.
          failure={
            pendingLinkFailure ??
            (emailErrorKey ? { message: t(emailErrorKey), retryable: true } : undefined)
          }
          {...providerHandlers}
          onEmailCode={() => void handleSendCode(pendingLink.email)}
          onBrowser={() => void startBrowserAuth()}
          onStartAgain={() => onClearPendingLink?.()}
        />
      </View>
    );
  }

  return (
    <View className="gap-3">
      {ssoBlock}

      <ProviderButtons
        showApple={showApple}
        showGoogle={googleConfigured}
        showPasskey={showPasskey}
        busy={busy}
        disabled={authBusy}
        {...providerHandlers}
      />

      {showDivider && (
        // The border token is 7% white in dark, a hairline that all but
        // vanishes on the near-black background; the outline button carries
        // neutral-700 for the same reason, so the rule keeps the weight it has
        // in the light scheme.
        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-border dark:bg-neutral-700" />
          <Text variant="muted" className="text-xs">
            {t('login.or')}
          </Text>
          <View className="h-px flex-1 bg-border dark:bg-neutral-700" />
        </View>
      )}

      <FormField
        label={t('login.emailAddress')}
        // The hook stores a catalog key, not a message: translating here keeps
        // the inline error in the active language after the picker switches it.
        error={emailErrorKey ? t(emailErrorKey) : undefined}
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
            void handleSendCode(emailRef.current);
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
        onPress={() => void handleSendCode(emailRef.current)}
        accessibilityLabel={t('login.continueWithEmail')}
      >
        {/* The primary action's label takes the provider rows' 17pt label size;
            at the button variant's 14pt the filled Continue read weaker than
            the two outlined ways in below it. The variant keeps the weight
            (`font-semibold`) and the brand fill. */}
        <Text className="text-[17px]">{t('common.continue')}</Text>
      </Button>
      {/* The sentence is one accessible element: Android's screen reader does
            not keep the row's visual order once the line wraps (in pt-BR the
            tree read the Privacy link before Terms), so the wrapper carries the
            whole visible-order sentence as its label and exposes each link as a
            custom accessibility action. The children keep their classes and
            hit slops — the row's layout and the links' 44pt touch targets are
            unchanged — and `no-hide-descendants` (plus
            `accessibilityElementsHidden` for iOS) removes the flattened links
            from the tree, leaving the wrapper the only focusable node. */}
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={legalSentence}
        accessibilityActions={LEGAL_LINK_ACTIONS.map(action => ({
          name: action.name,
          label: t(action.labelKey),
        }))}
        onAccessibilityAction={event => {
          const action = LEGAL_LINK_ACTIONS.find(
            item => item.name === event.nativeEvent.actionName
          );
          if (action) {
            void WebBrowser.openBrowserAsync(action.url);
          }
        }}
        className={cn('flex-row flex-wrap items-center justify-center', INLINE_LINK_ROW_CLASS)}
      >
        {/* The sentence is a row of nodes, not one Text with nested handlers: an
            inline link's own box is what the control-size audit measures, so
            each link carries the shared inline-link box and its own per-side
            reach — 4dp toward the connector, 12dp away — which still adds to
            44pt from the 28dp floor. The box adds no height to the line (its
            28dp floor is cancelled by the shared layout-neutral form), so the
            only gaps between the words are the sentence's own spaces, and the
            connector's min-width keeps both 4dp facing reaches apart in a
            catalog with a short conjunction. The 12.25dp `text-sm` copy is
            DESIGN.md's label step: the smaller `text-xs` sat below every other
            line on the screen and its 8dp wrapped-line gap left the two lines
            of the sentence reading as separate items. The row's 5dp margin
            still holds the links' vertical reach clear of the buttons above and
            below. A long locale wraps the sentence, so the row also keeps the
            shared wrapped-line gap (`INLINE_LINK_LINE_GAP_CLASS`); a sentence
            that fits one line never sees it. */}

        <Text
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className="text-sm text-muted-foreground"
        >
          {t('login.termsPrefix')}
        </Text>
        <Pressable
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className={INLINE_LINK_BOX_CLASS}
          hitSlop={inlineLinkHitSlop('start')}
          accessibilityRole="link"
          accessibilityLabel={t('login.termsInSentence')}
          onPress={() => void WebBrowser.openBrowserAsync(TERMS_URL)}
        >
          <Text className="text-sm text-primary underline">{t('login.termsInSentence')}</Text>
        </Pressable>
        <Text
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className={cn('text-sm text-muted-foreground', INLINE_LINK_CONNECTOR_CLASS)}
        >
          {t('login.termsConnector')}
        </Text>
        <Pressable
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className={INLINE_LINK_BOX_CLASS}
          hitSlop={inlineLinkHitSlop('end')}
          accessibilityRole="link"
          accessibilityLabel={t('common.privacyPolicy')}
          onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}
        >
          <Text className="text-sm text-primary underline">{t('common.privacyPolicy')}</Text>
        </Pressable>
        <Text
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className="text-sm text-muted-foreground"
        >
          {t('login.termsSuffix')}
        </Text>
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
