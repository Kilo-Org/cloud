import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { ModelPicker } from '@/components/kiloclaw/model-picker';
import { ScreenHeader } from '@/components/screen-header';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

export default function ModelSettingsScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const paddingBottom = useDetailScreenBottomPadding();

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title="Model" context={instanceContext} />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Model" />
      <ScrollView className="flex-1 px-4 pt-4" contentContainerStyle={{ paddingBottom }}>
        <ModelPicker />
      </ScrollView>
    </View>
  );
}
