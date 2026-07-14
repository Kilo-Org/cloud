import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  type SecurityFindingFilters,
} from '@kilocode/app-shared/security-agent';
import { useFocusEffect, useRouter } from 'expo-router';
import { Info } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { FindingFilterModal } from '@/components/security-agent/finding-filter-modal';
import {
  clearSecurityFindingFilterBridge,
  getSecurityFindingFilterBridge,
} from '@/lib/security-finding-filter-bridge';

export default function SecurityAgentFilterFindingsRoute() {
  const router = useRouter();
  const [bridge, setBridge] = useState(() => getSecurityFindingFilterBridge());
  const [draft, setDraft] = useState<SecurityFindingFilters>(
    () => getSecurityFindingFilterBridge()?.filters ?? DEFAULT_SECURITY_FINDING_FILTERS
  );

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  const handleApply = useCallback(() => {
    bridge?.onApply(draft);
    router.back();
  }, [bridge, draft, router]);

  useFocusEffect(
    useCallback(() => {
      const nextBridge = getSecurityFindingFilterBridge();
      setBridge(nextBridge);
      setDraft(nextBridge?.filters ?? DEFAULT_SECURITY_FINDING_FILTERS);
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
    <PickerSheet
      title="Filter findings"
      onDone={handleApply}
      onCancel={handleClose}
      doneLabel="Apply"
    >
      <FindingFilterModal filters={draft} repositories={bridge.repositories} onChange={setDraft} />
    </PickerSheet>
  );
}
