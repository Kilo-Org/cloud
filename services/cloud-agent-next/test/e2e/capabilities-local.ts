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

import { createDrizzleClient, cloud_agent_session_runs } from '@kilocode/db';
import { and, eq } from 'drizzle-orm';
import {
  captureControlPlaneWrapperProcess,
  captureControlWrapperProcess,
  containerGitRemoteUrl,
  containerProcessEnvironment,
  containerProcessIsLive,
  CONTROL_PLANE_WRAPPER_BASENAME,
  findControlPlaneKiloRuntime,
  inspectControlPlaneSummaryCount,
  inspectControlPlaneUserMessageParts,
  LEGACY_CONTROL_WRAPPER_BASENAME,
  recycleControlConnection,
  signalKiloServerProcess,
  waitForNewSandboxPresent,
  type KiloServerProcessHandle,
} from './sandbox-control.js';
import {
  currentOwnedSandbox,
  reclaimOwnedSandboxes,
  snapshotSandboxIds,
  stopOwnedSandboxFamily,
  waitForOwnedSandbox,
} from './lifecycle.js';
import { captureLogCursor, readWorkerLogSnapshot, type LogRecord } from './idle-stop-evidence.js';
import {
  AttachWindowMissedError,
  evaluateAttachWindow,
  type AttachWindowResult,
} from './attach-window-evidence.js';
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
  ControlPlaneRuntimeObservation,
  ReportRow,
  ReportsObservation,
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

/** Poll cadence for the attach-drop/reconnect worker-log correlation. */
const CONTROL_SOCKET_LOG_POLL_MS = 250;
/**
 * Chosen test budget for observing the recycle sequence after `SIGUSR1`. It is
 * not `RECONNECT_MAX_MS`, which caps one retry delay, not the whole reconnect.
 */
const CONTROL_SOCKET_RECYCLE_BUDGET_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

/** Worker diagnostics that make up the attach-window stream. */
const ATTACH_WINDOW_DIAGNOSTICS = new Set([
  'socket_request_sent',
  'socket_response',
  'socket_closed',
  'handshake_committed',
  'wrapper_ready',
]);

function isAttachWindowRecord(record: LogRecord): boolean {
  return (
    typeof record.diagnosticEvent === 'string' &&
    ATTACH_WINDOW_DIAGNOSTICS.has(record.diagnosticEvent)
  );
}

/**
 * `dropControlSocketDuringAttach`'s only success return: accept the attach
 * window or throw. `missed` throws `AttachWindowMissedError` (the one retryable
 * outcome); `late_response` throws `attach response after close` (not
 * retryable). Exported so the capability-level test can inject a record stream
 * without Docker.
 */
export function acceptAttachWindow(input: {
  records: LogRecord[];
  requestId: string;
  attachConnectionId: string;
  signalCursorPosition: number;
  result: AttachWindowResult;
}): AttachWindowResult {
  const decision = evaluateAttachWindow({
    records: input.records,
    requestId: input.requestId,
    attachConnectionId: input.attachConnectionId,
    signalCursorPosition: input.signalCursorPosition,
  });
  if (decision.kind === 'missed') throw new AttachWindowMissedError();
  if (decision.kind === 'late_response') throw new Error('attach response after close');
  return input.result;
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
  /**
   * Frozen Kilo-server handles keyed by cloudAgentSessionId. A stopped Kilo
   * cannot answer discovery, so `unfreezeKiloServerProcess` must reuse this
   * captured handle rather than rediscovering the process.
   */
  const frozenKiloHandles = new Map<
    string,
    Awaited<ReturnType<typeof captureControlWrapperProcess>>
  >();

  const requireOwnedContainer = async (
    target: SandboxFaultAllocation
  ): Promise<NonNullable<Awaited<ReturnType<typeof currentOwnedSandbox>>>> => {
    if (!target.expectedAllocationRef) {
      throw new Error(
        `sandboxFaults: refusing to act without an observed allocation reference for ${target.cloudAgentSessionId}`
      );
    }
    // One docker ownership scan can miss under load: `findControlPlaneKiloRuntime`
    // is invoked once per candidate and a single timed-out exec makes the shot
    // return null. Retry before refusing to act.
    let container = await currentOwnedSandbox(target.cloudAgentSessionId, target.kiloSessionId);
    for (let attempt = 1; container === null && attempt < 4; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      container = await currentOwnedSandbox(target.cloudAgentSessionId, target.kiloSessionId);
    }
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
   * Capture a control wrapper by plane. Absent basename means the legacy
   * wrapper; new-plane scenarios pass the control-plane basename so a legacy
   * container is never matched and vice versa.
   */
  const captureWrapper = async (
    containerId: string,
    wrapperProcessBasename?: string
  ): Promise<KiloServerProcessHandle> => {
    if (wrapperProcessBasename === CONTROL_PLANE_WRAPPER_BASENAME) {
      return captureControlPlaneWrapperProcess(containerId);
    }
    if (
      wrapperProcessBasename !== undefined &&
      wrapperProcessBasename !== LEGACY_CONTROL_WRAPPER_BASENAME
    ) {
      throw new Error(`sandboxFaults: unsupported wrapper basename ${wrapperProcessBasename}`);
    }
    return captureControlWrapperProcess(containerId);
  };

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
    const handle = await captureWrapper(containerId, target.wrapperProcessBasename);
    const observed = wrapperInstanceId(handle);
    if (observed !== expected) {
      throw new Error(
        `sandboxFaults: observed wrapper ${observed} does not match expected ${expected}`
      );
    }
  };

  /** The one worker-log end cursor behind both cursor-shaped capability names. */
  const captureWorkerLogCursor = async (): Promise<number> => (await captureLogCursor()).fromByte;

  /**
   * Discover the `kilo serve` process for the session and bind it to the
   * already-verified container. `findControlPlaneKiloRuntime` proves the root
   * through the live Kilo listener; the container must be the owned allocation.
   */
  const captureKiloServerHandle = async (
    containerId: string,
    target: SandboxFaultAllocation
  ): Promise<KiloServerProcessHandle> => {
    const runtime = await findControlPlaneKiloRuntime(target.kiloSessionId);
    if (!runtime) {
      throw new Error(`sandboxFaults: no Kilo runtime for ${target.kiloSessionId}`);
    }
    if (runtime.container.id !== containerId) {
      throw new Error(
        `sandboxFaults: Kilo runtime container ${runtime.container.id} does not match owned ${containerId}`
      );
    }
    return { containerId, processId: runtime.processId };
  };

  return {
    captureWrapperIdentity: async allocation => {
      const container = await requireOwnedContainer(allocation);
      const handle = await captureWrapper(container.id, allocation.wrapperProcessBasename);
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
    recycleWrapperSocket: async target => {
      const container = await requireOwnedContainer(target);
      const expected = requireExpectedWrapper(target);
      const handle = await captureWrapper(container.id, target.wrapperProcessBasename);
      const observed = wrapperInstanceId(handle);
      if (observed !== expected) {
        throw new Error(
          `sandboxFaults: observed wrapper ${observed} does not match expected ${expected}`
        );
      }
      await recycleControlConnection(handle);
      return {
        recycled: true,
        pid: handle.processId,
        detail: `recycled control wrapper pid=${handle.processId} in ${container.name}`,
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
      const handle = await captureWrapper(container.id, target.wrapperProcessBasename);
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
    killWrapperProcess: async target => {
      const container = await requireOwnedContainer(target);
      const expected = requireExpectedWrapper(target);
      const handle = await captureWrapper(container.id, target.wrapperProcessBasename);
      const observed = wrapperInstanceId(handle);
      if (observed !== expected) {
        throw new Error(
          `sandboxFaults: observed wrapper ${observed} does not match expected ${expected}`
        );
      }
      await signalKiloServerProcess(handle, 'KILL');
      frozenHandles.delete(target.cloudAgentSessionId);
      return {
        killed: true,
        pid: handle.processId,
        detail: `killed control wrapper pid=${handle.processId} in ${container.name}`,
      };
    },
    killKiloServerProcess: async target => {
      const container = await requireOwnedContainer(target);
      await requireMatchingWrapper(container.id, target);
      const handle = await captureKiloServerHandle(container.id, target);
      await signalKiloServerProcess(handle, 'KILL');
      frozenKiloHandles.delete(target.cloudAgentSessionId);
      return {
        killed: true,
        pid: handle.processId,
        detail: `killed kilo serve pid=${handle.processId} in ${container.name}`,
      };
    },
    freezeKiloServerProcess: async target => {
      const container = await requireOwnedContainer(target);
      await requireMatchingWrapper(container.id, target);
      if (frozenKiloHandles.has(target.cloudAgentSessionId)) {
        throw new Error(
          `sandboxFaults: refusing to freeze ${target.cloudAgentSessionId}: a frozen Kilo handle is already outstanding`
        );
      }
      const handle = await captureKiloServerHandle(container.id, target);
      await signalKiloServerProcess(handle, 'STOP');
      frozenKiloHandles.set(target.cloudAgentSessionId, handle);
      return {
        frozen: true,
        pid: handle.processId,
        detail: `froze kilo serve pid=${handle.processId} in ${container.name}`,
      };
    },
    unfreezeKiloServerProcess: async target => {
      const handle = frozenKiloHandles.get(target.cloudAgentSessionId);
      if (!handle) {
        throw new Error(
          `sandboxFaults: refusing to unfreeze ${target.cloudAgentSessionId}: no retained frozen Kilo handle`
        );
      }
      const container = await requireOwnedContainer(target);
      if (container.id !== handle.containerId) {
        throw new Error(
          `sandboxFaults: frozen Kilo container ${handle.containerId} does not match observed ${container.id}`
        );
      }
      await requireMatchingWrapper(container.id, target);
      await signalKiloServerProcess(handle, 'CONT');
      frozenKiloHandles.delete(target.cloudAgentSessionId);
    },
    captureKiloServerIdentity: async allocation => {
      const container = await requireOwnedContainer(allocation);
      const handle = await captureKiloServerHandle(container.id, allocation);
      return { pid: handle.processId };
    },
    kiloServerProcessExists: async (allocation, pid) => {
      const container = await requireOwnedContainer(allocation);
      return containerProcessIsLive(container.id, pid);
    },
    captureEvidenceCursor: captureWorkerLogCursor,
    observeReapEvidence: async input => {
      if (!Number.isFinite(input.waitMs) || input.waitMs <= 0) {
        throw new Error(`sandboxFaults: invalid reap-evidence wait ${input.waitMs}`);
      }
      const required = (evidence: SandboxFaultReapEvidence): boolean => {
        if (input.controlPlane) return evidence.providerStopObserved;
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
            : input.controlPlane
              ? input.sandboxId
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
    captureWorkerLogCursor,
    dropControlSocketDuringAttach: async input => {
      if (!Number.isFinite(input.waitForAttachMs) || input.waitForAttachMs <= 0) {
        throw new Error(`sandboxFaults: invalid attach wait ${input.waitForAttachMs}`);
      }
      const attachDeadline = Date.now() + input.waitForAttachMs;
      let attachRequestId: string | undefined;
      let attachConnectionId: string | undefined;
      let attachWrapperInstanceId: string | undefined;
      for (;;) {
        const [attach] = await readWorkerLogSnapshot({
          fromByte: input.fromByte,
          match: record =>
            record.diagnosticEvent === 'socket_request_sent' &&
            record.operation === 'session.attach' &&
            record.sessionId === input.sessionId,
        });
        if (attach) {
          attachRequestId = logString(attach, 'requestId');
          attachConnectionId = logString(attach, 'connectionId');
          attachWrapperInstanceId = logString(attach, 'wrapperInstanceId');
          break;
        }
        if (Date.now() >= attachDeadline) throw new Error('attach did not start');
        await sleep(CONTROL_SOCKET_LOG_POLL_MS);
      }
      if (attachConnectionId === undefined || attachWrapperInstanceId === undefined) {
        throw new Error('attach did not expose a connection and wrapper identity');
      }
      if (attachRequestId === undefined) throw new Error('attach did not expose a request id');

      // Refuse a replacement allocation before acting. The wrapper is captured
      // at signal time so the new-plane scenario can recycle during attach
      // instead of after a separate identity wait that loses the window.
      const target: SandboxFaultTarget = {
        cloudAgentSessionId: input.sessionId,
        kiloSessionId: input.kiloSessionId,
        expectedAllocationRef: input.containerId,
        expectedWrapperInstanceId: input.expectedWrapperInstanceId ?? 'pending',
        ...(input.wrapperProcessBasename
          ? { wrapperProcessBasename: input.wrapperProcessBasename }
          : {}),
      };
      const container = await requireOwnedContainer(target);
      const handle = await captureWrapper(container.id, input.wrapperProcessBasename);
      const observed = wrapperInstanceId(handle);
      if (
        input.expectedWrapperInstanceId !== undefined &&
        observed !== input.expectedWrapperInstanceId
      ) {
        throw new Error(
          `sandboxFaults: observed wrapper ${observed} does not match expected ${input.expectedWrapperInstanceId}`
        );
      }

      // The second pre-signal cursor: the record position at which post-signal
      // records begin. It is the count of attach-window records already written,
      // because `LogRecord` carries no byte offset; the pre-signal prefix is
      // captured immediately before the signal so a natural close before it is
      // never credited to the signal.
      const attachRecord = (record: LogRecord): boolean =>
        isAttachWindowRecord(record) && record.wrapperInstanceId === attachWrapperInstanceId;
      const preSignalRecords = await readWorkerLogSnapshot({
        fromByte: input.fromByte,
        match: attachRecord,
      });
      const signalCursorPosition = preSignalRecords.length;
      await recycleControlConnection(handle);

      const deadline = Date.now() + CONTROL_SOCKET_RECYCLE_BUDGET_MS;
      for (;;) {
        const records = await readWorkerLogSnapshot({
          fromByte: input.fromByte,
          match: attachRecord,
        });
        let closedConnectionId: string | undefined;
        let committedConnectionId: string | undefined;
        let readyConnectionId: string | undefined;
        for (let index = signalCursorPosition; index < records.length; index += 1) {
          const record = records[index];
          const connectionId = logString(record, 'connectionId');
          if (record.diagnosticEvent === 'socket_closed') {
            if (connectionId !== attachConnectionId || record.handshakeComplete !== true) {
              throw new Error(
                `control socket closed on an unexpected connection (${connectionId ?? 'none'})`
              );
            }
            closedConnectionId = connectionId;
            continue;
          }
          if (closedConnectionId === undefined) continue;
          if (record.diagnosticEvent === 'handshake_committed') {
            if (connectionId === undefined || connectionId === attachConnectionId) {
              throw new Error('control socket reconnect did not use a new connection');
            }
            committedConnectionId ??= connectionId;
            continue;
          }
          if (
            record.diagnosticEvent === 'wrapper_ready' &&
            committedConnectionId !== undefined &&
            connectionId === committedConnectionId
          ) {
            readyConnectionId = connectionId;
          }
        }
        if (closedConnectionId !== undefined && readyConnectionId !== undefined) {
          const result: AttachWindowResult = {
            attachRequestId,
            attachConnectionId,
            closedConnectionId,
            readyConnectionId,
            wrapperInstanceId: attachWrapperInstanceId,
            signaledPid: handle.processId,
          };
          return acceptAttachWindow({
            records,
            requestId: attachRequestId,
            attachConnectionId,
            signalCursorPosition,
            result,
          });
        }
        if (Date.now() >= deadline) {
          throw new Error(
            closedConnectionId === undefined
              ? 'control socket did not close after the recycle signal'
              : committedConnectionId === undefined
                ? 'control socket did not commit a new handshake after the close'
                : 'control socket reconnect never reached wrapper_ready'
          );
        }
        await sleep(CONTROL_SOCKET_LOG_POLL_MS);
      }
    },
    countPromptDispatches: async input => {
      const records = await readWorkerLogSnapshot({
        fromByte: input.fromByte,
        match: record =>
          record.diagnosticEvent === 'socket_request_sent' &&
          record.operation === 'session.prompt' &&
          record.sessionId === input.sessionId,
      });
      return records.length;
    },
  };
}

/**
 * The local profile's persisted-report observation (plan B11). The new plane's
 * terminal report reaches the queue consumer, which writes one
 * `cloud_agent_session_runs` row per message; a schema-invalid report is dropped
 * there, so reading the row (not a worker-log line) is what proves the report
 * survived. The harness queries it directly with `DATABASE_URL`. When no
 * connection string is set the profile provides no `reports` and a
 * report-dependent scenario is `unsupported`.
 */
export function createLocalReports(databaseUrl: string): ReportsObservation {
  const client = createDrizzleClient({
    connectionString: databaseUrl,
    poolConfig: { application_name: 'cloud-agent-next-e2e-reports', max: 1 },
  });

  const readRow = async (
    cloudAgentSessionId: string,
    messageId: string
  ): Promise<ReportRow | null> => {
    const rows = await client.db
      .select({
        messageId: cloud_agent_session_runs.message_id,
        status: cloud_agent_session_runs.status,
        failureStage: cloud_agent_session_runs.failure_stage,
        failureCode: cloud_agent_session_runs.failure_code,
        failureResponsibility: cloud_agent_session_runs.failure_responsibility,
        failureReason: cloud_agent_session_runs.failure_reason,
        terminalAt: cloud_agent_session_runs.terminal_at,
      })
      .from(cloud_agent_session_runs)
      .where(
        and(
          eq(cloud_agent_session_runs.cloud_agent_session_id, cloudAgentSessionId),
          eq(cloud_agent_session_runs.message_id, messageId)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      messageId: row.messageId,
      status: row.status,
      ...(row.failureStage === null ? {} : { failureStage: row.failureStage }),
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
      ...(row.failureResponsibility === null
        ? {}
        : { failureResponsibility: row.failureResponsibility }),
      ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
      ...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt }),
    };
  };

  return {
    waitForReportRow: async input => {
      const deadline = Date.now() + Math.max(1, input.timeoutMs);
      for (;;) {
        const row = await readRow(input.cloudAgentSessionId, input.messageId);
        if (row) return row;
        if (input.signal?.aborted || Date.now() >= deadline) return null;
        await sleep(500);
      }
    },
  };
}

/**
 * The local profile's new-plane runtime proof. `proveNewPlane` captures the
 * new-plane control wrapper in the owned container; a legacy container has no
 * such process and the capture throws, so a `workspace_*` id alone can never
 * false-pass as the new plane.
 */
export function createLocalControlPlaneRuntime(): ControlPlaneRuntimeObservation {
  const requireContainer = async (
    allocation: SandboxFaultAllocation
  ): Promise<NonNullable<Awaited<ReturnType<typeof currentOwnedSandbox>>>> => {
    if (!allocation.expectedAllocationRef) {
      throw new Error(
        `controlPlaneRuntime: refusing to inspect without an observed allocation for ${allocation.cloudAgentSessionId}`
      );
    }
    const container = await currentOwnedSandbox(
      allocation.cloudAgentSessionId,
      allocation.kiloSessionId
    );
    if (!container) {
      throw new Error(
        `controlPlaneRuntime: no exclusively owned container for ${allocation.cloudAgentSessionId}`
      );
    }
    if (container.id !== allocation.expectedAllocationRef) {
      throw new Error(
        `controlPlaneRuntime: observed container ${container.id} does not match expected ${allocation.expectedAllocationRef}`
      );
    }
    return container;
  };

  return {
    proveNewPlane: async allocation => {
      const container = await requireContainer(allocation);
      const handle = await captureControlPlaneWrapperProcess(container.id);
      return { instanceId: `${handle.containerId}:${handle.processId}`, pid: handle.processId };
    },
    userMessageParts: async (allocation, userMessageId) => {
      await requireContainer(allocation);
      const runtime = await findControlPlaneKiloRuntime(allocation.kiloSessionId);
      if (!runtime) {
        throw new Error(`controlPlaneRuntime: no Kilo runtime for ${allocation.kiloSessionId}`);
      }
      return inspectControlPlaneUserMessageParts(runtime, {
        kiloSessionId: allocation.kiloSessionId,
        userMessageId,
      });
    },
    containerEnvironment: async allocation => {
      await requireContainer(allocation);
      const runtime = await findControlPlaneKiloRuntime(allocation.kiloSessionId);
      if (!runtime) {
        throw new Error(`controlPlaneRuntime: no Kilo runtime for ${allocation.kiloSessionId}`);
      }
      return containerProcessEnvironment(runtime.container.id, runtime.processId);
    },
    gitRemoteUrl: async allocation => {
      await requireContainer(allocation);
      const runtime = await findControlPlaneKiloRuntime(allocation.kiloSessionId);
      if (!runtime) {
        throw new Error(`controlPlaneRuntime: no Kilo runtime for ${allocation.kiloSessionId}`);
      }
      return containerGitRemoteUrl(runtime.container.id, runtime.directory);
    },
    summaryCount: async allocation => {
      await requireContainer(allocation);
      const runtime = await findControlPlaneKiloRuntime(allocation.kiloSessionId);
      if (!runtime) {
        throw new Error(`controlPlaneRuntime: no Kilo runtime for ${allocation.kiloSessionId}`);
      }
      const inspection = await inspectControlPlaneSummaryCount(runtime);
      return inspection.summaryCount;
    },
  };
}

/**
 * Mirror the Worker's containment parsing exactly
 * (`session-registration.ts`: `!== 'false'`, so an absent value is enabled) so
 * the harness reads the same `.dev.vars` source and there is no second flag to
 * keep in sync.
 */
export function credentialContainmentEnabled(devVars: Record<string, string>): boolean {
  return devVars.CREDENTIAL_CONTAINMENT_ENABLED !== 'false';
}

export function createLocalScenarioEnvironment(options?: {
  credentialContainmentEnabled?: boolean;
}): ScenarioEnvironment {
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

  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  return {
    profile: 'local',
    requireControlPlaneSession: false,
    reclaimSessions: async sessions => {
      const report = await reclaimOwnedSandboxes(sessions);
      for (const failure of report.failures) {
        console.warn(`sandbox reclaim: ${failure}; it stays until the idle stop`);
      }
    },
    sandbox,
    sessionSandbox,
    callbacks: createLocalCallbacks(),
    gates: { parkedStreamsSupported: true },
    sandboxFaults: createLocalSandboxFaults(),
    controlPlaneRuntime: createLocalControlPlaneRuntime(),
    // The report row lives in Postgres; without a connection string the
    // report-dependent scenario is `unsupported`.
    ...(databaseUrl ? { reports: createLocalReports(databaseUrl) } : {}),
    // V2 is inert until C1 routes and launches it, so the operator opts in
    // explicitly; without the flag V2 scenarios report `unsupported`.
    ...(process.env.E2E_CONTROL_PLANE_V2 === '1' ? { controlPlaneV2: { ready: true } } : {}),
    // Containment is a Worker `.dev.vars` setting; the harness reads the same
    // source (passed in by the driver) instead of a second env flag.
    ...(options?.credentialContainmentEnabled ? { credentialContainment: { enabled: true } } : {}),
  };
}
