/**
 * The local profile's capability factory. It is the only place that composes the
 * Docker-backed container inspection into the shared-scenario seam, so the
 * deployed path never *contains* that implementation: the deployed factory
 * exposes no sandbox capability.
 *
 * This is containment of the composed implementation, not import-graph
 * isolation: the deployed smoke runner imports `run.ts`, which statically
 * imports this module and `lifecycle.ts`. That import does not execute any
 * Docker inspection.
 */

import {
  captureControlWrapperProcess,
  signalKiloServerProcess,
  waitForNewSandboxPresent,
} from './sandbox-control.js';
import {
  currentOwnedSandbox,
  snapshotSandboxIds,
  stopOwnedSandboxFamily,
  waitForOwnedSandbox,
} from './lifecycle.js';
import { captureLogCursor, readWorkerLogSnapshot } from './idle-stop-evidence.js';
import { deriveSandboxAllocationId } from '../../src/sandbox-id.js';
import {
  collectReapEvidence,
  emptyReapEvidence,
  type SandboxFaultReapEvidence,
} from './sandbox-fault-evidence.js';
import { startCallbackServer, type CallbackRecord } from './callback-server.js';
import type {
  CallbackObservation,
  CallbackPayload,
  SandboxFaultAllocation,
  SandboxFaultObservation,
  SandboxFaultTarget,
  ScenarioEnvironment,
  SandboxObservation,
  SessionSandboxCurrentInput,
  SessionSandboxObservation,
  SessionSandboxWaitInput,
} from './scenario-capabilities.js';

function callbackPayload(record: CallbackRecord): CallbackPayload {
  return (
    record.body !== null && typeof record.body === 'object' ? record.body : {}
  ) as CallbackPayload;
}

/**
 * The local Docker profile's callback capability: a host HTTP sink the Worker
 * reaches directly at `127.0.0.1:<port>`. The HTTP profiles use the e2e surface
 * sink instead; both satisfy the same `CallbackObservation` contract.
 */
export function createLocalCallbacks(): CallbackObservation {
  return {
    open: async signal => {
      const server = await startCallbackServer();
      return {
        callbackUrl: server.callbackUrl,
        records: async () => server.received.map(callbackPayload),
        waitFor: async (predicate, timeoutMs, waitSignal) => {
          const effective = waitSignal ?? signal;
          if (effective?.aborted) return null;
          const record = await server.waitFor(
            candidate => predicate(callbackPayload(candidate)),
            timeoutMs
          );
          // The host sink's own wait is not abortable; the signal is honoured
          // before and after it, and the caller caps `timeoutMs` by its
          // remaining scenario time.
          if (effective?.aborted) return null;
          return record === null ? null : callbackPayload(record);
        },
        close: () => server.close(),
      };
    },
  };
}

/**
 * The local Docker profile's physical fault injection. Every operation proves
 * exclusive ownership and fails closed when the observed allocation no longer
 * matches `expectedAllocationRef`, so a replacement is never silently
 * rediscovered and killed/frozen. Wrapper faults are bound to a verified wrapper
 * identity captured through `captureWrapperIdentity`; the frozen process handle
 * is retained so `unfreezeWrapperProcess` acts on the process that was actually
 * frozen instead of rediscovering one. When identity cannot be established the
 * operation refuses rather than advertising guarded injection.
 */
function createLocalSandboxFaults(): SandboxFaultObservation {
  /** Frozen wrapper handles keyed by cloudAgentSessionId, for exact `CONT`. */
  const frozenHandles = new Map<string, Awaited<ReturnType<typeof captureControlWrapperProcess>>>();

  const requireOwnedContainer = async (
    target: SandboxFaultAllocation
  ): Promise<NonNullable<Awaited<ReturnType<typeof currentOwnedSandbox>>>> => {
    if (!target.expectedAllocationRef) {
      throw new Error(
        `sandboxFaults: refusing to act without an observed allocation reference for ${target.cloudAgentSessionId}`
      );
    }
    const container = await currentOwnedSandbox(target.cloudAgentSessionId, target.kiloSessionId);
    if (!container) {
      throw new Error(
        `sandboxFaults: no exclusively owned container for ${target.cloudAgentSessionId}`
      );
    }
    if (container.id !== target.expectedAllocationRef) {
      throw new Error(
        `sandboxFaults: observed container ${container.id} does not match expected ${target.expectedAllocationRef}`
      );
    }
    return container;
  };

  const requireExpectedWrapper = (target: SandboxFaultTarget): string => {
    const expected = target.expectedWrapperInstanceId.trim();
    if (expected === '') {
      throw new Error(
        `sandboxFaults: refusing to act without a verified wrapper identity for ${target.cloudAgentSessionId}`
      );
    }
    return expected;
  };

  const wrapperInstanceId = (handle: { containerId: string; processId: number }): string =>
    `${handle.containerId}:${handle.processId}`;

  /**
   * Prove the currently observed wrapper is the captured one before an
   * induction operation acts. This is a guard, never a rediscovery path: a
   * mismatch (or a wrapper that can no longer be observed) fails closed rather
   * than acting on a replacement.
   */
  const requireMatchingWrapper = async (
    containerId: string,
    target: SandboxFaultTarget
  ): Promise<void> => {
    const expected = requireExpectedWrapper(target);
    const handle = await captureControlWrapperProcess(containerId);
    const observed = wrapperInstanceId(handle);
    if (observed !== expected) {
      throw new Error(
        `sandboxFaults: observed wrapper ${observed} does not match expected ${expected}`
      );
    }
  };

  return {
    captureWrapperIdentity: async allocation => {
      const container = await requireOwnedContainer(allocation);
      const handle = await captureControlWrapperProcess(container.id);
      return { instanceId: wrapperInstanceId(handle), pid: handle.processId };
    },
    killOwnedContainer: async target => {
      const container = await requireOwnedContainer(target);
      await requireMatchingWrapper(container.id, target);
      const killed = await stopOwnedSandboxFamily(
        container,
        target.cloudAgentSessionId,
        target.kiloSessionId
      );
      frozenHandles.delete(target.cloudAgentSessionId);
      if (killed.length === 0) {
        return {
          killed: false,
          observedRef: container.id,
          detail: `owned family for ${target.cloudAgentSessionId} was already gone; no process stopped`,
        };
      }
      return {
        killed: true,
        observedRef: container.id,
        detail: `stopped ${container.name} (${killed.length} processes)`,
      };
    },
    freezeWrapperProcess: async target => {
      const container = await requireOwnedContainer(target);
      const expected = requireExpectedWrapper(target);
      if (frozenHandles.has(target.cloudAgentSessionId)) {
        throw new Error(
          `sandboxFaults: refusing to freeze ${target.cloudAgentSessionId}: a frozen wrapper handle is already outstanding`
        );
      }
      const handle = await captureControlWrapperProcess(container.id);
      const observed = wrapperInstanceId(handle);
      if (observed !== expected) {
        throw new Error(
          `sandboxFaults: observed wrapper ${observed} does not match expected ${expected}`
        );
      }
      await signalKiloServerProcess(handle, 'STOP');
      frozenHandles.set(target.cloudAgentSessionId, handle);
      return {
        frozen: true,
        pid: handle.processId,
        detail: `froze control wrapper pid=${handle.processId} in ${container.name}`,
      };
    },
    unfreezeWrapperProcess: async target => {
      const handle = frozenHandles.get(target.cloudAgentSessionId);
      if (!handle) {
        throw new Error(
          `sandboxFaults: refusing to unfreeze ${target.cloudAgentSessionId}: no retained frozen wrapper handle`
        );
      }
      const expected = requireExpectedWrapper(target);
      const observed = wrapperInstanceId(handle);
      if (observed !== expected) {
        throw new Error(
          `sandboxFaults: retained frozen wrapper ${observed} does not match expected ${expected}`
        );
      }
      await signalKiloServerProcess(handle, 'CONT');
      frozenHandles.delete(target.cloudAgentSessionId);
    },
    captureEvidenceCursor: async () => (await captureLogCursor()).fromByte,
    observeReapEvidence: async input => {
      if (!Number.isFinite(input.waitMs) || input.waitMs <= 0) {
        throw new Error(`sandboxFaults: invalid reap-evidence wait ${input.waitMs}`);
      }
      const required = (evidence: SandboxFaultReapEvidence): boolean => {
        if (!input.inflight) {
          return (
            evidence.physicalStopCause !== null &&
            evidence.providerStopObserved &&
            evidence.recoveryOutcome === 'started'
          );
        }
        return (
          evidence.physicalStopCause !== null &&
          evidence.providerStopObserved &&
          evidence.recoveryOutcome === 'started' &&
          evidence.acceptedReconciliation === 'runtime_unhealthy' &&
          evidence.routeStaleActive
        );
      };
      const deadline = Date.now() + input.waitMs;
      let evidence = emptyReapEvidence(input.reapedAllocationRef);
      const evidenceEvents = new Set<unknown>([
        'allocation_transition',
        'native_stop',
        'wrapper_ready',
        'heartbeat',
      ]);
      for (;;) {
        const records = await readWorkerLogSnapshot({
          fromByte: input.fromByte,
          match: record =>
            record.diagnosticEvent === 'native_stop' ||
            (record.sandboxId === input.sandboxId && evidenceEvents.has(record.diagnosticEvent)) ||
            (input.messageId !== undefined &&
              record.diagnosticEvent === 'accepted_reconciliation' &&
              record.messageId === input.messageId),
        });
        const stop = records.find(
          record =>
            record.diagnosticEvent === 'allocation_transition' &&
            record.sandboxId === input.sandboxId &&
            typeof record.allocationId === 'string'
        );
        const allocationName =
          stop && typeof stop.allocationId === 'string'
            ? await deriveSandboxAllocationId(input.sandboxId, stop.allocationId)
            : undefined;
        evidence = collectReapEvidence(records, {
          reapedAllocationRef: input.reapedAllocationRef,
          sandboxId: input.sandboxId,
          ...(allocationName ? { allocationName } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
        });
        if (required(evidence)) return evidence;
        if (input.signal?.aborted || Date.now() >= deadline) return evidence;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    },
  };
}

export function createLocalScenarioEnvironment(): ScenarioEnvironment {
  const sandbox: SandboxObservation = {
    snapshotContainerIds: () => snapshotSandboxIds(),
    waitForOwnedContainer: async input => {
      const container = await waitForOwnedSandbox(
        input.cloudAgentSessionId,
        input.kiloSessionId,
        new Set(input.knownIds),
        input.timeoutMs,
        input.signal
      );
      return container ? container.id : null;
    },
    waitForNewContainer: async (knownIds, timeoutMs, signal) => {
      const container = await waitForNewSandboxPresent(new Set(knownIds), timeoutMs, signal);
      return container ? container.id : null;
    },
  };

  /**
   * The local container observation for the shared scenarios. `waitForContainer`
   * passes an empty exclusion set, so it reports the session's current Docker
   * container without proving it appeared after a pre-start snapshot; that
   * weaker contract is the plan's intended substitution for the removed
   * `waitForOwnedSandbox` call, not an equivalent check.
   */
  const sessionSandbox: SessionSandboxObservation = {
    waitForContainer: async (input: SessionSandboxWaitInput) => {
      const container = await waitForOwnedSandbox(
        input.cloudAgentSessionId,
        input.kiloSessionId,
        new Set(),
        input.timeoutMs,
        input.signal
      );
      return container ? container.id : null;
    },
    currentContainer: async (input: SessionSandboxCurrentInput) => {
      if (input.signal?.aborted) return null;
      const container = await currentOwnedSandbox(input.cloudAgentSessionId, input.kiloSessionId);
      return container ? container.id : null;
    },
  };

  return {
    profile: 'local',
    requireControlPlaneSession: false,
    sandbox,
    sessionSandbox,
    callbacks: createLocalCallbacks(),
    gates: { parkedStreamsSupported: true },
    sandboxFaults: createLocalSandboxFaults(),
  };
}
