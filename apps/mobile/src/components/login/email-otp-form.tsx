import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { Button } from '@/components/ui/button';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { Text } from '@/components/ui/text';
import { type useNativeAuth } from '@/lib/auth/use-native-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { canSubmitEmailCode } from './email-otp-state';

/**
 * Marks where the address sits inside the translated sentence. The catalog
 * message is never rewritten: the address is substituted for this slot and
 * placed on a line of its own, so a long address starts a fresh line and cannot
 * be broken mid-word (the reported `.com` orphan).
 */
const ADDRESS_SLOT = '\u0000';

/**
 * Puts the address on its own line without assuming the translation's word
 * order. Punctuation or a particle written directly after the slot stays on the
 * address line (Arabic `{{email}}.`); a space-separated phrase starts the next
 * line. Removing the inserted line breaks reproduces the catalog message
 * exactly, so the sentence keeps its own punctuation attached.
 */
function formatCodeDestination(message: string, email: string): string {
  const [before = '', after = ''] = message.split(ADDRESS_SLOT);
  const lead = before ? `${before}\n` : '';
  const trail = after.startsWith(' ') ? `\n${after}` : after;
  return `${lead}${email}${trail}`;
}

export function EmailOtpForm({
  email,
  busy,
  onVerify,
  onResend,
  onBack,
}: Readonly<{
  email: string;
  busy: ReturnType<typeof useNativeAuth>['busy'];
  onVerify: (code: string) => void;
  onResend: () => void;
  onBack: () => void;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const codeRef = useRef('');
  const [hasCompleteCode, setHasCompleteCode] = useState(false);
  const authBusy = busy !== undefined;
  const destination = formatCodeDestination(
    t('login.enterCodeSentTo', { email: ADDRESS_SLOT }),
    email
  );

  return (
    // Keyboard avoidance is owned by the login shell in login-screen.tsx.
    <View className="gap-3">
      <Text variant="muted" className="text-center text-sm">
        {destination}
      </Text>
      <Text variant="muted" className="text-center text-xs">
        {t('login.codeArrivalHint')}
      </Text>
      <TextInput
        className="h-12 rounded-md border border-input bg-background px-3 text-lg leading-[normal] tracking-widest text-foreground"
        // textAlign is applied inline, not via a `text-center` class: NativeWind maps
        // textAlign to a native prop for TextInput and crashes on it in this version.
        // eslint-disable-next-line react-native/no-inline-styles -- see comment above
        style={{ textAlign: 'center' }}
        placeholder="123456"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        onChangeText={value => {
          codeRef.current = value;
          setHasCompleteCode(/^\d{6}$/.test(value));
        }}
        accessibilityLabel={formFieldA11y({ label: t('login.signInCodeField'), required: true })}
      />
      <Button
        size="lg"
        className="flex-row gap-2"
        disabled={!hasCompleteCode || authBusy}
        loading={busy === 'otp-verify'}
        onPress={() => {
          if (canSubmitEmailCode(codeRef.current, busy)) {
            onVerify(codeRef.current);
          }
        }}
        accessibilityLabel={t('login.verifyCode')}
      >
        <Text className="flex-1 text-center">{t('login.verifyCode')}</Text>
      </Button>
      <Button
        variant="outline"
        className="flex-row gap-2"
        disabled={authBusy}
        onPress={onResend}
        accessibilityLabel={t('login.resendCode')}
      >
        {busy === 'otp-send' ? <ActivityIndicator size="small" /> : null}
        <Text className="flex-1 text-center">{t('login.resendCode')}</Text>
      </Button>
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
