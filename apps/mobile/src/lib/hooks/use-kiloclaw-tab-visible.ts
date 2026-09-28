import { useEffect, useState } from 'react';

import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { persistKiloClawOwned, readKiloClawOwned } from '@/lib/kiloclaw-tab-ownership';

/**
 * Whether the KiloClaw tab entry is shown. Seeded from the persisted answer so
 * the tab count is correct on the first frame, then reconciled from the
 * instance list. A failed or pending fetch keeps the persisted answer.
 *
 * The bar is session-stable: once the entry is shown it stays for the rest of
 * the session, so a stale persisted answer contradicted by the fetched list
 * never removes a tab the user is looking at. The fetched list may still add
 * the entry, and `persistKiloClawOwned` records the fetched truth so the next
 * launch hides it again when no instance exists.
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
    setVisible(previous => previous || owned);
  }, [instances]);

  return visible;
}
