import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { Section } from '@/components/consent/section';
import { type ConsentMode } from '@/components/consent/consent-mode';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { PRIVACY_URL } from '@/lib/config';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { voiceInputController } from '@/lib/voice-input/native-voice-input';
import {
  readVoiceNetworkConsent,
  subscribeToVoiceNetworkConsent,
  type VoiceNetworkConsent,
  writeVoiceNetworkConsent,
} from '@/lib/voice-input/voice-network-consent';

type ConsentDetailsProps = {
  readonly mode?: ConsentMode;
};

export function VoiceTranscriptionControl() {
  const { userId } = useCurrentUserId();
  const supportsOnDevice = voiceInputController.supportsOnDevice();
  const [consent, setConsent] = useState<VoiceNetworkConsent>('unset');

  useEffect(() => {
    if (!userId) {
      setConsent('unset');
      return undefined;
    }
    let active = true;
    void (async () => {
      const value = await readVoiceNetworkConsent(userId);
      // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- active is cleared on unmount
      if (active) {
        setConsent(value);
      }
    })();
    const unsubscribe = subscribeToVoiceNetworkConsent((changedUserId, value) => {
      if (changedUserId === userId) {
        setConsent(value);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId]);

  if (supportsOnDevice) {
    return <Text className="mt-3 text-sm text-muted-foreground">On device</Text>;
  }

  // No non-retryable unhappy state exists: `readVoiceNetworkConsent` never
  // fails (an absent or corrupt value reads as 'unset'), and the control has no
  // terminal failure mode — a write failure is always retryable.
  if (!userId) {
    return (
      <Text className="mt-3 text-sm text-muted-foreground">
        Sign in to manage online transcription.
      </Text>
    );
  }

  const allowed = consent === 'granted';
  const label = allowed ? 'Online, allowed' : 'Online, not allowed';

  const handleToggle = async (next: boolean) => {
    const value: 'granted' | 'declined' = next ? 'granted' : 'declined';
    const previous = consent;
    setConsent(value);
    try {
      await writeVoiceNetworkConsent(userId, value);
    } catch {
      // Roll back the optimistic flip so the switch reflects the stored value.
      setConsent(previous);
      toast.error('Could not save your choice. Please try again.');
    }
  };

  return (
    <View className="mt-3 flex-row items-center justify-between gap-3">
      <Text className="flex-1 text-sm text-muted-foreground">{label}</Text>
      <Switch
        value={allowed}
        onValueChange={handleToggle}
        accessibilityLabel="Online transcription"
      />
    </View>
  );
}

export function ConsentDetails({ mode = 'onboarding' }: ConsentDetailsProps) {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const contentContainerStyle = {
    paddingTop: 8,
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };

  const handleOpenPrivacy = () => {
    void WebBrowser.openBrowserAsync(PRIVACY_URL);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Data we share with third parties" />
      <ScrollView
        className="flex-1 px-6"
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <Section
          title="AI model providers"
          what="Your prompts, conversation history, and any files you attach."
          why="To generate AI responses."
          who="Anthropic, OpenAI, Google, and other providers you select per request."
        />
        <Section
          title="Kilo Gateway (our backend)"
          what="Account ID, request metadata, token usage."
          why="Authentication, routing requests, billing reconciliation."
          who="Kilo (kilo.ai)."
        />
        <Section
          title="Crash reporting"
          what="Crash and error reports, with app content scrubbed."
          why="Identify and fix crashes."
          who="Sentry."
          footer={
            <View className="mt-3 gap-3">
              <View className="rounded-md bg-warn-tile-bg p-3">
                <Text className="text-xs text-warn">
                  Crash reports include no screen capture unless optional sharing is on (see below).
                  We never capture your screen&apos;s view hierarchy.
                </Text>
              </View>
            </View>
          }
        />

        <Text className="mt-6 text-sm font-semibold text-foreground">
          {mode === 'review'
            ? 'Optional — you can change this any time in Settings'
            : 'Optional — on unless you turn it off'}
        </Text>

        <Section
          title="Product analytics"
          what="App events (opens, screens viewed, feature use), device type, app version."
          why="Measure app performance and understand how features are used."
          who="PostHog."
          footer={
            <View className="mt-3">
              <View className="rounded-md bg-warn-tile-bg p-3">
                <Text className="text-xs text-warn">
                  No prompt or conversation content is sent to product analytics.
                </Text>
              </View>
            </View>
          }
        />
        <Section
          title="Error screenshots and session replay"
          what="Masked screenshots when an error happens, and masked recordings of a small sample of sessions."
          why="See what the app displayed when something broke."
          who="Sentry."
          footer={
            <View className="mt-3">
              <View className="rounded-md bg-warn-tile-bg p-3">
                <Text className="text-xs text-warn">
                  Text and images are masked on your device before anything is sent.
                </Text>
              </View>
            </View>
          }
        />
        <Section
          title="Install attribution"
          what="Install source and campaign identifiers."
          why="Understand which channels bring new users."
          who="AppsFlyer."
        />
        <Section
          title="Voice transcription"
          what="Your recording while you dictate."
          why="To turn speech into text."
          who="On-device only, or Apple or Google when this device cannot transcribe offline."
          footer={<VoiceTranscriptionControl />}
        />

        <Text className="mt-6 text-xs text-muted-foreground">
          Full retention periods, your rights, and contact information are in the{' '}
          <Text className="text-xs text-primary underline" onPress={handleOpenPrivacy}>
            Kilo privacy policy
          </Text>
          .
        </Text>

        <View className="mt-8">
          <Button
            size="lg"
            onPress={() => {
              router.back();
            }}
            accessibilityLabel="Back to consent"
          >
            <Text>Back to consent</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
