import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

type OrganizationContextValue = {
  /** null = personal, string = org UUID */
  organizationId: string | null;
  isLoaded: boolean;
  setOrganizationId: (id: string | null) => void;
};

const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { readonly children: ReactNode }) {
  const [organizationId, setOrgState] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const stored = await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
        if (!cancelled) {
          setOrgState(stored ?? null);
        }
      } finally {
        if (!cancelled) {
          setIsLoaded(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setOrganizationId = useCallback((id: string | null) => {
    setOrgState(id);
    if (id) {
      void SecureStore.setItemAsync(ORGANIZATION_STORAGE_KEY, id);
    } else {
      void SecureStore.deleteItemAsync(ORGANIZATION_STORAGE_KEY);
    }
  }, []);

  const value = useMemo<OrganizationContextValue>(
    () => ({ organizationId, isLoaded, setOrganizationId }),
    [organizationId, isLoaded, setOrganizationId]
  );

  return <OrganizationContext value={value}>{children}</OrganizationContext>;
}

export function useOrganization(): OrganizationContextValue {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
}
