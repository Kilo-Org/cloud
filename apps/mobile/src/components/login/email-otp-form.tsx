import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { ICON_TARGET_DP } from '@/lib/a11y/tap-target';
import { type BusyAction } from '@/lib/auth/use-native-auth';
import { foldDecimalDigits } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { canSubmitEmailCode } from './email-otp-state';

/**
 * Marks where the address sits inside the translated sentence. The catalog
 * message is never rewritten: the address is substituted for this slot and
 * placed on a line of its own, so a long address starts a fresh line instead of
 * breaking mid-word (the reported `.com` orphan). A destination above the
 * display bound is abbreviated in the middle.
 */
const ADDRESS_SLOT = '\u0000';

/** Above this, the destination abbreviates in the middle to keep the code controls visible. */
const DESTINATION_MAX_CHARS = 48;
const DESTINATION_PREFIX_CHARS = 24;
const DESTINATION_SUFFIX_CHARS = 23;

/**
 * Puts the address on its own line without assuming the translation's word
 * order. Punctuation or a particle written directly after the slot stays on the
 * address line (Arabic `{{email}}.`); a space-separated phrase starts the next
 * line. Each line break replaces the space it separates, never adds one beside
 * it: a break inserted before the space left the wrapped line indented by a
 * visible space (Hindi `…\n पर भेजा गया…`). Removing the breaks and restoring
 * one space for each reproduces the catalog message exactly, so the sentence
 * keeps its own punctuation attached.
 */
function formatCodeDestination(message: string, email: string): string {
  const [before = '', after = ''] = message.split(ADDRESS_SLOT);
  const lead = before ? `${before.trimEnd()}\n` : '';
  const trail = after.startsWith(' ') ? `\n${after.slice(1)}` : after;
  const destination =
    email.length > DESTINATION_MAX_CHARS
      ? `${email.slice(0, DESTINATION_PREFIX_CHARS)}…${email.slice(-DESTINATION_SUFFIX_CHARS)}`
      : email;
  return `${lead}${destination}${trail}`;
}

export function EmailOtpForm({
  email,
  busy,
  error,
  onVerify,
  onCodeChange,
  onResend,
  onBack,
  recovery,
  onAlternativeSignIn,
  alternativeSignInStarting = false,
  onBelowFieldHeightChange,
}: Readonly<{
  email: string;
  busy: BusyAction;
  /** A verify refusal in the active language, rendered above the verify button. */
  error?: string;
  onVerify: (code: string) => void;
  /** Fires on every code-input change so the caller can retire a stale refusal message. */
  onCodeChange?: () => void;
  /**
   * Requests a new code and reports whether the server accepted the request, so
   * the field can empty the code it has just replaced. The old code stays
   * visible when the request fails: it may still be the code that works.
   */
  onResend: () => Promise<boolean>;
  onBack: () => void;
  /** A refusal no further code can clear: the step offers the other sign-in methods its message names. */
  recovery?: 'options';
  /** Starts the other sign-in methods. The control renders from `recovery`, so a missing handler only disables its press. */
  onAlternativeSignIn?: () => void;
  /** An alternative sign-in already started, so every action stays disabled. */
  alternativeSignInStarting?: boolean;
  /**
   * Reports the height of everything below the code field, so the login shell
   * can keep that much of the form clear of the keyboard. A refusal can wrap,
   * so the height is measured instead of assumed.
   */
  onBelowFieldHeightChange?: (height: number) => void;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const codeRef = useRef('');
  const inputRef = useRef<TextInput>(null);
  const [hasCompleteCode, setHasCompleteCode] = useState(false);
  /**
   * The keystroke count a resend started at. A keystroke or a second resend
   * moves it on, so only the resend this count still belongs to empties the
   * field: a code typed while the request was in flight is not thrown away.
   */
  const resendAttemptRef = useRef(0);
  const authBusy = busy !== undefined || alternativeSignInStarting;
  const destination = formatCodeDestination(
    t('login.enterCodeSentTo', { email: ADDRESS_SLOT }),
    email
  );

  return (
    // Keyboard avoidance is owned by the login shell in login-screen.tsx.
    <View className="gap-3">
      <Text variant="muted" className="text-center">
        {destination}
      </Text>
      <Text variant="caption" className="text-center">
        {t('login.codeArrivalHint')}
      </Text>
      <Input
        ref={inputRef}
        // The shared box supplies the single line inset (`INPUT_BOX_SHAPE_CLASS`,
        // min-h-44 and the horizontal padding); the call site keeps its chrome —
        // border, fill and radius — the way every single-line field does. The
        // field's 48pt floor comes from the tap-target 48 constant the controls
        // beside it use, as an inline minimum rather than a row's target class:
        // it is a min-height, never a fixed height, so Dynamic Type still grows
        // the box.
        className="rounded-md border border-input bg-background text-lg tracking-widest text-foreground"
        // textAlign is applied inline, not via a `text-center` class: NativeWind maps
        // textAlign to a native prop for TextInput and crashes on it in this version.
        // eslint-disable-next-line react-native/no-inline-styles -- see comment above
        style={{ textAlign: 'center', minHeight: ICON_TARGET_DP }}
        placeholder="123456"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        onChangeText={value => {
          // The field keeps what was typed, but validation and the code sent to
          // the server work on ASCII: the sign-in code is issued in ASCII, and a
          // keyboard in another script types the same code in its own digits.
          const digits = foldDecimalDigits(value);
          // Typing is what a pending resend must respect: the field now holds a
          // code that resend's reply did not replace.
          resendAttemptRef.current += 1;
          codeRef.current = digits;
          setHasCompleteCode(/^\d{6}$/.test(digits));
          onCodeChange?.();
        }}
        accessibilityLabel={formFieldA11y({ label: t('login.signInCodeField'), required: true })}
      />
      {/* Everything the keyboard can cover below the field, as one measured
          block in the order the user reads it: the refusal, the action it
          belongs to, the resend that replaces the code, and — only while a
          refusal a code cannot clear stands — the other sign-in methods its
          copy names. A refusal wraps in some catalogs, so the shell reads this
          block's measured height instead of assuming the actions sit one row
          below the field. */}
      <View
        className="gap-3"
        onLayout={event => {
          onBelowFieldHeightChange?.(event.nativeEvent.layout.height);
        }}
      >
        {error ? (
          <Text
            variant="muted"
            className="text-center text-destructive"
            accessibilityLiveRegion="polite"
          >
            {error}
          </Text>
        ) : null}
        <Button
          size="lg"
          disabled={!hasCompleteCode || authBusy}
          loading={busy === 'otp-verify'}
          onPress={() => {
            if (canSubmitEmailCode(codeRef.current, busy)) {
              onVerify(codeRef.current);
            }
          }}
          accessibilityLabel={t('login.verifyCode')}
        >
          <Text className="flex-1 text-center" numberOfLines={1} adjustsFontSizeToFit>
            {t('login.verifyCode')}
          </Text>
        </Button>
        <Button
          variant="outline"
          disabled={authBusy}
          loading={busy === 'otp-send'}
          onPress={() => {
            const attempt = (resendAttemptRef.current += 1);
            void (async () => {
              const sent = await onResend();
              // Only a request the field still owns may empty it: a code typed (or
              // a second resend started) while this one ran stays as it is.
              if (!sent || attempt !== resendAttemptRef.current) {
                return;
              }
              // The field is uncontrolled (iOS text input rules), so the native
              // box is emptied through the ref: the resend replaces the code, and
              // the old one left in place read as if the new one had arrived.
              inputRef.current?.clear();
              codeRef.current = '';
              setHasCompleteCode(false);
            })();
          }}
          accessibilityLabel={t('login.resendCode')}
        >
          {/* One line, like every other label in this stack: the Arabic secondary
              label ("إعادة إرسال الرمز") wrapped onto two lines inside the
              full-width button, so the copy did not fit its control (2026-09-19
              device finding). The label shrinks to fit that one line and then
              ellipsizes instead of growing a second row; the full label stays the
              control's accessible name. */}
          <Text className="flex-1 text-center" numberOfLines={1} adjustsFontSizeToFit>
            {t('login.resendCode')}
          </Text>
        </Button>
        {recovery === 'options' ? (
          // The refusal's copy names this control, so it renders from the data
          // tag beside the message: a full-size action, one line like the others.
          <Button
            variant="outline"
            size="lg"
            disabled={authBusy}
            loading={alternativeSignInStarting}
            onPress={onAlternativeSignIn}
            accessibilityLabel={t('login.moreSignInOptions')}
          >
            <Text className="flex-1 text-center" numberOfLines={1} adjustsFontSizeToFit>
              {t('login.moreSignInOptions')}
            </Text>
          </Button>
        ) : null}
      </View>
      <Button
        variant="ghost"
        disabled={authBusy}
        onPress={onBack}
        accessibilityLabel={t('common.back')}
      >
        <Text>{t('common.back')}</Text>
      </Button>
    </View>
  );
}
