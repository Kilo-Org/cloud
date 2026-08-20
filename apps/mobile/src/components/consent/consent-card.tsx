import * as WebBrowser from 'expo-web-browser';
import { type Href, useRouter } from 'expo-router';
import {
  ChevronRight,
  LineChart,
  MessageSquare,
  Shield,
  Smartphone,
  User,
} from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentRow } from '@/components/consent/consent-row';
import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { useAuth } from '@/lib/auth/auth-context';
import { PRIVACY_URL } from '@/lib/config';
import { acceptConsent, readConsent, revokeConsent, setOptionalConsent } from '@/lib/consent';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ConsentCardProps = {
  readonly mode?: ConsentMode;
};

export function ConsentCard({ mode = 'onboarding' }: ConsentCardProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom, top } = useSafeAreaInsets();
  const { signOut, token } = useAuth();
  const { userId } = useCurrentUserId({ enabled: token != null });
  const actions = getConsentActions(mode);
  const rootStyle = { paddingTop: top };
  const contentContainerStyle = {
    paddingTop: 24,
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };
  const [pendingAction, setPendingAction] = useState<'primary' | 'secondary' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Onboarding pre-selects optional telemetry. Review mode starts off and the
  // stored value loads over it, so a stored decline never flashes as on.
  const [optionalToggle, setOptionalToggle] = useState(mode === 'onboarding');
  const [savingOptional, setSavingOptional] = useState(false);
  const loadedRef = useRef(false);
  const userToggledRef = useRef(false);

  // Load the stored optional value in review mode only.  The active flag
  // stops a late resolve from overwriting a value the user just toggled.
  useEffect(() => {
    if (mode !== 'review' || !userId || loadedRef.current) {
      return undefined;
    }
    let active = true;
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- async/await would allow the promise to settle after unmount.
    void readConsent(userId).then(
      // eslint-disable-next-line promise/always-return
      stored => {
        if (active && !userToggledRef.current) {
          setOptionalToggle(stored.optional);
          loadedRef.current = true;
        }
      },
      () => {
        if (active) {
          setError('Could not load your consent settings. Please try again.');
        }
      }
    );
    return () => {
      active = false;
    };
  }, [mode, userId]);

  const handlePrimaryAction = async () => {
    if (mode === 'review') {
      router.back();
      return;
    }

    if (!userId) {
      setError('Could not load your account. Please try again.');
      return;
    }

    setError(null);
    setPendingAction('primary');
    try {
      await acceptConsent(userId, optionalToggle);
      router.replace('/(app)/(tabs)' as Href);
    } catch {
      setError('Could not save your consent. Please try again.');
      setPendingAction(null);
    }
  };

  const runSecondaryAction = async () => {
    setError(null);
    setPendingAction('secondary');

    if (mode === 'review') {
      if (!userId) {
        setError('Could not load your account. Please try again.');
        setPendingAction(null);
        return;
      }

      try {
        await revokeConsent(userId);
      } catch {
        setError('Could not revoke consent. Please try again.');
        setPendingAction(null);
        return;
      }
    }

    try {
      await signOut();
    } catch {
      setError(
        mode === 'review'
          ? 'Consent was revoked, but sign-out failed. Please try again.'
          : 'Could not sign out. Please try again.'
      );
      setPendingAction(null);
    }
  };

  const handleSecondaryAction = () => {
    const message =
      mode === 'review'
        ? 'Kilo needs this consent to function. Revoking will sign you out. You can accept again on next sign-in.'
        : 'Kilo needs to share data with AI providers to work. If you decline, you will be signed out.';

    Alert.alert(actions.destructiveTitle, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: actions.destructiveLabel,
        style: 'destructive',
        onPress: () => {
          void runSecondaryAction();
        },
      },
    ]);
  };

  const handleOpenPrivacy = () => {
    void WebBrowser.openBrowserAsync(PRIVACY_URL);
  };

  const handleToggleOptional = useCallback(
    (next: boolean) => {
      setOptionalToggle(next);
      setError(null);

      if (mode === 'review' && userId) {
        userToggledRef.current = true;
        setSavingOptional(true);
        // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- fire-and-forget toggle revert pattern.
        void setOptionalConsent(userId, next).then(
          // eslint-disable-next-line promise/always-return
          () => {
            setSavingOptional(false);
          },
          () => {
            setOptionalToggle(!next);
            setError('Could not save your choice. Please try again.');
            setSavingOptional(false);
          }
        );
      } else if (mode === 'review') {
        setOptionalToggle(!next);
        setError('Could not load your account. Please try again.');
      }
    },
    [mode, userId]
  );

  return (
    <View className="flex-1 bg-background" style={rootStyle}>
      <ScrollView
        className="flex-1 px-6"
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-lg bg-secondary">
            <Shield size={20} color={colors.foreground} />
          </View>
          <Text className="text-base font-semibold text-foreground">Kilo</Text>
        </View>

        <Text className="mt-6 text-2xl font-bold text-foreground">Before we get started</Text>
        <Text className="mt-3 text-base text-muted-foreground">
          Kilo sends your messages to AI providers to generate responses. Here&apos;s what&apos;s
          shared and with whom.
        </Text>

        <Text className="mt-6 text-sm font-semibold text-foreground">Required to use Kilo</Text>

        <View className="mt-3 gap-5">
          <ConsentRow
            icon={MessageSquare}
            title="Your prompts and conversations"
            description="Sent to AI model providers (Anthropic, OpenAI, Google, and others) to generate replies."
          />
          <ConsentRow
            icon={User}
            title="Account & usage data"
            description="Your Kilo account ID and request metadata, used to authenticate you and meter usage."
          />
          <ConsentRow
            icon={Smartphone}
            title="App diagnostics"
            description="Crash and error reports, with app content removed, used to keep the app stable."
          />
        </View>

        <Text className="mt-6 text-sm font-semibold text-foreground">Optional</Text>

        <View className="mt-3 flex-row items-start gap-3 rounded-lg border border-border p-4">
          <View className="mt-0.5">
            <LineChart size={18} color={colors.mutedForeground} />
          </View>
          <View className="flex-1 shrink gap-1">
            <Text className="text-base font-semibold text-foreground">Help improve Kilo</Text>
            <Text className="text-sm text-muted-foreground">
              Share anonymous product analytics and install source. You can change this any time in
              Settings.
            </Text>
          </View>
          <Switch
            value={optionalToggle}
            disabled={mode === 'review' && savingOptional}
            accessibilityLabel="Help improve Kilo"
            onValueChange={handleToggleOptional}
          />
        </View>

        <Pressable
          onPress={() => {
            router.push(
              mode === 'review'
                ? ('/(app)/consent-details?mode=review' as Href)
                : ('/(app)/consent-details' as Href)
            );
          }}
          hitSlop={8}
          accessibilityLabel="See full details"
          className="mt-6 flex-row items-center gap-1 active:opacity-70"
        >
          <Text className="text-sm font-semibold text-primary">See full details</Text>
          <ChevronRight size={16} color={colors.primary} />
        </Pressable>

        <Text className="mt-6 text-xs text-muted-foreground">
          Your data is handled per the{' '}
          <Text className="text-xs text-primary underline" onPress={handleOpenPrivacy}>
            Kilo privacy policy
          </Text>
          .
        </Text>

        <AccessibleStatus message={error} className="mt-6 text-sm" />

        <View className="mt-8 gap-3">
          <Button
            onPress={() => {
              void handlePrimaryAction();
            }}
            size="lg"
            accessibilityLabel={actions.primaryLabel}
            disabled={pendingAction === 'secondary'}
            loading={pendingAction === 'primary'}
          >
            <Text>{actions.primaryLabel}</Text>
          </Button>
          <Button
            variant={mode === 'review' ? 'destructive' : 'outline'}
            size="lg"
            onPress={handleSecondaryAction}
            accessibilityLabel={actions.secondaryLabel}
            disabled={pendingAction === 'primary'}
            loading={pendingAction === 'secondary'}
          >
            <Text>{actions.secondaryLabel}</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
