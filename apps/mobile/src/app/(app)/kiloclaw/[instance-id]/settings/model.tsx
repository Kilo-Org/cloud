import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { ModelPicker } from '@/components/kiloclaw/model-picker';
import { ScreenHeader } from '@/components/screen-header';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

export default function ModelSettingsScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const paddingBottom = useDetailScreenBottomPadding();
  const { t } = useTranslation();

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <InstanceContextBoundary
        title={t(
          // i18n-dup-ok: 'common.model' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
          'common.model'
        )}
        context={instanceContext}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.model')} />
      <ScrollView className="flex-1 pt-4" contentContainerStyle={{ paddingBottom }}>
        <View className="px-4">
          <ModelPicker />
        </View>
      </ScrollView>
    </View>
  );
}
