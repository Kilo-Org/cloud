import { useRef, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
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
  const codeRef = useRef('');
  const [hasCompleteCode, setHasCompleteCode] = useState(false);
  const authBusy = busy !== undefined;

  return (
    <View className="gap-3">
      <Text variant="muted" className="text-center text-sm">
        Enter the code sent to {email}
      </Text>
      <TextInput
        className="h-12 rounded-md border border-input bg-background px-3 text-lg leading-5 tracking-widest text-foreground"
        // textAlign is applied inline, not via a `text-center` class: NativeWind maps
        // textAlign to a native prop for TextInput and crashes on it in this version.
        // eslint-disable-next-line react-native/no-inline-styles -- see comment above
        style={{ textAlign: 'center' }}
        placeholder="123456"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="number-pad"
        maxLength={6}
        onChangeText={value => {
          codeRef.current = value;
          setHasCompleteCode(/^\d{6}$/.test(value));
        }}
        accessibilityLabel="Sign-in code"
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
        accessibilityLabel="Verify code"
      >
        {busy === 'otp-verify' ? <ActivityIndicator size="small" /> : null}
        <Text>Verify code</Text>
      </Button>
      <Button
        variant="outline"
        className="flex-row gap-2"
        disabled={authBusy}
        onPress={onResend}
        accessibilityLabel="Resend code"
      >
        {busy === 'otp-send' ? <ActivityIndicator size="small" /> : null}
        <Text>Resend code</Text>
      </Button>
      <Button variant="ghost" disabled={authBusy} onPress={onBack} accessibilityLabel="Back">
        <Text>Back</Text>
      </Button>
    </View>
  );
}
