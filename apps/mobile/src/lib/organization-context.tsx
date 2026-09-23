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
import { unregisterActivityTokensAndTombstone } from '@/lib/auth/logout-cleanup';
import { writePrivacySnapshotAndEnd } from '@/lib/glanceable/cleanup';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * `ORGANIZATION_PERSONAL_STORAGE_KEY` is a SECOND key beside
 * `ORGANIZATION_STORAGE_KEY`. Every other reader of that key (glanceable
 * scope, widget actions, voice input, tool-summary) treats the stored value as
 * an organization id, so an explicit Personal choice keeps deleting it; the
 * settled "Personal was chosen" marker lives beside it. An absent organization
 * key alone now means "not chosen yet", which the default rule resolves from
 * the organization list.
 */
const PERSONAL_MARKER = 'personal';

type OrganizationContextValue = {
  /** null = personal, string = org UUID */
  organizationId: string | null;
  isLoaded: boolean;
  isSaving: boolean;
  setOrganizationId: (id: string | null) => void;
  error: 'restore' | 'save' | null;
  retry: () => void;
};

type OrganizationState = Pick<
  OrganizationContextValue,
  'organizationId' | 'isLoaded' | 'isSaving' | 'error'
> & {
  token: string | undefined;
};

const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { readonly children: ReactNode }) {
  const { token } = useAuth();
  const {
    data: organizations,
    isFetched: organizationsFetched,
    isFetching: organizationsFetching,
    isError: organizationsError,
    refetch: refetchOrganizations,
  } = useOrganizationsList();
  const [state, setState] = useState<OrganizationState>({
    token,
    organizationId: null,
    isLoaded: false,
    isSaving: false,
    error: null,
  });
  const generation = useRef(0);
  const activeId = useRef<string | null>(null);
  // Set by `restore` when nothing explicit is stored: the organization list
  // owns the publish then. A ref (not state) so `setOrganizationId` clears it
  // synchronously, before the list can publish over an explicit selection.
  const awaitingDefault = useRef(false);
  const defaultFence = useRef<{ operation: number; epoch: number } | null>(null);

  const restore = useCallback(async () => {
    generation.current += 1;
    const operation = generation.current;
    const epoch = currentAuthEpoch();
    awaitingDefault.current = false;
    defaultFence.current = null;
    setState(current => ({ ...current, token, isLoaded: false, isSaving: false, error: null }));
    try {
      // A stored organization is an explicit choice; the marker beside it is an
      // explicit Personal choice. An absent value is 'not chosen yet': the
      // organization list decides the default and the effect below publishes it.
      // A legacy absent value is treated the same way.
      const [stored, marker] = await Promise.all([
        SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY),
        SecureStore.getItemAsync(ORGANIZATION_PERSONAL_STORAGE_KEY),
      ]);
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        if (stored) {
          activeId.current = stored;
          setState({ token, organizationId: stored, isLoaded: true, isSaving: false, error: null });
        } else if (marker === PERSONAL_MARKER) {
          activeId.current = null;
          setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: null });
        } else {
          awaitingDefault.current = true;
          defaultFence.current = { operation, epoch };
          // Re-publish the resolving state so the list effect re-runs even when
          // the list settled before this read returned. Never publish Personal
          // here: an empty list, not this branch, is what means Personal.
          setState(current => ({ ...current, isLoaded: false }));
        }
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
    setState(current => ({ ...current, isSaving: true }));
    let error: 'save' | null = null;
    try {
      // An organization writes the organization key and clears the Personal
      // marker; Personal deletes the organization key every other reader relies
      // on and writes the marker in its place.
      await (id
        ? setAccountMetadata(ORGANIZATION_STORAGE_KEY, id)
        : deleteAccountMetadata(ORGANIZATION_STORAGE_KEY));
      await (id
        ? deleteAccountMetadata(ORGANIZATION_PERSONAL_STORAGE_KEY)
        : setAccountMetadata(ORGANIZATION_PERSONAL_STORAGE_KEY, PERSONAL_MARKER));
    } catch {
      error = 'save';
    }
    if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
      setState(current => ({ ...current, error, isSaving: false }));
    }
  }, []);

  // Publish the default organization once the shared list has settled. Fenced
  // by the generation and auth epoch captured in `restore()`, so a sign-out or
  // a newer sign-in during the fetch publishes nothing stale.
  useEffect(() => {
    if (!awaitingDefault.current) {
      return;
    }
    // A refetch of an already-failed list must settle before it republishes.
    if (!organizationsFetched || organizationsFetching) {
      return;
    }
    const fence = defaultFence.current;
    if (generation.current !== fence?.operation || !isCurrentAuthEpoch(fence.epoch)) {
      awaitingDefault.current = false;
      defaultFence.current = null;
      return;
    }
    awaitingDefault.current = false;
    defaultFence.current = null;
    if (organizationsError) {
      activeId.current = null;
      setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: 'restore' });
      return;
    }
    const defaultId = organizations?.[0]?.organizationId ?? null;
    activeId.current = defaultId;
    setState({ token, organizationId: defaultId, isLoaded: true, isSaving: false, error: null });
    // The default must land in storage, not only in React context: every other
    // reader of the organization key (glanceable scope, widget actions, voice
    // input, tool-summary translation) resolves the selection from SecureStore,
    // so publishing this id only here would leave them on Personal while the
    // app shows the organization. Personal (no organizations) writes nothing:
    // an absent key with no marker is still 'not chosen yet'.
    if (defaultId) {
      void persist(defaultId);
    }
  }, [
    state,
    organizations,
    organizationsFetched,
    organizationsFetching,
    organizationsError,
    token,
    persist,
  ]);

  // This provider stays mounted above the auth gate. Reset on sign-out and
  // invalidate obsolete reads/saves on token changes and unmount.
  useEffect(() => {
    if (token) {
      void restore();
    } else {
      generation.current += 1;
      activeId.current = null;
      awaitingDefault.current = false;
      defaultFence.current = null;
      setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: null });
    }
    return () => {
      generation.current += 1;
    };
  }, [token, restore]);

  const setOrganizationId = useCallback(
    (id: string | null) => {
      // An explicit selection always settles a pending default, even when it
      // matches the placeholder published while waiting; otherwise the default
      // would publish later and override the user's choice.
      const settlingDefault = awaitingDefault.current;
      awaitingDefault.current = false;
      defaultFence.current = null;
      // A same-value selection is a no-op: blanking it would bump the terminal
      // epoch and permanently gate the publisher, because React bails out of the
      // state update and no effect re-runs to rebuild it.
      if (id === state.organizationId && !settlingDefault) {
        return;
      }
      // Blank the current surface before the selection changes so the prior
      // org's counts are never shown under the next org.
      writePrivacySnapshotAndEnd();
      // Unregister the prior org's activity tokens (Live Activity /
      // push-to-start) so APNs stops targeting this device for the old scope.
      // Same-account switch: never revokes the device session or unregisters
      // the Expo push token (logout-only).
      void unregisterActivityTokensAndTombstone();
      activeId.current = id;
      setState(current => ({
        token,
        organizationId: id,
        isLoaded: true,
        isSaving: true,
        error: current.token === token && current.error === 'save' ? 'save' : null,
      }));
      void persist(id);
    },
    [token, persist, state.organizationId]
  );

  // `restore` re-reads the keys, but a default that failed on the shared list
  // would be republished from the same failed query. Refresh the list first so
  // Retry re-resolves the default instead of echoing the error.
  const retryRestore = useCallback(async () => {
    await refetchOrganizations();
    await restore();
  }, [refetchOrganizations, restore]);

  const retry = useCallback(() => {
    if (state.error === 'restore') {
      void retryRestore();
    } else if (state.error === 'save') {
      void persist(activeId.current);
    }
  }, [state.error, retryRestore, persist]);

  const value = useMemo<OrganizationContextValue>(
    () => ({
      // A new token must not publish the prior readiness before its effect runs.
      organizationId: state.organizationId,
      isLoaded: state.token === token && state.isLoaded,
      isSaving: state.token === token && state.isSaving,
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
