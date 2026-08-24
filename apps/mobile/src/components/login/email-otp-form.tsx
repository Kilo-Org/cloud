import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { Text } from '@/components/ui/text';
import { type useNativeAuth } from '@/lib/auth/use-native-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { canSubmitEmailCode } from './email-otp-state';

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

  return (
    // Keyboard avoidance is owned by the login shell in login-screen.tsx.
    <View className="gap-3">
      <Text variant="muted" className="text-center text-sm">
        {t('login.enterCodeSentTo', { email })}
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
        onPress={() => {
          if (canSubmitEmailCode(codeRef.current, busy)) {
            onVerify(codeRef.current);
          }
        }}
        accessibilityLabel={t('login.verifyCode')}
      >
        {busy === 'otp-verify' ? <ActivityIndicator size="small" /> : null}
        <Text>{t('login.verifyCode')}</Text>
      </Button>
      <Button
        variant="outline"
        className="flex-row gap-2"
        disabled={authBusy}
        onPress={onResend}
        accessibilityLabel={t('login.resendCode')}
      >
        {busy === 'otp-send' ? <ActivityIndicator size="small" /> : null}
        <Text>{t('login.resendCode')}</Text>
      </Button>
      <Button
        variant="ghost"
        disabled={authBusy}
        onPress={onBack}
        accessibilityLabel={t('login.back')}
      >
        <Text>{t('login.back')}</Text>
      </Button>
    </View>
  );
}
