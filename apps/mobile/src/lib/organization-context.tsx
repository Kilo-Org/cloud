/* eslint-disable max-lines -- the selection lifecycle (restore, default
   resolution, lost-membership recovery, and the storage contract) shares one
   state machine; splitting it would scatter the generation fencing that keeps
   the publisher correct */
import * as SecureStore from '@/lib/auth/secure-store';
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
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { chainSave } from '@/lib/hooks/save-chain';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { i18n } from '@/i18n';
import { decodeSelection, encodeSelection, PERSONAL_SELECTION } from '@/lib/organization-selection';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * One queue slot for the selection: every save runs through it in call order,
 * so the stored value always matches the selection the provider last published.
 * The stored form itself is one value; see `lib/organization-selection`.
 */
const SELECTION_QUEUE_KEY = 'organization-selection';

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
    isPaused: organizationsPaused,
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
  // Whether the current Personal selection is an explicit choice (its marker is
  // stored). An auto-resolved Personal — from an empty list or a failed restore
  // — is not explicit, so selecting Personal must still write the marker.
  const personalExplicit = useRef(false);
  // Set while the provider switches away from a membership the fetched list no
  // longer contains. The recovery effect owns the switch; the toast copy names
  // the target context, so the target is carried beside the flag.
  const recoveringRef = useRef<string | null | undefined>(undefined);
  // The list snapshot the current selection was published against (undefined
  // until a settled list is seen for it). Detection compares only across
  // snapshots: a selection published against the list it came from is valid by
  // construction; only a NEW snapshot (a refetch) missing the selection means
  // the membership vanished server-side.
  const selectionListSeen = useRef<readonly OrgListEntry[] | undefined>(undefined);

  const persist = useCallback(async (id: string | null) => {
    generation.current += 1;
    const operation = generation.current;
    const epoch = currentAuthEpoch();
    setState(current => ({ ...current, isSaving: true }));
    let error: 'save' | null = null;
    try {
      // Serialized per selection and fenced after the queue settles: only the
      // selection the provider still publishes is written, in the order the
      // selections were made.
      await chainSave(SELECTION_QUEUE_KEY, async () => {
        if (generation.current !== operation || !isCurrentAuthEpoch(epoch)) {
          return;
        }
        await setAccountMetadata(ORGANIZATION_STORAGE_KEY, encodeSelection(id));
        if (generation.current !== operation || !isCurrentAuthEpoch(epoch)) {
          return;
        }
        // The account stores one selection value; this legacy key is cleared so
        // only that value answers which account is selected. A failed delete is
        // reported by the storage layer and retried by the next selection; it
        // must not turn a stored selection into a save error.
        try {
          await deleteAccountMetadata(ORGANIZATION_PERSONAL_STORAGE_KEY);
        } catch {
          // Cleanup only: the selection value is already stored.
        }
      });
    } catch {
      error = 'save';
    }
    if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
      setState(current => ({ ...current, error, isSaving: false }));
    }
  }, []);

  const restore = useCallback(async () => {
    generation.current += 1;
    const operation = generation.current;
    const epoch = currentAuthEpoch();
    awaitingDefault.current = false;
    defaultFence.current = null;
    recoveringRef.current = undefined;
    selectionListSeen.current = undefined;
    setState(current => ({ ...current, token, isLoaded: false, isSaving: false, error: null }));
    try {
      // A stored value is the whole selection: an organization id or the
      // Personal choice. It is one key, so the read is already atomic and needs
      // no queue; chaining it would let a slow keychain read hold up the saves
      // behind it. An absent value is 'not chosen yet' unless the legacy marker
      // is still present, which the fold below replaces with the value itself.
      // The marker is read only when nothing is stored, so a marker-read
      // failure cannot discard a stored selection, and a value a save lands
      // meanwhile replaces this read through the fence below.
      const stored = await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
      const personalMarker =
        stored === null ? await SecureStore.getItemAsync(ORGANIZATION_PERSONAL_STORAGE_KEY) : null;
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        if (stored) {
          const selected = decodeSelection(stored);
          activeId.current = selected;
          personalExplicit.current = selected === null;
          setState({
            token,
            organizationId: selected,
            isLoaded: true,
            isSaving: false,
            error: null,
          });
        } else if (personalMarker === PERSONAL_SELECTION) {
          activeId.current = null;
          personalExplicit.current = true;
          setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: null });
          // Record the choice as the selection value so one value answers it
          // from the next launch on.
          void persist(null);
        } else {
          personalExplicit.current = false;
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
  }, [token, persist]);

  // Publish the default organization once the shared list has settled. Fenced
  // by the generation and auth epoch captured in `restore()`, so a sign-out or
  // a newer sign-in during the fetch publishes nothing stale.
  useEffect(() => {
    if (!awaitingDefault.current) {
      return;
    }
    const fence = defaultFence.current;
    if (generation.current !== fence?.operation || !isCurrentAuthEpoch(fence.epoch)) {
      awaitingDefault.current = false;
      defaultFence.current = null;
      return;
    }
    // A paused list is offline and may never fetch. Waiting on it would leave
    // `isLoaded` false forever, so publish Personal to keep the app usable, and
    // keep `awaitingDefault` set: the default still applies when the list
    // arrives. Only reached when nothing explicit was stored, so this never
    // overrides a stored choice.
    if (!organizationsFetched && organizationsPaused) {
      if (!state.isLoaded) {
        activeId.current = null;
        setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: null });
      }
      return;
    }
    // A refetch of an already-failed list must settle before it republishes.
    if (!organizationsFetched || organizationsFetching) {
      return;
    }
    awaitingDefault.current = false;
    defaultFence.current = null;
    if (organizationsError) {
      activeId.current = null;
      personalExplicit.current = false;
      setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: 'restore' });
      return;
    }
    const defaultId = organizations?.[0]?.organizationId ?? null;
    activeId.current = defaultId;
    personalExplicit.current = false;
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
    organizationsPaused,
    token,
    persist,
  ]);

  // Detection: a settled, successful snapshot that does not name the stored
  // organization arms the recovery effect (declared below `setOrganizationId`,
  // which it calls). A restored selection has no baseline of its own, so its
  // very first snapshot is evaluated: a cold start whose fetched list already
  // omits the stored organization switches instead of rendering the dead
  // selection with a generic credits name and a failed balance. A snapshot
  // that names the selection records the baseline; from there, any later
  // snapshot missing it means the membership vanished while the app ran.
  // Personal (null) and the default resolution (above) need no detection. The
  // baseline is recorded only after the guards pass, so a snapshot observed
  // during an error is re-evaluated once the error clears.
  useEffect(() => {
    if (!state.isLoaded || !organizationsFetched || organizationsError) {
      selectionListSeen.current = undefined;
      return;
    }
    if (organizationsFetching || state.error !== null || state.organizationId === null) {
      return;
    }
    const snapshot = organizations ?? [];
    if (snapshot === selectionListSeen.current) {
      return;
    }
    if (snapshot.some(entry => entry.organizationId === state.organizationId)) {
      selectionListSeen.current = snapshot;
      return;
    }
    recoveringRef.current = snapshot[0]?.organizationId ?? null;
  }, [
    state.isLoaded,
    state.error,
    state.organizationId,
    organizations,
    organizationsFetched,
    organizationsFetching,
    organizationsError,
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
      personalExplicit.current = false;
      recoveringRef.current = undefined;
      selectionListSeen.current = undefined;
      setState({ token, organizationId: null, isLoaded: true, isSaving: false, error: null });
    }
    return () => {
      generation.current += 1;
    };
  }, [token, restore]);

  const setOrganizationId = useCallback(
    (id: string | null) => {
      // A manual selection disarms the recovery switch: the user moved first,
      // and the snapshot it was made against becomes the selection's baseline
      // (the picker only offers organizations from that snapshot).
      recoveringRef.current = undefined;
      selectionListSeen.current = organizations;
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
        // An auto-resolved Personal is not an explicit choice yet. Write the
        // marker so the choice survives the next launch, but skip the terminal
        // blank above for the same publisher reason.
        if (id === null && !personalExplicit.current) {
          personalExplicit.current = true;
          void persist(null);
        }
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
      personalExplicit.current = id === null;
      setState(current => ({
        token,
        organizationId: id,
        isLoaded: true,
        isSaving: true,
        error: current.token === token && current.error === 'save' ? 'save' : null,
      }));
      void persist(id);
    },
    [token, persist, state.organizationId, organizations]
  );

  // A stored selection can go stale server-side: the host removes the
  // membership (or deletes the organization) while the app still holds the id.
  // Once a settled, successful list misses the selection, switch to the same
  // target the default resolution would pick — the first remaining membership,
  // else Personal — through the existing selection path, and say so.
  useEffect(() => {
    if (recoveringRef.current === undefined) {
      // No stale selection detected; `setOrganizationId` owns the toast.
      return;
    }
    // A failed or still-fetching list cannot decide the target; the stale
    // selection stays armed for the next settled, successful list.
    if (
      state.error !== null ||
      !organizationsFetched ||
      organizationsFetching ||
      organizationsError
    ) {
      return;
    }
    const target = recoveringRef.current;
    recoveringRef.current = undefined;
    if (target !== state.organizationId) {
      setOrganizationId(target);
      announcingToast.warning(
        i18n.t('organization.boundary.membershipLostNotice', {
          target:
            target === null
              ? i18n.t('common.personal')
              : (organizations?.find(entry => entry.organizationId === target)?.organizationName ??
                i18n.t('common.organization')),
        })
      );
    }
  }, [
    state.organizationId,
    state.error,
    organizations,
    organizationsFetched,
    organizationsFetching,
    organizationsError,
    setOrganizationId,
  ]);

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
