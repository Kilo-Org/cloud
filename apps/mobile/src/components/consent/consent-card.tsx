import * as WebBrowser from 'expo-web-browser';
import { type Href, useRouter } from 'expo-router';
import { ChevronRight, MessageSquare, Shield, Smartphone, User } from 'lucide-react-native';
import { Alert, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { ConsentRow } from '@/components/consent/consent-row';
import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { WEB_BASE_URL } from '@/lib/config';
import { acceptConsent, revokeConsent } from '@/lib/consent';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const PRIVACY_URL = `${WEB_BASE_URL}/privacy-app`;

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

  const handlePrimaryAction = async () => {
    if (mode === 'review') {
      router.back();
      return;
    }

    if (!userId) {
      toast.error('Could not load your account. Please try again.');
      return;
    }

    await acceptConsent(userId);
    router.replace('/(app)/(tabs)' as Href);
  };

  const handleSecondaryAction = () => {
    const message =
      mode === 'review'
        ? 'Kilo Code needs this consent to function. Revoking will sign you out. You can accept again on next sign-in.'
        : 'Kilo Code needs to share data with AI providers to work. If you decline, you will be signed out.';

    Alert.alert(actions.destructiveTitle, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: actions.destructiveLabel,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            if (mode === 'review') {
              if (!userId) {
                toast.error('Could not load your account. Please try again.');
                return;
              }

              await revokeConsent(userId);
            }

            await signOut();
          })();
        },
      },
    ]);
  };

  const handleOpenPrivacy = () => {
    void WebBrowser.openBrowserAsync(PRIVACY_URL);
  };

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
          <Text className="text-base font-semibold text-foreground">Kilo Code</Text>
        </View>

        <Text className="mt-6 text-2xl font-bold text-foreground">Before we get started</Text>
        <Text className="mt-3 text-base text-muted-foreground">
          Kilo Code sends your messages to AI providers to generate responses. Here&apos;s
          what&apos;s shared and with whom.
        </Text>

        <View className="mt-6 gap-5">
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
            description="Anonymous performance and crash data, used to keep the app stable."
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

        <View className="mt-8 gap-3">
          <Button
            onPress={() => {
              void handlePrimaryAction();
            }}
            size="lg"
            accessibilityLabel={actions.primaryLabel}
          >
            <Text>{actions.primaryLabel}</Text>
          </Button>
          <Button
            variant={mode === 'review' ? 'destructive' : 'outline'}
            size="lg"
            onPress={handleSecondaryAction}
            accessibilityLabel={actions.secondaryLabel}
          >
            <Text>{actions.secondaryLabel}</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
