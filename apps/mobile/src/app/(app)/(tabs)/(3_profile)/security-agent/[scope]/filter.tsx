import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  type SecurityFindingFilters,
} from '@kilocode/app-shared/security-agent';
import { useFocusEffect, useRouter } from 'expo-router';
import { Info } from '@/components/ui/icons';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { FindingFilterModal } from '@/components/security-agent/finding-filter-modal';
import {
  SECURITY_FILTER_ROUTE_KEY,
  securityFilterSlot,
  useRouteRegistry,
} from '@/lib/route-registry';

export default function SecurityAgentFilterFindingsRoute() {
  const router = useRouter();
  const [bridge, setBridge] = useState(() => securityFilterSlot.get(SECURITY_FILTER_ROUTE_KEY));
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SecurityFindingFilters>(
    () =>
      securityFilterSlot.get(SECURITY_FILTER_ROUTE_KEY)?.filters ?? DEFAULT_SECURITY_FINDING_FILTERS
  );
  useRouteRegistry(SECURITY_FILTER_ROUTE_KEY);

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  const handleApply = useCallback(() => {
    bridge?.onApply(draft);
    router.back();
  }, [bridge, draft, router]);

  useFocusEffect(
    useCallback(() => {
      const nextBridge = securityFilterSlot.get(SECURITY_FILTER_ROUTE_KEY);
      setBridge(nextBridge);
      setDraft(nextBridge?.filters ?? DEFAULT_SECURITY_FINDING_FILTERS);
      return () => {
        securityFilterSlot.clear(SECURITY_FILTER_ROUTE_KEY);
      };
    }, [])
  );

  if (!bridge) {
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          icon={Info}
          className="flex-1"
          title={t('securityAgent.filter.noFilters')}
          description={t('securityAgent.filter.noFiltersDescription')}
        />
      </View>
    );
  }

  return (
    <PickerSheet
      title={t('securityAgent.filter.title')}
      onDone={handleApply}
      onCancel={handleClose}
      doneLabel={t('common.apply')}
    >
      <FindingFilterModal filters={draft} repositories={bridge.repositories} onChange={setDraft} />
    </PickerSheet>
  );
}
