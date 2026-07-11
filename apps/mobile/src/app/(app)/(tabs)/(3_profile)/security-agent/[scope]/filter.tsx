import { type SecurityFindingFilters } from '@kilocode/app-shared/security-agent';
import { useFocusEffect, useRouter } from 'expo-router';
import { Info } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { FindingFilterModal } from '@/components/security-agent/finding-filter-modal';
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
      <View className="flex-1 bg-background">
        <EmptyState
          icon={Info}
          className="flex-1"
          title="No filters available"
          description="Go back and reopen filters from the findings list."
        />
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
