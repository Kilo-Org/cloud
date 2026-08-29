import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAuth } from '@/lib/auth/auth-context';
import { deleteAccountMetadata, setAccountMetadata } from '@/lib/auth/account-metadata-write';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

type OrganizationContextValue = {
  /** null = personal, string = org UUID */
  organizationId: string | null;
  isLoaded: boolean;
  setOrganizationId: (id: string | null) => void;
  error: 'restore' | 'save' | null;
  retry: () => void;
};

type OrganizationState = Pick<OrganizationContextValue, 'organizationId' | 'isLoaded' | 'error'> & {
  token: string | undefined;
};

const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { readonly children: ReactNode }) {
  const { token } = useAuth();
  const [state, setState] = useState<OrganizationState>({
    token,
    organizationId: null,
    isLoaded: false,
    error: null,
  });
  const generation = useRef(0);
  const activeId = useRef<string | null>(null);

  const restore = useCallback(async () => {
    generation.current += 1;
    const operation = generation.current;
    const epoch = currentAuthEpoch();
    setState(current => ({ ...current, token, isLoaded: false, error: null }));
    try {
      // Existing installs store a raw organization string; an absent value means
      // Personal. Keep both forms until those installations and records cannot exist.
      const stored = await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        activeId.current = stored ?? null;
        setState({ token, organizationId: stored ?? null, isLoaded: true, error: null });
      }
    } catch {
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        setState(current => ({ ...current, error: 'restore' }));
      }
    }
  }, [token]);

  const persist = useCallback(async (id: string | null) => {
    generation.current += 1;
    const operation = generation.current;
    const epoch = currentAuthEpoch();
    setState(current => ({ ...current, error: null }));
    try {
      await (id
        ? setAccountMetadata(ORGANIZATION_STORAGE_KEY, id)
        : deleteAccountMetadata(ORGANIZATION_STORAGE_KEY));
    } catch {
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        setState(current => ({ ...current, error: 'save' }));
      }
    }
  }, []);

  // This provider stays mounted above the auth gate. Reset on sign-out and
  // invalidate obsolete reads/saves on token changes and unmount.
  useEffect(() => {
    if (token) {
      void restore();
    } else {
      generation.current += 1;
      activeId.current = null;
      setState({ token, organizationId: null, isLoaded: true, error: null });
    }
    return () => {
      generation.current += 1;
    };
  }, [token, restore]);

  const setOrganizationId = useCallback(
    (id: string | null) => {
      activeId.current = id;
      setState({ token, organizationId: id, isLoaded: true, error: null });
      void persist(id);
    },
    [token, persist]
  );

  const retry = useCallback(() => {
    if (state.error === 'restore') {
      void restore();
    } else if (state.error === 'save') {
      void persist(activeId.current);
    }
  }, [state.error, restore, persist]);

  const value = useMemo<OrganizationContextValue>(
    () => ({
      // A new token must not publish the prior readiness before its effect runs.
      organizationId: state.organizationId,
      isLoaded: state.token === token && state.isLoaded,
      error: state.token === token ? state.error : null,
      setOrganizationId,
      retry,
    }),
    [state, token, setOrganizationId, retry]
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
