import { useCallback, useSyncExternalStore } from 'react';

/**
 * Code reviewer analytics filters, kept per organization.
 *
 * The period and the platform are a client-side choice, so they must not depend
 * on a request: the store is in-memory and keyed by the analytics route's
 * scope, which is the organization id. The choice is per organization because
 * platform analytics is enabled per organization, so the same reviewer looks at
 * GitHub in one organization and GitLab in another. The store lives at module
 * scope so leaving the screen and reopening it keeps the selection.
 *
 * Nothing is persisted: a relaunch starts every organization from
 * {@link DEFAULT_SELECTION}, and the account boundary clears the map with the
 * other session-scoped stores, so the next account never opens an organization
 * on the previous account's choice.
 */

export type CodeReviewerAnalyticsPeriod = 7 | 30 | 90;

export type CodeReviewerAnalyticsPlatform = 'github' | 'gitlab';

/** One organization's analytics filters, as the screen reads them. */
export type CodeReviewerAnalyticsSelection = {
  readonly platform: CodeReviewerAnalyticsPlatform;
  readonly period: CodeReviewerAnalyticsPeriod;
};

/**
 * What an organization with no entry reads. One frozen object, returned by
 * identity, because `useSyncExternalStore` compares snapshots by identity and a
 * fresh default per read would re-render on every store check.
 */
const DEFAULT_SELECTION: CodeReviewerAnalyticsSelection = Object.freeze({
  platform: 'github',
  period: 30,
});

/** Organizations whose filters differ from the default. */
const selectionByScope = new Map<string, CodeReviewerAnalyticsSelection>();

/** Per-organization listener sets. A scope gets an entry only while subscribed. */
const listenersByScope = new Map<string, Set<() => void>>();

/** This organization's filters, or the shared default when it has no entry. */
export function getCodeReviewerAnalyticsSelection(scope: string): CodeReviewerAnalyticsSelection {
  return selectionByScope.get(scope) ?? DEFAULT_SELECTION;
}

/** Choose one organization's analytics platform, keeping its period. */
export function setCodeReviewerAnalyticsPlatform(
  scope: string,
  platform: CodeReviewerAnalyticsPlatform
): void {
  setSelection(scope, { ...getCodeReviewerAnalyticsSelection(scope), platform });
}

/** Choose one organization's analytics period, keeping its platform. */
export function setCodeReviewerAnalyticsPeriod(
  scope: string,
  period: CodeReviewerAnalyticsPeriod
): void {
  setSelection(scope, { ...getCodeReviewerAnalyticsSelection(scope), period });
}

/**
 * Drop every organization's filters on sign-out or account switch, so the next
 * account starts from the default and the module-scope map cannot carry a prior
 * account's choice forward. It notifies the organizations still mounted (their
 * segmented controls re-render on the default) and is synchronous, like the
 * other session-scoped clears in `@/lib/auth/session-scoped-state`.
 */
export function clearCodeReviewerAnalyticsFilters(): void {
  if (selectionByScope.size === 0) {
    return;
  }
  const scopes = [...selectionByScope.keys()];
  selectionByScope.clear();
  for (const scope of scopes) {
    notifyScope(scope);
  }
}

/** Subscribe to one organization's filters. The returned function unsubscribes. */
export function subscribeCodeReviewerAnalyticsFilters(
  scope: string,
  listener: () => void
): () => void {
  let listeners = listenersByScope.get(scope);
  if (listeners === undefined) {
    listeners = new Set();
    listenersByScope.set(scope, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByScope.delete(scope);
    }
  };
}

type CodeReviewerAnalyticsFilters = CodeReviewerAnalyticsSelection & {
  readonly setPlatform: (platform: CodeReviewerAnalyticsPlatform) => void;
  readonly setPeriod: (period: CodeReviewerAnalyticsPeriod) => void;
};

/** React binding for the analytics screen: one organization's filters and setters. */
export function useCodeReviewerAnalyticsFilters(scope: string): CodeReviewerAnalyticsFilters {
  const subscribe = useCallback(
    (listener: () => void) => subscribeCodeReviewerAnalyticsFilters(scope, listener),
    [scope]
  );
  const getSnapshot = useCallback(() => getCodeReviewerAnalyticsSelection(scope), [scope]);
  const selection = useSyncExternalStore(subscribe, getSnapshot);
  const setPlatform = useCallback(
    (platform: CodeReviewerAnalyticsPlatform) => {
      setCodeReviewerAnalyticsPlatform(scope, platform);
    },
    [scope]
  );
  const setPeriod = useCallback(
    (period: CodeReviewerAnalyticsPeriod) => {
      setCodeReviewerAnalyticsPeriod(scope, period);
    },
    [scope]
  );
  return { platform: selection.platform, period: selection.period, setPlatform, setPeriod };
}

/** Store one organization's new value. An unchanged value does not notify. */
function setSelection(scope: string, next: CodeReviewerAnalyticsSelection): void {
  const current = getCodeReviewerAnalyticsSelection(scope);
  if (current.platform === next.platform && current.period === next.period) {
    return;
  }
  selectionByScope.set(scope, next);
  notifyScope(scope);
}

function notifyScope(scope: string): void {
  const listeners = listenersByScope.get(scope);
  if (listeners === undefined) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}
