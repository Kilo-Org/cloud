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

import { waitForNewSandboxPresent } from './sandbox-control.js';
import { currentOwnedSandbox, snapshotSandboxIds, waitForOwnedSandbox } from './lifecycle.js';
import { startCallbackServer, type CallbackRecord } from './callback-server.js';
import type {
  CallbackObservation,
  CallbackPayload,
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
    open: async () => {
      const server = await startCallbackServer();
      return {
        callbackUrl: server.callbackUrl,
        records: async () => server.received.map(callbackPayload),
        waitFor: async (predicate, timeoutMs) => {
          const record = await server.waitFor(
            candidate => predicate(callbackPayload(candidate)),
            timeoutMs
          );
          return record === null ? null : callbackPayload(record);
        },
        close: () => server.close(),
      };
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
        input.timeoutMs
      );
      return container ? container.id : null;
    },
    waitForNewContainer: async (knownIds, timeoutMs) => {
      const container = await waitForNewSandboxPresent(new Set(knownIds), timeoutMs);
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
        input.timeoutMs
      );
      return container ? container.id : null;
    },
    currentContainer: async (input: SessionSandboxCurrentInput) => {
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
  };
}
