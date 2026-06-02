import { ExecutionOrchestrator } from '../execution/orchestrator.js';
import { createAgentSandbox } from '../agent-sandbox/factory.js';
import type {
  AgentSandbox,
  WrapperInstanceLease,
  WrapperObservation,
} from '../agent-sandbox/protocol.js';
import type {
  ExecutionResult,
  FencedWrapperDispatchRequest,
  MessageDeliveryRequest,
  MessageDeliveryResult,
  WorkspaceReady,
} from '../execution/types.js';
import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { WrapperCommand } from '../shared/protocol.js';
import type { Env as WorkerEnv } from '../types.js';
import {
  allocateWrapperRuntimeState,
  clearAllocatedWrapperRuntimeState,
  clearWrapperRuntimeIdentity,
  getWrapperLease,
  getWrapperRuntimeState,
  putWrapperLease,
  READY_ONLY_IDLE_MS,
  recordWrapperAcceptedMessage,
  recordWrapperReadyLease,
  reduceWrapperLease,
} from './wrapper-runtime-state.js';

export const WRAPPER_NO_OUTPUT_TIMEOUT_MS = 5 * 60 * 1000;
export const WRAPPER_PING_INTERVAL_MS = 60_000;
export const WRAPPER_STARTUP_TIMEOUT_MS = 10 * 60 * 1000;

export type AgentRuntimeOrchestrator = {
  execute(
    plan: FencedWrapperDispatchRequest,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
      leasedInstance?: WrapperInstanceLease;
    }
  ): Promise<ExecutionResult>;
};

export type AgentRuntimeAcceptedDelivery = {
  acceptedAt: number;
  wrapperRunId: string;
};

export type AgentRuntimeSendHooks = {
  onProgress?: (step: string, message: string) => void;
  onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
  onAccepted?: (delivery: AgentRuntimeAcceptedDelivery) => Promise<void>;
};

export type AgentRuntime = {
  send(plan: MessageDeliveryRequest, hooks?: AgentRuntimeSendHooks): Promise<MessageDeliveryResult>;
  requestSnapshot(): Promise<void>;
  interruptWrapper(): Promise<{ commandSent: boolean }>;
  sendPing(ingestTagId: string): void;
  keepSandboxAlive(): Promise<void>;
};

export type AgentRuntimeDependencies = {
  storage: DurableObjectStorage;
  env: WorkerEnv;
  getMetadata: () => Promise<SessionMetadata | null>;
  getSessionIdForLogs: () => string | undefined;
  sendToWrapper: (
    ingestTagId: string,
    command: WrapperCommand,
    fence?: { wrapperGeneration: number; wrapperConnectionId: string }
  ) => boolean;
  getOrchestratorOverride?: () => AgentRuntimeOrchestrator | undefined;
  createAgentSandbox?: (metadata: SessionMetadata) => AgentSandbox;
  discoverSessionWrappers?: (metadata: SessionMetadata) => Promise<WrapperObservation>;
  requestAlarmAtOrBefore?: (deadline: number) => Promise<void>;
};

function buildRuntimeAcceptanceResult(
  messageId: string,
  wrapperRunId: string
): MessageDeliveryResult {
  return {
    success: true,
    outcome: 'accepted',
    messageId,
    wrapperRunId,
  };
}

export function createAgentRuntime(dependencies: AgentRuntimeDependencies): AgentRuntime {
  const { storage, env, getMetadata, getSessionIdForLogs, sendToWrapper, getOrchestratorOverride } =
    dependencies;
  const resolveAgentSandbox =
    dependencies.createAgentSandbox ??
    ((metadata: SessionMetadata) => createAgentSandbox(env, metadata));
  let orchestrator: AgentRuntimeOrchestrator | undefined;

  function getOrchestrator(): AgentRuntimeOrchestrator {
    const override = getOrchestratorOverride?.();
    if (override) return override;

    if (!orchestrator) {
      orchestrator = new ExecutionOrchestrator({
        getAgentSandbox: plan => resolveAgentSandbox(plan.workspace.metadata),
        getSessionStub: (userId, sessionId) => {
          const doKey = `${userId}:${sessionId}`;
          const id = env.CLOUD_AGENT_SESSION.idFromName(doKey);
          return env.CLOUD_AGENT_SESSION.get(id);
        },
        env,
      });
    }

    return orchestrator;
  }

  async function resolveIngestTagId(): Promise<string | null> {
    const runtimeState = await getWrapperRuntimeState(storage);
    return runtimeState.wrapperRunId ?? null;
  }

  async function authorizePhysicalWrapper(plan: MessageDeliveryRequest): Promise<{
    leasedInstance: WrapperInstanceLease;
    allocatedPhysicalInstance: boolean;
    requiresFreshRunFence: boolean;
  }> {
    const current = await getWrapperLease(storage);
    if (current.state === 'stop_needed' || current.state === 'stopping') {
      throw new Error('Wrapper cleanup is required before delivery can launch');
    }

    const observeWrappers = () =>
      dependencies.discoverSessionWrappers
        ? dependencies.discoverSessionWrappers(plan.workspace.metadata)
        : resolveAgentSandbox(plan.workspace.metadata).discoverSessionWrappers();
    let allocatable = current;
    if (current.state === 'owns_wrapper') {
      const observation = await observeWrappers();
      const matchingObserved =
        observation.status === 'present' &&
        observation.observed.length === 1 &&
        observation.observed[0].instanceId === current.instance.instanceId &&
        observation.observed[0].instanceGeneration === current.instance.instanceGeneration;
      if (matchingObserved) {
        if (current.keepWarmUntil !== undefined) {
          const startupDeadlineAt = Date.now() + WRAPPER_STARTUP_TIMEOUT_MS;
          await putWrapperLease(
            storage,
            reduceWrapperLease(current, {
              type: 'reuse',
              instanceId: current.instance.instanceId,
              startupDeadlineAt,
            })
          );
          await dependencies.requestAlarmAtOrBefore?.(startupDeadlineAt);
        }
        return {
          leasedInstance: current.instance,
          allocatedPhysicalInstance: false,
          requiresFreshRunFence: current.keepWarmUntil !== undefined,
        };
      }
      if (observation.status === 'absent') {
        const verifiedAbsent = reduceWrapperLease(current, {
          type: 'owned_absent',
          instanceId: current.instance.instanceId,
        });
        if (verifiedAbsent.state !== 'none') {
          throw new Error('Verified wrapper absence did not release its physical lease');
        }
        allocatable = verifiedAbsent;
        await putWrapperLease(storage, allocatable);
      } else {
        const reason =
          observation.status === 'inspection-failed' ? 'observation-failed' : 'unexpected-wrapper';
        const now = Date.now();
        await putWrapperLease(
          storage,
          reduceWrapperLease(current, {
            type: 'request_stop',
            target: { kind: 'session' },
            reason,
            now,
          })
        );
        await dependencies.requestAlarmAtOrBefore?.(now);
        throw new Error('Wrapper cleanup is required before delivery can launch');
      }
    }

    const observation =
      allocatable === current ? await observeWrappers() : { status: 'absent' as const };
    if (observation.status !== 'absent') {
      const reason =
        observation.status === 'inspection-failed' ? 'observation-failed' : 'unexpected-wrapper';
      const now = Date.now();
      await putWrapperLease(
        storage,
        reduceWrapperLease(allocatable, {
          type: 'request_stop',
          target: { kind: 'session' },
          reason,
          now,
        })
      );
      await dependencies.requestAlarmAtOrBefore?.(now);
      throw new Error('Wrapper cleanup is required before delivery can launch');
    }

    const leasedInstance = {
      instanceId: `instance_${crypto.randomUUID().replace(/-/g, '')}`,
      instanceGeneration: allocatable.nextInstanceGeneration,
    } satisfies WrapperInstanceLease;
    const startupDeadlineAt = Date.now() + WRAPPER_STARTUP_TIMEOUT_MS;
    await putWrapperLease(
      storage,
      reduceWrapperLease(allocatable, {
        type: 'allocate',
        instance: leasedInstance,
        startupDeadlineAt,
      })
    );
    await dependencies.requestAlarmAtOrBefore?.(startupDeadlineAt);
    return { leasedInstance, allocatedPhysicalInstance: true, requiresFreshRunFence: false };
  }

  async function send(
    plan: MessageDeliveryRequest,
    hooks: AgentRuntimeSendHooks = {}
  ): Promise<MessageDeliveryResult> {
    const { sessionId } = plan.scope;
    const { turn, agent } = plan;
    const { leasedInstance, allocatedPhysicalInstance, requiresFreshRunFence } =
      await authorizePhysicalWrapper(plan);
    const previousRuntimeState = await getWrapperRuntimeState(storage);
    if (
      (allocatedPhysicalInstance || requiresFreshRunFence) &&
      (previousRuntimeState.wrapperConnectionId || previousRuntimeState.wrapperRunId)
    ) {
      await clearWrapperRuntimeIdentity(storage, {}, { incrementGeneration: true });
    }
    const { state: wrapperRuntimeState, allocatedNewIdentity } =
      await allocateWrapperRuntimeState(storage);
    logger
      .withFields({
        sessionId,
        messageId: turn.messageId,
        wrapperRunId: wrapperRuntimeState.wrapperRunId,
        wrapperGeneration: wrapperRuntimeState.wrapperGeneration,
        wrapperConnectionId: wrapperRuntimeState.wrapperConnectionId,
        allocatedNewIdentity,
        mode: agent.mode,
        model: agent.model,
      })
      .info('AgentRuntime delivering pending message to wrapper');

    const fencedPlan: FencedWrapperDispatchRequest = {
      ...plan,
      wrapper: {
        ...plan.wrapper,
        fence: {
          wrapperRunId: wrapperRuntimeState.wrapperRunId,
          wrapperGeneration: wrapperRuntimeState.wrapperGeneration,
          wrapperConnectionId: wrapperRuntimeState.wrapperConnectionId,
        },
      },
    };

    let wrapperReady = false;
    try {
      await getOrchestrator().execute(fencedPlan, {
        ...(leasedInstance ? { leasedInstance } : {}),
        onProgress: hooks.onProgress,
        onWorkspaceReady: async ready => {
          const readyAt = Date.now();
          const readyDeadlineAt = readyAt + READY_ONLY_IDLE_MS;
          await recordWrapperReadyLease(storage, wrapperRuntimeState, readyAt, readyDeadlineAt);
          if (leasedInstance) {
            const physicalLease = await getWrapperLease(storage);
            await putWrapperLease(
              storage,
              reduceWrapperLease(physicalLease, {
                type: 'startup_verified',
                instanceId: leasedInstance.instanceId,
                readyDeadlineAt,
              })
            );
            await dependencies.requestAlarmAtOrBefore?.(readyDeadlineAt);
          }
          wrapperReady = true;
          logger
            .withFields({
              sessionId,
              messageId: turn.messageId,
              wrapperRunId: wrapperRuntimeState.wrapperRunId,
              sandboxId: ready.sandboxId,
              workspacePath: ready.workspacePath,
            })
            .info('AgentRuntime wrapper workspace reported ready');
          await hooks.onWorkspaceReady?.(ready);
        },
      });

      const acceptedAt = Date.now();
      await recordWrapperAcceptedMessage(
        storage,
        wrapperRuntimeState,
        acceptedAt + WRAPPER_NO_OUTPUT_TIMEOUT_MS,
        acceptedAt + WRAPPER_PING_INTERVAL_MS
      );
      await hooks.onAccepted?.({
        acceptedAt,
        wrapperRunId: wrapperRuntimeState.wrapperRunId,
      });
      try {
        const acceptedLease = await getWrapperLease(storage);
        await putWrapperLease(
          storage,
          reduceWrapperLease(acceptedLease, {
            type: 'delivery_accepted',
            instanceId: leasedInstance.instanceId,
          })
        );
      } catch (error) {
        logger
          .withFields({
            sessionId,
            messageId: turn.messageId,
            wrapperRunId: wrapperRuntimeState.wrapperRunId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Failed to record accepted physical wrapper lease; maintenance will reconcile');
      }
      logger
        .withFields({
          sessionId,
          messageId: turn.messageId,
          wrapperRunId: wrapperRuntimeState.wrapperRunId,
          acceptedAt,
          noOutputDeadlineAt: acceptedAt + WRAPPER_NO_OUTPUT_TIMEOUT_MS,
          nextPingAt: acceptedAt + WRAPPER_PING_INTERVAL_MS,
        })
        .info('AgentRuntime wrapper accepted pending session message');
      return buildRuntimeAcceptanceResult(turn.messageId, wrapperRuntimeState.wrapperRunId);
    } catch (error) {
      logger
        .withFields({
          sessionId,
          messageId: turn.messageId,
          wrapperRunId: wrapperRuntimeState.wrapperRunId,
          wrapperReady,
          allocatedNewIdentity,
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        })
        .warn('AgentRuntime wrapper delivery failed');
      if (allocatedNewIdentity && leasedInstance) {
        const physicalLease = await getWrapperLease(storage);
        const now = Date.now();
        await putWrapperLease(
          storage,
          reduceWrapperLease(physicalLease, {
            type: 'request_stop',
            target: { kind: 'instance', instance: leasedInstance },
            reason: 'startup-failed',
            now,
          })
        );
        await dependencies.requestAlarmAtOrBefore?.(now);
        await clearAllocatedWrapperRuntimeState(storage, wrapperRuntimeState);
        logger
          .withFields({ sessionId, messageId: turn.messageId })
          .debug('Recorded cleanup for newly allocated wrapper after failed delivery');
      } else if (!allocatedNewIdentity) {
        const currentState = await getWrapperRuntimeState(storage);
        if (
          currentState.wrapperGeneration === wrapperRuntimeState.wrapperGeneration &&
          currentState.wrapperConnectionId === wrapperRuntimeState.wrapperConnectionId &&
          currentState.wrapperRunId === wrapperRuntimeState.wrapperRunId
        ) {
          logger
            .withFields({
              sessionId,
              messageId: turn.messageId,
              wrapperRunId: currentState.wrapperRunId,
            })
            .debug('Preserved existing runtime liveness after failed hot delivery');
        }
      }
      throw error;
    }
  }

  async function requestSnapshot(): Promise<void> {
    try {
      const ingestTagId = await resolveIngestTagId();
      if (!ingestTagId) return;
      sendToWrapper(ingestTagId, { type: 'request_snapshot' });
    } catch (error) {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('AgentRuntime failed to request wrapper snapshot');
    }
  }

  async function interruptWrapper(): Promise<{ commandSent: boolean }> {
    const runtimeState = await getWrapperRuntimeState(storage);
    if (!runtimeState.wrapperRunId || !runtimeState.wrapperConnectionId) {
      return { commandSent: false };
    }
    return {
      commandSent: sendToWrapper(
        runtimeState.wrapperRunId,
        { type: 'kill', signal: 'SIGTERM' },
        {
          wrapperGeneration: runtimeState.wrapperGeneration,
          wrapperConnectionId: runtimeState.wrapperConnectionId,
        }
      ),
    };
  }

  function sendPing(ingestTagId: string): void {
    sendToWrapper(ingestTagId, { type: 'ping' });
  }

  async function keepSandboxAlive(): Promise<void> {
    try {
      const metadata = await getMetadata();
      if (!metadata) return;
      await resolveAgentSandbox(metadata).keepAlive();
    } catch (error) {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('AgentRuntime failed to reset sandbox sleep timer');
    }
  }

  return {
    send,
    requestSnapshot,
    interruptWrapper,
    sendPing,
    keepSandboxAlive,
  };
}
