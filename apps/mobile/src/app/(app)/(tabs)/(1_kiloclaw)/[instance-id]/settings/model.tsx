import { ScrollView, View } from 'react-native';

import { ModelPicker } from '@/components/kiloclaw/model-picker';
import { ScreenHeader } from '@/components/screen-header';

export default function ModelSettingsScreen() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Model" />
      <ScrollView className="flex-1 px-4 pt-4" contentContainerClassName="pb-8">
        <ModelPicker />
      </ScrollView>
    </View>
  );
}
