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
const PROVIDER_ROW_CLASS =
  'relative min-h-[44px] w-full flex-row justify-center rounded-[8px] px-[34px] py-2.5';

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
}: Readonly<{
  start: (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;
  initialEmail?: string;
  initialSsoRecovery?: SsoRecoveryDraft | null;
  onBusyChange?: (busy: boolean) => void;
  /** Fires as a user-initiated sign-in attempt begins, before any request, so
   *  the shell can dismiss a stale error from the previous attempt. */
  onSignInStart?: () => void;
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
  } = useNativeAuth();
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The wrapper's label: the translated parts joined the way the row renders
  // them, so the catalog owns every space in the sentence. `termsPrefix` ends
  // with whatever separator the locale puts before the Terms link — a space
  // where words are space-separated, nothing in Chinese — `termsConnector`
  // carries the conjunction with its own spacing, and the suffix is the
  // sentence's final punctuation.
  const legalSentence =
    `${t('login.termsPrefix')}${t('login.terms')}${t('login.termsConnector')}` +
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
    onSignInStart?.();
    // Empty input is a field-level error: `useNativeAuth` sets the message and
    // never posts an empty address, and FormField renders it under the field so
    // the landing never looks dead. The same call clears a stale message and
    // reports a rejected address (`INVALID_REQUEST` / `INVALID_EMAIL`).
    const ok = await requestEmailCode(emailRef.current);
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
    onSignInStart?.();
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
    onSignInStart?.();
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
        error={verifyError}
        onVerify={code => {
          const attempt = verifyAttemptRef.current;
          void (async () => {
            const outcome = await verifyEmailCode(emailRef.current, code);
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
        }}
        onResend={() => {
          verifyAttemptRef.current += 1;
          setVerifyError(undefined);
          void (async () => {
            const ok = await requestEmailCode(emailRef.current);
            if (ok) {
              toast.success(t('login.codeSent'));
            }
          })();
        }}
        onBack={() => {
          verifyAttemptRef.current += 1;
          setVerifyError(undefined);
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
          // Same chrome and label axis as the Google and passkey rows below:
          // the mark is out of flow at the leading edge, so the label centers
          // on the button's own width at the shared 44pt floor and all three
          // provider rows keep one height.
          className={PROVIDER_ROW_CLASS}
          disabled={authBusy}
          onPress={() => {
            onSignInStart?.();
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
          // The label takes the whole content width, so it centers on the
          // button rather than on the space the mark leaves over.
          className={PROVIDER_ROW_CLASS}
          disabled={authBusy}
          onPress={() => {
            onSignInStart?.();
            void signInWithGoogle();
          }}
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
            // the Google button's Apple-parity 44pt floor. The flex-1 label box
            // gives the copy the whole content width and centers it on the
            // button, but a label wider than that box still wraps and makes this
            // row taller than the Google row above it (the Arabic label once
            // did). The row therefore stays one line only while every catalog's
            // `login.signInWithPasskey` fits the compact 360dp content width
            // (248dp at the 17pt label size); the 14 locales whose label was
            // wider are phrased short for that reason, not for style.
            className={PROVIDER_ROW_CLASS}
            disabled={authBusy}
            onPress={() => {
              onSignInStart?.();
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
          accessibilityLabel={t('login.terms')}
          onPress={() => void WebBrowser.openBrowserAsync(TERMS_URL)}
        >
          <Text className="text-sm text-primary underline">{t('login.terms')}</Text>
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
