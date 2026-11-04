import { useLocalSearchParams, useRouter } from 'expo-router';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

export type BriefingListFilters = {
  history: boolean;
  organizationId: string | null | undefined;
  setHistory: Dispatch<SetStateAction<boolean>>;
  setOrganizationId: Dispatch<SetStateAction<string | null | undefined>>;
};

export function useBriefingListFilters(): BriefingListFilters {
  const router = useRouter();
  const { via } = useLocalSearchParams<{ via?: string }>();
  const [history, setHistory] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null | undefined>(undefined);
  // `via=push` marks a notification entry, whose list opens on the whole current
  // window. The marker is consumed once: the reset below owns the default, and
  // `setParams` only clears the marker so the next push entry counts as new.
  // The clear goes through the navigation container, which applies the action to
  // the route that handles it, so it is not guaranteed to reach this screen's
  // params. An uncleared marker therefore must not keep owning the filters:
  // `consumedPush` latches, and the chips stay live either way.
  const [consumedPush, setConsumedPush] = useState(false);
  const pushEntryPending = via === 'push' && !consumedPush;

  useEffect(() => {
    if (pushEntryPending) {
      setHistory(false);
      setOrganizationId(undefined);
      setConsumedPush(true);
      router.setParams({ via: undefined });
      return;
    }
    // A cleared marker re-arms the reset for the next push entry.
    if (via !== 'push' && consumedPush) {
      setConsumedPush(false);
    }
  }, [consumedPush, pushEntryPending, router, via]);

  return {
    history: pushEntryPending ? false : history,
    organizationId: pushEntryPending ? undefined : organizationId,
    setHistory,
    setOrganizationId,
  };
}
