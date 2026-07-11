import { type SecurityFindingFilters } from '@kilocode/app-shared/security-agent';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { FindingFilterModal } from '@/components/security-agent/finding-filter-modal';
import { Text } from '@/components/ui/text';
import {
  clearSecurityFindingFilterBridge,
  getSecurityFindingFilterBridge,
} from '@/lib/security-finding-filter-bridge';

export default function SecurityAgentFilterFindingsRoute() {
  const router = useRouter();
  const [bridge, setBridge] = useState(() => getSecurityFindingFilterBridge());

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  const handleApply = useCallback(
    (filters: SecurityFindingFilters) => {
      bridge?.onApply(filters);
    },
    [bridge]
  );

  useFocusEffect(
    useCallback(() => {
      setBridge(getSecurityFindingFilterBridge());
      return () => {
        clearSecurityFindingFilterBridge();
      };
    }, [])
  );

  if (!bridge) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text variant="muted" className="text-sm">
          No filters available
        </Text>
      </View>
    );
  }

  return (
    <FindingFilterModal
      filters={bridge.filters}
      repositories={bridge.repositories}
      onClose={handleClose}
      onApply={handleApply}
    />
  );
}
