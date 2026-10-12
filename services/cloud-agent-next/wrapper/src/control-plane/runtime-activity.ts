import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { withTimeoutAndAbort } from '../utils.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';
import { readSessionSnapshot } from './session-snapshot.js';
import {
  createSessionSupervisor,
  type ExecutionFailure,
  type ExecutionIdentity,
} from './session-supervisor.js';

/** Reconciliation is independent of the five-second wrapper heartbeat. */
export const SESSION_SNAPSHOT_INTERVAL_MS = 30_000;
export const SESSION_CONTROL_REQUEST_MS = 10_000;
export type ActivityFault = 'activity_observation' | 'abort_unconfirmed' | 'activity_capacity';

export type RuntimeActivityOptions = {
  nativeRuntimeId: string;
  directory: string;
  client: WrapperKiloClient;
  timers: ControlPlaneTimers['wrapper'];
  now(): number;
  onDeadline(identity: ExecutionIdentity, reason: ExecutionFailure): void;
  /** False when the runtime holds the fault (memory pressure); it is raised again next check. */
  onFault(reason: ActivityFault): boolean;
  onChange(): void;
  readSnapshot?: typeof readSessionSnapshot;
};

/** Process-scoped I/O and observation recovery. The runtime owns process restart. */
export function createRuntimeActivity(options: RuntimeActivityOptions) {
  const lifetime = new AbortController();
  const directories = new Set([options.directory]);
  let unhealthySince: number | undefined = options.now();
  let nextSnapshotAt = options.now();
  let inFlight: Promise<void> | undefined;
  let feedConnected = false;
  let faulted = false;
  let feedRevision = 0;

  function fault(reason: ActivityFault): void {
    if (lifetime.signal.aborted || faulted) return;
    faulted = true;
    if (!options.onFault(reason)) faulted = false;
  }

  async function request<T>(work: (signal: AbortSignal) => Promise<T>, signal = lifetime.signal) {
    const controller = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, signal, controller.signal]);
    try {
      return await withTimeoutAndAbort(work(combined), {
        signal: combined,
        timeoutMs: SESSION_CONTROL_REQUEST_MS,
        timeoutMessage: 'Kilo activity request timed out',
        abortMessage: 'Kilo activity request cancelled',
      });
    } finally {
      controller.abort();
    }
  }

  const supervisor = createSessionSupervisor({
    ...options,
    interrupt: async (identity, _reason, signal) => {
      const stopped = await request(
        requestSignal =>
          options.client.abortSession({
            sessionId: identity.sessionId,
            directory: identity.directory,
            signal: requestSignal,
          }),
        signal
      );
      // Pinned 7.8.1 returns true only after cancelling the session tree. Pending
      // question records can outlive cancellation and are not stop confirmation.
      if (!stopped) throw new Error('Kilo did not confirm session cancellation');
    },
    onObservationFailure: fault,
  });
  supervisor.observationLost();

  function lost(): void {
    feedConnected = false;
    feedRevision++;
    unhealthySince ??= options.now();
    supervisor.observationLost();
  }

  function refresh(): Promise<void> {
    if (lifetime.signal.aborted || faulted || !feedConnected) return Promise.resolve();
    if (inFlight) return inFlight;
    const revision = feedRevision;
    const token = supervisor.beginSnapshot();
    nextSnapshotAt = options.now() + SESSION_SNAPSHOT_INTERVAL_MS;
    inFlight = request(signal =>
      (options.readSnapshot ?? readSessionSnapshot)({
        client: options.client,
        directory: options.directory,
        observedDirectories: [...directories],
        knownSessions: supervisor.observedSessions(),
        signal,
      })
    )
      .then(observations => {
        if (lifetime.signal.aborted) return;
        if (revision !== feedRevision || !feedConnected) {
          supervisor.snapshotFailed(token);
          return;
        }
        supervisor.reconcile(observations, token);
        unhealthySince = undefined;
        options.onChange();
      })
      .catch(() => {
        if (lifetime.signal.aborted) return;
        supervisor.snapshotFailed(token);
        unhealthySince ??= options.now();
      })
      .finally(() => {
        inFlight = undefined;
        // A reconnect during a request invalidates that request, then immediately
        // reconciles the new feed rather than waiting another full cadence.
        if (revision !== feedRevision && feedConnected) void refresh();
      });
    return inFlight;
  }

  return {
    state: (id: string) => supervisor.state(id),
    executions: () =>
      supervisor.observedSessions().flatMap(session => {
        const state = supervisor.state(session.id);
        return state ? [state] : [];
      }),
    isIdle: () =>
      !lifetime.signal.aborted &&
      !faulted &&
      unhealthySince === undefined &&
      supervisor.observedSessions().length === 0,
    needsCompute: () =>
      !lifetime.signal.aborted && (unhealthySince !== undefined || supervisor.needsCompute()),
    isReady: () => !lifetime.signal.aborted && !faulted && unhealthySince === undefined,
    refresh,
    lost,
    connected() {
      if (lifetime.signal.aborted) return;
      feedConnected = true;
      void refresh();
    },
    observe(event: KiloFeedEvent) {
      if (lifetime.signal.aborted || event.nativeRuntimeId !== options.nativeRuntimeId) return;
      if (event.directory) directories.add(event.directory);
      if (directories.size > 64) {
        fault('activity_capacity');
        return;
      }
      try {
        supervisor.observe(event);
        options.onChange();
      } catch {
        fault('activity_capacity');
      }
    },
    tick() {
      if (lifetime.signal.aborted || faulted) return;
      if (
        unhealthySince !== undefined &&
        options.now() - unhealthySince >= options.timers.sseReconnectWindowMs
      ) {
        fault('activity_observation');
        // A held fault keeps reading snapshots, so a recovered Kilo clears `unhealthySince`.
        if (faulted) return;
      }
      if (options.now() >= nextSnapshotAt) void refresh();
      supervisor.tick();
    },
    holdMemory(held: boolean) {
      supervisor.holdMemory(held);
    },
    dispose() {
      lifetime.abort();
      supervisor.dispose();
    },
  };
}

export type RuntimeActivity = ReturnType<typeof createRuntimeActivity>;
