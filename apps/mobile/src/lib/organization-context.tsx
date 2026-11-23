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

/**
 * One queue slot for the whole selection: a save runs after the previous save
 * settled, so the two keys above are written as one pair and in the order the
 * selections were made, and the stored pair always names the selection the
 * provider publishes.
 */
const SELECTION_QUEUE_KEY = 'organization-selection';

/**
 * One phase per published selection. The stored pair is read before the
 * organization list answers, so a restored organization is NOT yet a selection
 * the app may load or report a failure for: only a settled list, or the person,
 * decides one. Keeping the phases apart is what stops a membership that no
 * longer exists from painting an error while the list is still in flight.
 */
export type OrganizationSelection =
  /** No account is signed in; nothing is stored and nothing is pending. */
  | { readonly status: 'signed-out' }
  /** The stored pair is being read; nothing is decided yet. */
  | { readonly status: 'reading' }
  /**
   * Nothing explicit is stored and the stored value was 'not chosen yet', so
   * the first settled list publishes the default. The fence names the restore
   * that owns it: a newer restore, a sign-out, or a selection supersedes it.
   */
  | {
      readonly status: 'awaiting-default';
      readonly fence: { readonly operation: number; readonly epoch: number };
    }
  /**
   * The organization the stored pair named, published before any settled list
   * confirmed it. Nothing may load it or report an error for it: a settled list
   * that names it promotes this phase to `organization`, and one that misses it
   * switches to the target the default rule would pick.
   */
  | { readonly status: 'restored'; readonly organizationId: string }
  /**
   * The stored organization could not be validated because the membership list
   * failed. Its id is kept — a failed read is not an answer about the
   * membership — and the surfaces read the list's own failure and Retry. The
   * next successful list promotes or recovers it.
   */
  | { readonly status: 'restored-unverified'; readonly organizationId: string }
  /** An organization the person chose, or a settled list confirmed. */
  | { readonly status: 'organization'; readonly organizationId: string }
  /** Personal, resolved from an empty list or a failed restore: not a choice yet. */
  | { readonly status: 'personal-defaulted' }
  /** Personal, the person's own choice; its marker is stored. */
  | { readonly status: 'personal-chosen' };

/** Every phase, so a new one fails the exhaustive checks below instead of silently reading as Personal. */
function assertSelectionHandled(selection: never): never {
  throw new Error(`unhandled organization selection: ${JSON.stringify(selection)}`);
}

/** The organization id the selection publishes; null for every Personal or unresolved phase. */
function publishedOrganizationId(selection: OrganizationSelection): string | null {
  switch (selection.status) {
    case 'restored':
    case 'restored-unverified':
    case 'organization': {
      return selection.organizationId;
    }
    case 'signed-out':
    case 'reading':
    case 'awaiting-default':
    case 'personal-defaulted':
    case 'personal-chosen': {
      return null;
    }
    default: {
      return assertSelectionHandled(selection);
    }
  }
}

/** Whether the app may load the selection: the person chose it, or a settled list confirmed it. */
function isSelectionSettled(selection: OrganizationSelection): boolean {
  switch (selection.status) {
    case 'signed-out':
    case 'restored-unverified':
    case 'organization':
    case 'personal-chosen':
    case 'personal-defaulted': {
      return true;
    }
    case 'reading':
    case 'awaiting-default':
    case 'restored': {
      return false;
    }
    default: {
      return assertSelectionHandled(selection);
    }
  }
}

/**
 * The provider's published contract: the selection phase, the id it publishes,
 * whether it may be loaded, and the stored-choice operations.
 */
export type OrganizationContextValue = {
  /** The phase the selection is in. Consumers that tell a pending selection from a settled one read this. */
  selection: OrganizationSelection;
  organizationId: string | null;
  isLoaded: boolean;
  isSaving: boolean;
  setOrganizationId: (id: string | null) => void;
  error: 'restore' | 'save' | null;
  retry: () => void;
};

type OrganizationState = Pick<OrganizationContextValue, 'selection' | 'isSaving' | 'error'> & {
  token: string | undefined;
};

const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { readonly children: ReactNode }) {
  const { token } = useAuth();
  const {
    data: organizations,
    isFetched: organizationsFetched,
    isFetchedAfterMount: organizationsFetchedAfterMount,
    isFetching: organizationsFetching,
    isError: organizationsError,
    refetch: refetchOrganizations,
  } = useOrganizationsList();
  const [state, setState] = useState<OrganizationState>({
    token,
    selection: { status: 'reading' },
    isSaving: false,
    error: null,
  });
  // A membership list restored from the encrypted read cache describes a
  // previous run, so a restored selection it cannot confirm waits for the server
  // instead of a cached answer. The query's own default `staleTime` would skip
  // that read, leaving the selection pending with nothing to settle it: ask for
  // the answer this restore owes. One request per stored id, so the effect that
  // asks cannot loop on its own resubmission.
  const confirmationAsked = useRef<string | null>(null);
  const generation = useRef(0);
  // Orders the stored pair's writers: a newer selection, a sign-out, or an
  // account switch supersedes an in-flight save. `restore` deliberately does
  // not bump it: a token rotation re-runs `restore` for the same account, and
  // that must not cancel the save of a selection the user just made.
  const saveGeneration = useRef(0);
  // Settles when the last scheduled save has settled. A restore reads the pair
  // a save that began before it left behind, instead of a half-written one.
  const savesSettled = useRef<Promise<void>>(Promise.resolve());
  const activeId = useRef<string | null>(null);
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

  const restore = useCallback(async () => {
    generation.current += 1;
    const operation = generation.current;
    const epoch = currentAuthEpoch();
    recoveringRef.current = undefined;
    selectionListSeen.current = undefined;
    confirmationAsked.current = null;
    setState(current => ({
      ...current,
      token,
      selection: { status: 'reading' },
      isSaving: false,
      error: null,
    }));
    try {
      // A stored organization is an explicit choice; the marker beside it is an
      // explicit Personal choice. An absent value is 'not chosen yet': the
      // organization list decides the default and the effect below publishes it.
      // A legacy absent value is treated the same way. A save that began before
      // this restore owns the pair until it settles, so it is awaited first; a
      // save that begins later supersedes this restore (it bumps `generation`),
      // so the reads below are discarded rather than published half-written.
      // The two reads are kept apart: a stored organization stands alone, so a
      // marker-read failure must not discard it. The marker is only consulted
      // when no organization is stored, and a failure there stays a restore
      // error — the selection is then genuinely undetermined.
      await savesSettled.current;
      const stored = await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
      const marker =
        stored === null ? await SecureStore.getItemAsync(ORGANIZATION_PERSONAL_STORAGE_KEY) : null;
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        if (stored) {
          activeId.current = stored;
          // The list has not confirmed this membership yet, so it publishes as
          // `restored`: the consumers keep it pending instead of loading it.
          setState({
            token,
            selection: { status: 'restored', organizationId: stored },
            isSaving: false,
            error: null,
          });
        } else if (marker === PERSONAL_MARKER) {
          activeId.current = null;
          setState({
            token,
            selection: { status: 'personal-chosen' },
            isSaving: false,
            error: null,
          });
        } else {
          // Never publish Personal here: an empty list, not this branch, is what
          // means Personal. The settled list publishes the default.
          setState({
            token,
            selection: { status: 'awaiting-default', fence: { operation, epoch } },
            isSaving: false,
            error: null,
          });
        }
      }
    } catch {
      if (generation.current === operation && isCurrentAuthEpoch(epoch)) {
        setState(current => ({ ...current, error: 'restore' }));
      }
    }
  }, [token]);

  const persist = useCallback(async (id: string | null) => {
    // A selection supersedes any restore still deciding what to publish.
    generation.current += 1;
    saveGeneration.current += 1;
    const save = saveGeneration.current;
    const epoch = currentAuthEpoch();
    setState(current => ({ ...current, isSaving: true }));
    let error: 'save' | null = null;
    // Registered before the first await, so a restore that starts now waits for
    // this whole pair: it reads what the save leaves behind, never a key of it.
    const writes = chainSave(SELECTION_QUEUE_KEY, async () => {
      // Only the selection the provider still publishes is written: a newer
      // selection, a sign-in, or a sign-out owns the stored state, and its
      // own save (or the sign-out cleanup, whose deletes chain behind these
      // keys) writes the pair this save would have written. A restore does
      // not own the pair: it reads it after this save settles.
      if (saveGeneration.current !== save || !isCurrentAuthEpoch(epoch)) {
        return;
      }
      // Keep the pair ordered with saves, but stop between keys if a new
      // selection or auth epoch supersedes this one. Its queued save, or
      // sign-out cleanup, owns the remaining storage update.
      await (id
        ? setAccountMetadata(ORGANIZATION_STORAGE_KEY, id)
        : deleteAccountMetadata(ORGANIZATION_STORAGE_KEY));
      if (saveGeneration.current !== save || !isCurrentAuthEpoch(epoch)) {
        return;
      }
      await (id
        ? deleteAccountMetadata(ORGANIZATION_PERSONAL_STORAGE_KEY)
        : setAccountMetadata(ORGANIZATION_PERSONAL_STORAGE_KEY, PERSONAL_MARKER));
    });
    // A restore only needs the pair to have settled, so its own rejection is
    // swallowed here; this save reports the failure in its state below.
    savesSettled.current = (async () => {
      try {
        await writes;
      } catch {
        // Reported by this save's own `error` state.
      }
    })();
    try {
      await writes;
    } catch {
      error = 'save';
    }
    if (saveGeneration.current === save && isCurrentAuthEpoch(epoch)) {
      setState(current => ({ ...current, error, isSaving: false }));
    }
  }, []);

  // Publish the default organization once the shared list has settled. Fenced
  // by the generation and auth epoch captured in `restore()`, so a sign-out or
  // a newer sign-in during the fetch publishes nothing stale.
  useEffect(() => {
    if (state.selection.status !== 'awaiting-default') {
      return;
    }
    const fence = state.selection.fence;
    if (generation.current !== fence.operation || !isCurrentAuthEpoch(fence.epoch)) {
      return;
    }
    // The list read settles while offline too (`SETTLE_WHILE_OFFLINE`): it
    // either answers or fails by its deadline, so the default below always has
    // a settled snapshot to act on — there is no paused fallback to wait out.
    // A refetch of an already-failed list must settle before it republishes.
    if (!organizationsFetched || organizationsFetching) {
      return;
    }
    if (organizationsError) {
      activeId.current = null;
      setState({
        token,
        selection: { status: 'personal-defaulted' },
        isSaving: false,
        error: 'restore',
      });
      return;
    }
    const defaultId = organizations?.[0]?.organizationId ?? null;
    activeId.current = defaultId;
    setState({
      token,
      selection: defaultId
        ? { status: 'organization', organizationId: defaultId }
        : { status: 'personal-defaulted' },
      isSaving: false,
      error: null,
    });
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
    state.selection,
    organizations,
    organizationsFetched,
    organizationsFetching,
    organizationsError,
    token,
    persist,
  ]);

  // Settlement of a restored selection. Until the server answers, the restored
  // organization is NOT loaded: the consumers keep it pending, which is what a
  // deleted membership needs instead of an error card while the list is still
  // in flight. A list snapshot restored from the encrypted read cache is
  // `isFetched` but names a previous run's memberships, so it cannot confirm
  // (nor rule out) this membership: only a read that answered after this mount
  // can. That answer promotes the selection; a failure publishes the id it
  // could not verify, because a failed read is not an answer about the
  // membership and the surfaces own that failure and its Retry.
  useEffect(() => {
    const selection = state.selection;
    if (selection.status !== 'restored' && selection.status !== 'restored-unverified') {
      return;
    }
    const storedId = selection.organizationId;
    if (!organizationsFetchedAfterMount) {
      if (!organizationsFetching && confirmationAsked.current !== storedId) {
        confirmationAsked.current = storedId;
        void refetchOrganizations();
      }
      return;
    }
    if (organizationsFetching) {
      return;
    }
    if (organizationsError) {
      if (selection.status === 'restored') {
        setState(current =>
          current.selection.status === 'restored' && current.selection.organizationId === storedId
            ? {
                ...current,
                selection: { status: 'restored-unverified', organizationId: storedId },
              }
            : current
        );
      }
      return;
    }
    if (!(organizations ?? []).some(entry => entry.organizationId === storedId)) {
      return;
    }
    setState(current =>
      (current.selection.status === 'restored' ||
        current.selection.status === 'restored-unverified') &&
      current.selection.organizationId === storedId
        ? { ...current, selection: { status: 'organization', organizationId: storedId } }
        : current
    );
  }, [
    state.selection,
    organizations,
    organizationsFetchedAfterMount,
    organizationsFetching,
    organizationsError,
    refetchOrganizations,
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
  // Only an answer that arrived after this mount may judge a membership: a
  // snapshot restored from the encrypted read cache describes a previous run,
  // and switching on it would move the person off a membership the server
  // still serves.
  useEffect(() => {
    const organizationId = publishedOrganizationId(state.selection);
    if (organizationId === null || !organizationsFetchedAfterMount || organizationsError) {
      selectionListSeen.current = undefined;
      return;
    }
    if (organizationsFetching || state.error !== null) {
      return;
    }
    const snapshot = organizations ?? [];
    if (snapshot === selectionListSeen.current) {
      return;
    }
    if (snapshot.some(entry => entry.organizationId === organizationId)) {
      selectionListSeen.current = snapshot;
      return;
    }
    recoveringRef.current = snapshot[0]?.organizationId ?? null;
  }, [
    state.selection,
    state.error,
    organizations,
    organizationsFetchedAfterMount,
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
      // A signed-out account owns no stored selection: a save still in flight
      // must not write the pair after the sign-out cleanup deleted it.
      saveGeneration.current += 1;
      activeId.current = null;
      recoveringRef.current = undefined;
      selectionListSeen.current = undefined;
      confirmationAsked.current = null;
      // Signed out: no account owns a selection, so nothing is pending and no
      // marker is involved. Personal is what the app shows.
      setState({ token, selection: { status: 'signed-out' }, isSaving: false, error: null });
    }
    return () => {
      // A token change cancels the previous restore's publication, not a save:
      // a rotation is the same account, and its save must still land.
      generation.current += 1;
    };
  }, [token, restore]);

  const setOrganizationId = useCallback(
    (id: string | null) => {
      const selection = state.selection;
      const publishedId = publishedOrganizationId(selection);
      // A manual selection disarms the recovery switch: the user moved first,
      // and the snapshot it was made against becomes the selection's baseline
      // (the picker only offers organizations from that snapshot).
      recoveringRef.current = undefined;
      selectionListSeen.current = organizations;
      // An explicit selection always settles a pending default, even when it
      // matches the placeholder published while waiting; otherwise the default
      // would publish later and override the user's choice.
      const settlingDefault = selection.status === 'awaiting-default';
      // A same-value selection is a no-op: blanking it would bump the terminal
      // epoch and permanently gate the publisher, because React bails out of the
      // state update and no effect re-runs to rebuild it.
      if (id === publishedId && !settlingDefault) {
        // The stored pair already names this organization, and the person just
        // picked it: that confirms it without a write.
        if (selection.status === 'restored') {
          setState(current =>
            current.selection.status === 'restored' && current.selection.organizationId === id
              ? { ...current, selection: { status: 'organization', organizationId: id } }
              : current
          );
          return;
        }
        // An auto-resolved Personal is not an explicit choice yet. Write the
        // marker so the choice survives the next launch, but skip the terminal
        // blank above for the same publisher reason. A signed-out reader has no
        // stored selection to mark, so only the phase changes there.
        if (id === null && selection.status === 'personal-defaulted') {
          setState(current =>
            current.selection.status === 'personal-defaulted'
              ? { ...current, selection: { status: 'personal-chosen' } }
              : current
          );
          void persist(null);
          return;
        }
        // Nothing is chosen yet (the stored pair is still being read): the
        // choice settles now, and its save supersedes the restore.
        if (id === null && selection.status === 'reading') {
          setState(current => ({
            ...current,
            selection: { status: 'personal-chosen' },
            isSaving: true,
            error: null,
          }));
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
      setState(current => ({
        token,
        selection:
          id === null
            ? { status: 'personal-chosen' }
            : { status: 'organization', organizationId: id },
        isSaving: true,
        error: current.token === token && current.error === 'save' ? 'save' : null,
      }));
      void persist(id);
    },
    [token, persist, state.selection, organizations]
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
    const publishedId = publishedOrganizationId(state.selection);
    recoveringRef.current = undefined;
    if (target !== publishedId) {
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
    state.selection,
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
    // A failed list leaves a restored selection unverified: nothing else in the
    // provider will re-ask, and the surfaces show the list's failure with this
    // Retry, so the provider asks again for the id it could not confirm.
    if (state.selection.status === 'restored-unverified') {
      confirmationAsked.current = null;
      void refetchOrganizations();
      return;
    }
    if (state.error === 'restore') {
      void retryRestore();
    } else if (state.error === 'save') {
      void persist(activeId.current);
    }
  }, [state.selection, state.error, retryRestore, persist, refetchOrganizations]);

  const value = useMemo<OrganizationContextValue>(() => {
    // A new token must not publish the prior phase before its effect runs: the
    // previous account's settled selection is not this account's.
    const ownPhase = state.token === token;
    const selection: OrganizationSelection = ownPhase ? state.selection : { status: 'reading' };
    return {
      selection,
      organizationId: publishedOrganizationId(selection),
      isLoaded: isSelectionSettled(selection),
      isSaving: ownPhase && state.isSaving,
      error: ownPhase ? state.error : null,
      setOrganizationId,
      retry,
    };
  }, [state, token, setOrganizationId, retry]);

  return <OrganizationContext value={value}>{children}</OrganizationContext>;
}

export function useOrganization(): OrganizationContextValue {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
}
