/* eslint-disable no-literal-copy/no-literal-copy -- Development-only native layout fixture. */
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import en from '@/i18n/locales/en.json';
import hi from '@/i18n/locales/hi.json';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// Native label layout cases behind the dev button-label-fixture link. No API calls or account needed.
export default function ButtonLabelFixtureRoute() {
  const colors = useThemeColors();
  const [loading, setLoading] = useState(false);
  if (!__DEV__) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Button labels" />
      <ScrollView contentContainerClassName="gap-4 px-6 pt-4 pb-8">
        <Text>Hindi · full width</Text>
        <Button>
          <Plus size={16} color={colors.primaryForeground} />
          <Text>{hi.profiles.newProfile}</Text>
        </Button>
        <Button variant="outline" size="sm">
          <Text>{hi.agentChat.session.continueInNewSession}</Text>
        </Button>
        <Text>English · full width</Text>
        <Button>
          <Plus size={16} color={colors.primaryForeground} />
          <Text>{en.profiles.newProfile}</Text>
        </Button>
        <Text>Content sized</Text>
        <View className="flex-row gap-3">
          <Button size="sm">
            <Text>{hi.profiles.newProfile}</Text>
          </Button>
          <Button size="icon" accessibilityLabel="Add">
            <Plus size={16} color={colors.primaryForeground} />
          </Button>
        </View>
        <Text>Narrow · complete multiline label</Text>
        <View className="w-[100px] self-center">
          <Button variant="outline">
            <Text>{hi.agentChat.session.continueInNewSession}</Text>
          </Button>
        </View>
        <Text>Italic · glyph overhang</Text>
        <Button variant="outline">
          <Text className="italic">Italic overhang label</Text>
        </Button>
        <Text>Loading · tap to toggle</Text>
        <Button loading={loading}>
          <Text>{hi.profiles.newProfile}</Text>
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            setLoading(value => !value);
          }}
        >
          <Text>Toggle loading</Text>
        </Button>
      </ScrollView>
    </View>
  );
}
