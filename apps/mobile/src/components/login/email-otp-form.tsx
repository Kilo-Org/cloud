import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  type KeyboardEvent,
  Platform,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from '@/components/kilo-chat/app-aware-keyboard-padding-state';
import { type useNativeAuth } from '@/lib/auth/use-native-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { canSubmitEmailCode } from './email-otp-state';

const OTP_KEYBOARD_BREATHING_GAP = 16;

function keyboardHeightFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
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
  const codeRef = useRef('');
  const [hasCompleteCode, setHasCompleteCode] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const authBusy = busy !== undefined;

  useEffect(() => {
    const keyboardEvents = resolveKeyboardPaddingEventsForPlatform(Platform.OS);
    if (keyboardEvents === null) {
      setKeyboardHeight(0);
      return undefined;
    }

    const keyboardShowSubscription = Keyboard.addListener(keyboardEvents.show, event => {
      setKeyboardHeight(current =>
        resolveAppAwareKeyboardPadding({
          currentPadding: current,
          event: {
            type: 'keyboard-visible',
            keyboardHeight: keyboardHeightFromEvent(event),
          },
        })
      );
    });
    const keyboardHideSubscription = Keyboard.addListener(keyboardEvents.hide, () => {
      setKeyboardHeight(current =>
        resolveAppAwareKeyboardPadding({
          currentPadding: current,
          event: { type: 'keyboard-hidden' },
        })
      );
    });
    const appStateSubscription = AppState.addEventListener('change', appState => {
      setKeyboardHeight(current =>
        resolveAppAwareKeyboardPadding({
          currentPadding: current,
          event: { type: 'app-state-change', appState },
        })
      );
    });

    return () => {
      keyboardShowSubscription.remove();
      keyboardHideSubscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  // Only pad while the keyboard is up, so the resting (keyboard-hidden) layout
  // is not shifted within the parent's justify-center container.
  const bottomSpacer = keyboardHeight > 0 ? keyboardHeight + OTP_KEYBOARD_BREATHING_GAP : 0;

  return (
    // Defect A / QB-16: on iOS at Dynamic Type XXXL, the number pad occludes
    // the Verify / Resend / Back controls. We add a bottom spacer equal to the
    // keyboard height (plus a small breathing gap) inside the scrollable
    // content, so the parent ScrollView (with automaticallyAdjustKeyboardInsets
    // on iOS, and the window-level behavior="height" KeyboardAvoidingView on
    // Android) has enough scrollable room for the user to scroll the controls
    // above the number pad. keyboardShouldPersistTaps="handled" on the parent
    // lets the user tap the controls mid-scroll. We intentionally do NOT nest a
    // KeyboardAvoidingView here — nested behavior="padding" KAVs compute ~0
    // bottom padding and do not help when content already overflows.
    <View className="gap-3" style={{ paddingBottom: bottomSpacer }}>
      <Text variant="muted" className="text-center text-sm">
        Enter the code sent to {email}
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
