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
  const [storedHistory, setHistory] = useState(false);
  const [storedOrganizationId, setOrganizationId] = useState<string | null | undefined>(undefined);
  const pushEntry = via === 'push';

  useEffect(() => {
    if (!pushEntry) {
      return;
    }
    setHistory(false);
    setOrganizationId(undefined);
    router.setParams({ via: undefined });
  }, [pushEntry, router]);

  return {
    history: pushEntry ? false : storedHistory,
    organizationId: pushEntry ? undefined : storedOrganizationId,
    setHistory,
    setOrganizationId,
  };
}
