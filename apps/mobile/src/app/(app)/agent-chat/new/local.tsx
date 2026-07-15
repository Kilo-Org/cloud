import { View } from 'react-native';

import { RuntimeDiscoveryContent } from '@/components/agents/runtime-discovery-content';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';

/**
 * Discovery screen for the local-runtime source. This intermediate slice
 * intentionally renders `RuntimeDiscoveryContent` without an `onSelect` —
 * capable rows are static, incapable rows stay disabled, and the empty /
 * error / loading branches own their retry CTAs. Catalog-driven session
 * setup will land here in a follow-up.
 */
export default function NewSessionLocalRoute() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Local session" />
      <View className="px-4 pt-4">
        <Text className="mb-3 text-sm font-medium text-muted-foreground">Available runtimes</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card px-1">
          <RuntimeDiscoveryContent />
        </View>
      </View>
    </View>
  );
}
