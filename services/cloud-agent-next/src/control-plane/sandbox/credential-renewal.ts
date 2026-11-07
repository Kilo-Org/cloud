/**
 * Pure renewal decisions and the in-memory coordinator for proactive credential
 * maintenance. The Sandbox DO still owns durable routes, grants and timers; this
 * module owns one capture/verdict rule and the flight/retry bookkeeping so the
 * off-queue pass cannot drift from the queued commit.
 */

/**
 * A transient proactive-renewal failure is retried while the current grant is
 * still valid. The interval is real time, like the grant timers themselves, so
 * a failure cannot spin the single alarm. The expiry itself bounds the retries.
 */
export const CREDENTIAL_RENEWAL_RETRY_MS = 5 * 60_000;

/** The physical allocation a renewal was planned under. */
export type RenewalFence = {
  allocationId: string;
  connectionId: string;
  providerInstanceId: string;
  wrapperInstanceId: string;
};

export type CredentialRenewalTarget = {
  sessionId: string;
  scopeKey: string;
  /**
   * The exact stored scope grant observed on the queue before minting. The
   * same serialized value is compared when the policy lane executes and again at
   * the queued commit, so a sibling release or join during the off-queue mint is
   * never overwritten.
   */
  scopeGrantJson: string;
  allocationId: string;
  connectionId: string;
  providerInstanceId: string;
  wrapperInstanceId: string;
  attemptId: string;
  grantExpiresAt: number;
};

export type CredentialRenewalOutcome = 'renewed' | 'stale' | 'released' | 'replaced';

export type RenewalVerdict = CredentialRenewalOutcome | 'current';

/** The authoritative route view a captured renewal is compared with. */
export type CurrentRenewalRoute = {
  scopeKey: string;
  grantExpiresAt: number;
  state: string;
  attemptId: string;
};

/**
 * The one verdict used before policy installation and before queued
 * publication. `released` means no route/grant remains, `replaced` means the
 * route or grant was superseded, and `stale` means a sibling changed the scope
 * membership or the physical allocation changed.
 */
export function decideRenewalTargetVerdict(input: {
  target: CredentialRenewalTarget;
  route: CurrentRenewalRoute | null;
  authoritativeScopeGrantJson: string | null;
  fence: RenewalFence | null;
}): RenewalVerdict {
  const { target, route, authoritativeScopeGrantJson: authoritative, fence } = input;
  if (route === null) return 'released';
  if (route.scopeKey !== target.scopeKey) return 'replaced';
  if (route.grantExpiresAt !== target.grantExpiresAt) return 'replaced';
  if (route.state !== 'ready' || route.attemptId !== target.attemptId) return 'replaced';
  if (authoritative === null || authoritative !== target.scopeGrantJson) {
    // A sibling was released or joined while the mint was off-queue. The
    // candidate was built from the old membership; publishing it would
    // reinsert a revoked member or drop a joined one.
    return 'stale';
  }
  if (
    fence === null ||
    fence.allocationId !== target.allocationId ||
    fence.connectionId !== target.connectionId ||
    fence.providerInstanceId !== target.providerInstanceId ||
    fence.wrapperInstanceId !== target.wrapperInstanceId
  ) {
    return 'stale';
  }
  return 'current';
}

/** One ready route with a stored grant, as read on the alarm's serial turn. */
export type RenewalRouteSnapshot = {
  sessionId: string;
  scopeKey: string;
  scopeGrantJson: string;
  attemptId: string;
  grantExpiresAt: number;
  hasCredentialSource: boolean;
};

/**
 * One coordinator per Sandbox DO. Flight and retry state are in-memory: the
 * alarm carrying the retry deadline is durable, and a fresh DO re-evaluates the
 * grant from its stored expiry.
 */
export type CredentialRenewalCoordinator = {
  readonly inFlight: boolean;
  /** Starts one pass, or returns null when a pass is already running. */
  track(work: () => Promise<void>, onSettled: () => void): Promise<void> | null;
  retryAt(scopeKey: string): number | undefined;
  isRetryReady(scopeKey: string, now: number): boolean;
  reserveRetry(scopeKey: string, now: number, grantExpiresAt: number): number;
  clear(scopeKey: string): void;
  nextDeadline(input: {
    routes: readonly RenewalRouteSnapshot[];
    now: number;
    reissueBelowMs: number;
    canRenew: boolean;
  }): number | null;
  selectTargets(input: {
    routes: readonly RenewalRouteSnapshot[];
    fence: RenewalFence | null;
    now: number;
    reissueBelowMs: number;
  }): CredentialRenewalTarget[];
};

export function createCredentialRenewalCoordinator(): CredentialRenewalCoordinator {
  let flight: Promise<void> | null = null;
  const retries = new Map<string, number>();

  function retryAt(scopeKey: string): number | undefined {
    return retries.get(scopeKey);
  }

  function isRetryReady(scopeKey: string, now: number): boolean {
    const at = retries.get(scopeKey);
    return at === undefined || at <= now;
  }

  function reserveRetry(scopeKey: string, now: number, grantExpiresAt: number): number {
    const at = Math.min(now + CREDENTIAL_RENEWAL_RETRY_MS, Math.max(now + 1, grantExpiresAt));
    retries.set(scopeKey, at);
    return at;
  }

  function track(work: () => Promise<void>, onSettled: () => void): Promise<void> | null {
    if (flight !== null) return null;
    const running = work().finally(() => {
      flight = null;
      onSettled();
    });
    flight = running;
    return running;
  }

  function nextDeadline(input: {
    routes: readonly RenewalRouteSnapshot[];
    now: number;
    reissueBelowMs: number;
    canRenew: boolean;
  }): number | null {
    const { routes, now, reissueBelowMs, canRenew } = input;
    const keys = new Set(routes.map(route => route.scopeKey));
    for (const key of retries.keys()) {
      if (!keys.has(key)) retries.delete(key);
    }
    let at: number | null = null;
    for (const route of routes) {
      const key = route.scopeKey;
      if (route.grantExpiresAt <= now) {
        at = Math.min(at ?? Infinity, now);
        continue;
      }
      if (!canRenew || !route.hasCredentialSource) continue;
      const dueAt = Math.max(now, route.grantExpiresAt - reissueBelowMs);
      const retry = retryAt(key);
      const deferred =
        dueAt <= now
          ? retry !== undefined && retry > now
            ? retry
            : flight !== null
              ? now + CREDENTIAL_RENEWAL_RETRY_MS
              : now
          : dueAt;
      at = Math.min(at ?? Infinity, Math.min(deferred, route.grantExpiresAt));
    }
    return at === null ? null : Math.max(now + 1, at);
  }

  function selectTargets(input: {
    routes: readonly RenewalRouteSnapshot[];
    fence: RenewalFence | null;
    now: number;
    reissueBelowMs: number;
  }): CredentialRenewalTarget[] {
    const { routes, fence, now, reissueBelowMs } = input;
    if (fence === null) return [];
    const targets: CredentialRenewalTarget[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      if (!route.hasCredentialSource) continue;
      const key = route.scopeKey;
      if (seen.has(key) || !isRetryReady(key, now)) continue;
      if (route.grantExpiresAt > now && route.grantExpiresAt - now > reissueBelowMs) continue;
      seen.add(key);
      reserveRetry(key, now, route.grantExpiresAt);
      targets.push({
        sessionId: route.sessionId,
        scopeKey: key,
        scopeGrantJson: route.scopeGrantJson,
        allocationId: fence.allocationId,
        connectionId: fence.connectionId,
        providerInstanceId: fence.providerInstanceId,
        wrapperInstanceId: fence.wrapperInstanceId,
        attemptId: route.attemptId,
        grantExpiresAt: route.grantExpiresAt,
      });
    }
    return targets;
  }

  return {
    get inFlight() {
      return flight !== null;
    },
    track,
    retryAt,
    isRetryReady,
    reserveRetry,
    clear(scopeKey) {
      retries.delete(scopeKey);
    },
    nextDeadline,
    selectTargets,
  };
}
