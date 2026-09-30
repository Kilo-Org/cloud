import { type RemoteModelState } from '@kilocode/cloud-agent-sdk';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/** The session kinds whose model catalog is discovered remotely. */
export type RemoteModelCatalogRetrySessionType = 'remote' | 'cloud-agent' | 'read-only' | null;

type RemoteModelCatalogRetryManager = {
  retryRemoteModels: () => void;
};

export type RemoteModelCatalogRetryInput = {
  activeSessionType: RemoteModelCatalogRetrySessionType;
  remoteModelState: Pick<RemoteModelState, 'catalog' | 'ownerConnectionId' | 'refresh'>;
  manager: RemoteModelCatalogRetryManager;
};

/**
 * Whether a remote session's model catalog is still worth another retry.
 *
 * The retry is only useful once the CLI owner is known (a request before then
 * is dropped by the transport), is not already in flight (`loading`), and the
 * catalog is absent, empty, or last reported an error. A populated catalog with
 * an idle refresh needs nothing.
 */
export function shouldRetryRemoteModelCatalog(input: {
  activeSessionType: RemoteModelCatalogRetrySessionType;
  ownerConnectionId: string | null;
  refresh: RemoteModelState['refresh'];
  /** Models across the catalog, not providers: a provider may hold none. */
  modelCount: number;
}): boolean {
  if (input.activeSessionType !== 'remote') {
    return false;
  }
  if (input.ownerConnectionId === null) {
    return false;
  }
  if (input.refresh === 'loading') {
    return false;
  }
  return input.refresh === 'error' || input.modelCount === 0;
}

/**
 * Nudge the remote model discovery whenever an attach, a focus regain, or an
 * app-foreground transition happens while this session's catalog is missing,
 * empty, or failed.
 *
 * Every trigger is an event, never a timer and never a heartbeat: `discoverModels`
 * already collapses duplicate calls per owner, so a retry storm cannot form.
 * The attach path fires at most once per owner connection, so a retry that ends
 * in an error is retried again only by a later focus/foreground event rather
 * than on every catalog publish.
 */
export function useRemoteModelCatalogRetry({
  activeSessionType,
  manager,
  remoteModelState,
}: RemoteModelCatalogRetryInput): void {
  const ownerConnectionId = remoteModelState.ownerConnectionId;
  const refresh = remoteModelState.refresh;
  const modelCount =
    remoteModelState.catalog?.providers.reduce(
      (total, provider) => total + provider.models.length,
      0
    ) ?? 0;

  // Latest inputs for the event callbacks, so the AppState subscription keeps
  // one identity and never re-subscribes on a catalog publish.
  const latestRef = useRef({
    activeSessionType,
    manager,
    ownerConnectionId,
    modelCount,
    refresh,
  });
  latestRef.current = { activeSessionType, manager, ownerConnectionId, modelCount, refresh };

  const retryIfEligible = useCallback(() => {
    const latest = latestRef.current;
    if (
      !shouldRetryRemoteModelCatalog({
        activeSessionType: latest.activeSessionType,
        ownerConnectionId: latest.ownerConnectionId,
        refresh: latest.refresh,
        modelCount: latest.modelCount,
      })
    ) {
      return;
    }
    latest.manager.retryRemoteModels();
  }, []);

  // Attach: one attempt per owner connection. The latch keeps a failed retry
  // from re-firing on every catalog publish; a new owner re-arms it.
  const attachOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !shouldRetryRemoteModelCatalog({
        activeSessionType,
        ownerConnectionId,
        refresh,
        modelCount,
      })
    ) {
      return;
    }
    if (attachOwnerRef.current === ownerConnectionId) {
      return;
    }
    attachOwnerRef.current = ownerConnectionId;
    manager.retryRemoteModels();
  }, [activeSessionType, manager, ownerConnectionId, modelCount, refresh]);

  // App foreground: one attempt on every false -> active transition while the
  // screen's inputs still say the catalog needs it.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        retryIfEligible();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [retryIfEligible]);

  // Focus: one attempt each time the screen regains focus.
  useFocusEffect(
    useCallback(() => {
      retryIfEligible();
    }, [retryIfEligible])
  );
}
