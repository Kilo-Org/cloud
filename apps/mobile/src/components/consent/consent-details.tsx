import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Section } from '@/components/consent/section';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';

const PRIVACY_URL = `${WEB_BASE_URL}/privacy-app`;

export function ConsentDetails() {
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
          title="Analytics & attribution"
          what="App events (opens, screens viewed, feature use), device type, app version, install source."
          why="Measure app performance and understand which channels bring new users."
          who="The analytics provider named in our privacy policy."
          footer={
            <View className="mt-3 rounded-md bg-amber-50 p-3 dark:bg-amber-950">
              <Text className="text-xs text-amber-900 dark:text-amber-100">
                No prompt or conversation content is sent to analytics.
              </Text>
            </View>
          }
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
