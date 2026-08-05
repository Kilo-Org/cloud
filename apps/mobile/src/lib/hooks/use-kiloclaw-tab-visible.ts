import { useEffect, useState } from 'react';

import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { persistKiloClawOwned, readKiloClawOwned } from '@/lib/kiloclaw-tab-ownership';

/**
 * Whether the KiloClaw tab entry is shown. Seeded from the persisted answer so
 * the tab count is correct on the first frame, then reconciled from the
 * instance list. A failed or pending fetch keeps the persisted answer.
 *
 * The poll is off: this hook is mounted for the whole signed-in session, and
 * ownership changes rarely. The list still refreshes on a cold start, on a Home
 * pull-to-refresh, and from the KiloClaw tab's own poll and invalidations.
 */
export function useKiloClawTabVisible(): boolean {
  const { data: instances } = useAllKiloClawInstances(false);
  const [visible, setVisible] = useState(readKiloClawOwned);

  useEffect(() => {
    if (instances === undefined) {
      return;
    }
    const owned = instances.length > 0;
    persistKiloClawOwned(owned);
    setVisible(owned);
  }, [instances]);

  return visible;
}
