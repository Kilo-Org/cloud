import { getSandbox } from '@cloudflare/sandbox';
import { SANDBOX_SLEEP_AFTER_SECONDS } from '../core/lease.js';
import { ExecutionOrchestrator } from '../execution/orchestrator.js';
import type {
  ExecutionResult,
  FencedWrapperDispatchRequest,
  MessageDeliveryRequest,
  MessageDeliveryResult,
  WorkspaceReady,
} from '../execution/types.js';
import { logger } from '../logger.js';
import { stopWrapper } from '../kilo/wrapper-manager.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';
import type { WrapperCommand } from '../shared/protocol.js';
import type { Env as WorkerEnv, SandboxInstance } from '../types.js';
import {
  allocateWrapperRuntimeState,
  clearAllocatedWrapperRuntimeState,
  getWrapperRuntimeState,
  recordWrapperAcceptedMessage,
  recordWrapperReadyLease,
} from './wrapper-runtime-state.js';

export const WRAPPER_NO_OUTPUT_TIMEOUT_MS = 5 * 60 * 1000;
export const WRAPPER_PING_INTERVAL_MS = 60_000;

type RuntimeSandboxOptions = {
  sleepAfter?: number;
};

type RuntimeSandboxResolver = (
  sandboxId: string,
  options?: RuntimeSandboxOptions
) => SandboxInstance;

type RuntimeWrapperStopper = (sandbox: SandboxInstance, sessionId: string) => Promise<void>;

export type AgentRuntimeOrchestrator = {
  execute(
    plan: FencedWrapperDispatchRequest,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
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

export type AgentRuntimeStopReason =
  | 'idle-timeout'
  | 'unhealthy-wrapper'
  | 'keep-warm-expired'
  | 'user-interrupt';

export type AgentRuntime = {
  send(plan: MessageDeliveryRequest, hooks?: AgentRuntimeSendHooks): Promise<MessageDeliveryResult>;
  requestSnapshot(): Promise<void>;
  interruptWrapper(): Promise<{ commandSent: boolean }>;
  sendPing(ingestTagId: string): void;
  keepSandboxAlive(): Promise<void>;
  stopWrapperProcess(reason: AgentRuntimeStopReason): Promise<boolean>;
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
  resolveSandbox?: RuntimeSandboxResolver;
  stopRuntimeWrapper?: RuntimeWrapperStopper;
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
  const resolveSandbox: RuntimeSandboxResolver =
    dependencies.resolveSandbox ??
    ((sandboxId, options) => getSandbox(getSandboxNamespace(env, sandboxId), sandboxId, options));
  const stopRuntimeWrapper = dependencies.stopRuntimeWrapper ?? stopWrapper;
  let orchestrator: AgentRuntimeOrchestrator | undefined;

  function getOrchestrator(): AgentRuntimeOrchestrator {
    const override = getOrchestratorOverride?.();
    if (override) return override;

    if (!orchestrator) {
      orchestrator = new ExecutionOrchestrator({
        getSandbox: async sandboxId =>
          resolveSandbox(sandboxId, { sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS }),
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

  async function send(
    plan: MessageDeliveryRequest,
    hooks: AgentRuntimeSendHooks = {}
  ): Promise<MessageDeliveryResult> {
    const { sessionId } = plan.scope;
    const { turn, agent } = plan;
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
        onProgress: hooks.onProgress,
        onWorkspaceReady: async ready => {
          await recordWrapperReadyLease(storage, wrapperRuntimeState);
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
      if (allocatedNewIdentity && !wrapperReady) {
        await clearAllocatedWrapperRuntimeState(storage, wrapperRuntimeState);
        logger
          .withFields({ sessionId, messageId: turn.messageId })
          .debug('Cleared newly allocated runtime wrapper state after failed delivery');
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

  async function resolveRuntimeSandbox(metadata: SessionMetadata): Promise<SandboxInstance> {
    const sandboxId =
      metadata.workspace?.sandboxId ??
      (await generateSandboxId(
        env.PER_SESSION_SANDBOX_ORG_IDS,
        metadata.identity.orgId,
        metadata.identity.userId,
        metadata.identity.sessionId,
        metadata.identity.botId
      ));
    return resolveSandbox(sandboxId);
  }

  async function keepSandboxAlive(): Promise<void> {
    try {
      const metadata = await getMetadata();
      if (!metadata) return;
      const sandbox = await resolveRuntimeSandbox(metadata);
      await Promise.resolve(sandbox.renewActivityTimeout());
    } catch (error) {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('AgentRuntime failed to reset sandbox sleep timer');
    }
  }

  async function stopWrapperProcess(reason: AgentRuntimeStopReason): Promise<boolean> {
    try {
      const metadata = await getMetadata();
      if (!metadata) return false;
      const sandbox = await resolveRuntimeSandbox(metadata);
      await stopRuntimeWrapper(sandbox, metadata.identity.sessionId);
      return true;
    } catch (error) {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          reason,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('AgentRuntime failed to stop wrapper process');
      return false;
    }
  }

  return {
    send,
    requestSnapshot,
    interruptWrapper,
    sendPing,
    keepSandboxAlive,
    stopWrapperProcess,
  };
}
