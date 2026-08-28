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
import { writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import {
  type AuthenticatedOwner,
  type ContextScope,
  contextScope,
  isAuthenticatedOwner,
  isContextUnavailableError,
  parseSelectedContext,
  selectedContextStorageKey,
  serializeSelectedContext,
} from '@/lib/context-scope';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { chainSave } from '@/lib/hooks/save-chain';
import { setLocalAccessContextReady } from '@/lib/local-access';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

type ContextState =
  | Readonly<{
      status: 'unresolved';
      reason: 'identity' | 'storage' | 'membership' | 'selection-required';
    }>
  | Readonly<{ status: 'ready'; context: ContextScope }>
  | Readonly<{ status: 'failed'; reason: 'identity' | 'storage' | 'membership' | 'write' }>
  | Readonly<{
      status: 'unavailable';
      reason: 'malformed' | 'owner-mismatch' | 'membership-revoked';
    }>;

type OrganizationContextValue = {
  /** null means Personal only when isReady is true. */
  organizationId: string | null;
  isLoaded: boolean;
  isReady: boolean;
  status: ContextState['status'];
  reason: Exclude<ContextState, { status: 'ready' }>['reason'] | null;
  context: ContextScope | null;
  owner: AuthenticatedOwner;
  selectionGeneration: number;
  legacyOrganizationId: string | null;
  setOrganizationId: (id: string | null) => void;
  selectLegacyOrganization: () => void;
  retry: () => void;
};
const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);
const unresolved: ContextState = { status: 'unresolved', reason: 'identity' };

type SelectionRequest = { kind: 'restore' } | { kind: 'select'; organizationId: string | null };

export function OrganizationProvider({ children }: { readonly children: ReactNode }) {
  const { token, isSigningOut } = useAuth();
  const identity = useCurrentUserId();
  const { userId, owner } = identity;
  const ownerKey = JSON.stringify([owner.authEpoch, owner.generation, userId]);
  const generation = useRef(0);
  const activeOwnerKey = useRef(ownerKey);
  if (activeOwnerKey.current !== ownerKey) {
    activeOwnerKey.current = ownerKey;
    generation.current += 1;
  }
  const [storedState, setStoredState] = useState<{
    ownerKey: string;
    state: ContextState;
    legacy: string | null;
  }>({
    ownerKey,
    state: unresolved,
    legacy: null,
  });
  const lastRequest = useRef<SelectionRequest>({ kind: 'restore' });
  const state = storedState.ownerKey === ownerKey ? storedState.state : unresolved;
  const legacyOrganizationId = storedState.ownerKey === ownerKey ? storedState.legacy : null;

  const resolve = useCallback(
    async (request: SelectionRequest) => {
      if (!token || isSigningOut || !userId || !isAuthenticatedOwner(owner)) {
        return;
      }
      lastRequest.current = request;
      generation.current += 1;
      const selection = generation.current;
      const isCurrent = () =>
        isAuthenticatedOwner(owner) &&
        generation.current === selection &&
        activeOwnerKey.current === ownerKey;
      const publish = (next: ContextState, legacy: string | null = null) => {
        if (isCurrent()) {
          setStoredState({ ownerKey, state: next, legacy });
          setLocalAccessContextReady(next.status === 'ready');
        }
      };
      publish({ status: 'unresolved', reason: 'storage' });
      const key = selectedContextStorageKey(userId);
      let phase: 'storage' | 'membership' | 'write' = 'storage';
      try {
        let selected: ContextScope = contextScope(null);
        if (request.kind === 'restore') {
          const bytes = await chainSave(key, async () => {
            const stored = await SecureStore.getItemAsync(key);
            return stored;
          });
          if (!isCurrent()) {
            return;
          }
          const saved = parseSelectedContext(bytes, userId);
          if (saved.status === 'malformed' || saved.status === 'owner-mismatch') {
            publish({ status: 'unavailable', reason: saved.status });
            return;
          }
          if (saved.status === 'absent') {
            // Legacy fallback is a candidate only. Remove this read after all legacy selections migrate.
            const legacy = await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
            if (!isCurrent()) {
              return;
            }
            if (legacy) {
              publish({ status: 'unresolved', reason: 'selection-required' }, legacy);
              return;
            }
            selected = contextScope(null);
          } else {
            selected = saved.context;
          }
        } else {
          selected = contextScope(request.organizationId);
        }
        if (selected.kind === 'organization') {
          phase = 'membership';
          publish({ status: 'unresolved', reason: 'membership' });
          // Do not use a cached membership as proof, even when it belongs to this user.
          const organizationId = selected.organizationId;
          const organizations = await trpcClient.organizations.list.query();
          if (!isCurrent()) {
            return;
          }
          if (!organizations.some(org => org.organizationId === organizationId)) {
            publish({ status: 'unavailable', reason: 'membership-revoked' });
            return;
          }
        }
        if (request.kind === 'select') {
          phase = 'write';
          await writeAccountMetadata(
            key,
            async () => {
              await SecureStore.setItemAsync(key, serializeSelectedContext(userId, selected));
            },
            isCurrent
          );
        }
        publish({ status: 'ready', context: selected });
      } catch (error) {
        publish(
          phase === 'membership' && isContextUnavailableError(error)
            ? { status: 'unavailable', reason: 'membership-revoked' }
            : { status: 'failed', reason: phase }
        );
      }
    },
    [token, isSigningOut, userId, owner, ownerKey]
  );

  useEffect(() => {
    void resolve({ kind: 'restore' });
    return () => {
      generation.current += 1;
    };
  }, [resolve]);

  const setOrganizationId = useCallback(
    (id: string | null) => {
      void resolve({ kind: 'select', organizationId: id });
    },
    [resolve]
  );
  const retry = useCallback(() => {
    if (identity.isError) {
      identity.refetch();
    } else if (state.status === 'failed') {
      void resolve(lastRequest.current);
    }
  }, [identity, state.status, resolve]);
  const selectLegacyOrganization = useCallback(() => {
    if (legacyOrganizationId !== null) {
      setOrganizationId(legacyOrganizationId);
    }
  }, [legacyOrganizationId, setOrganizationId]);
  const visibleState = useMemo<ContextState>(() => {
    if (!token || isSigningOut || !userId || !isAuthenticatedOwner(owner)) {
      return identity.isError ? { status: 'failed', reason: 'identity' } : unresolved;
    }
    return state;
  }, [token, isSigningOut, userId, owner, identity.isError, state]);
  const context = visibleState.status === 'ready' ? visibleState.context : null;
  const value = useMemo<OrganizationContextValue>(
    () => ({
      organizationId: context?.kind === 'organization' ? context.organizationId : null,
      isLoaded: visibleState.status === 'ready',
      isReady: visibleState.status === 'ready',
      status: visibleState.status,
      reason: visibleState.status === 'ready' ? null : visibleState.reason,
      context,
      owner,
      selectionGeneration: generation.current,
      legacyOrganizationId,
      setOrganizationId,
      selectLegacyOrganization,
      retry,
    }),
    [
      context,
      visibleState,
      owner,
      legacyOrganizationId,
      setOrganizationId,
      selectLegacyOrganization,
      retry,
    ]
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
