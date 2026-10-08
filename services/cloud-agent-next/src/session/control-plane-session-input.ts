/**
 * Worker-side projections from the public grouped create/send inputs onto the
 * control-plane V2 Durable Object RPCs.
 *
 * The Worker owns sandbox selection and materializes the canonical prompt
 * payload (plan H2, `docs/control-plane.md` §5); the DO records what it is
 * given rather than re-deriving it. This module is the single place those
 * projections live, so the handler boundary never spreads V2 protocol fields
 * across call sites.
 */
import {
  getSandboxAllocationInstance,
  getSandboxAllocationResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { ControlPlanePromptPayload } from '../shared/control-plane-protocol.js';
import type { ControlPlaneSandboxSelection } from '../control-plane/session/sandbox-selection.js';
import type {
  AcceptedExecutionTurn,
  ExecutionTurnSubmission,
  SessionFinalization,
} from '../execution/types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env, SandboxId } from '../types.js';
import type { SessionId } from '../types/ids.js';
import { buildSandboxBillingInput } from '../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import { buildSignedPromptAttachments } from '../execution/attachment-prompt-parts.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import { createMessageId } from './message-id.js';
import {
  buildSessionMetadataFromRegistration,
  type GroupedRegisterSessionInput,
} from './session-registration-metadata.js';

/** Materialized prompt attachment (`buildSignedPromptAttachments` output). */
export type MaterializedPromptAttachment = {
  filename: string;
  signedUrl: string;
  localPath: string;
  mime: string;
};

export class ControlPlaneRegistrationError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ControlPlaneRegistrationError';
  }
}

/** A control-plane message could not be projected from the public input. */
export class ControlPlaneMessageInputError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ControlPlaneMessageInputError';
  }
}

/**
 * Builds the V2 prompt payload for a submitted turn: resolves the effective
 * agent (override over the registered defaults) and materializes attachments,
 * so every control-plane send path (queue, facade, answers) admits the same
 * fully-resolved intent.
 */
export async function buildControlPlaneMessagePayload(input: {
  env: Env;
  userId: string;
  sessionId: SessionId;
  metadata: SessionMetadata;
  turn: ExecutionTurnSubmission | AcceptedExecutionTurn;
  finalization?: SessionFinalization;
  agentOverride?: { mode?: string; model?: string; variant?: string };
  messageId?: string;
}): Promise<ControlPlanePromptPayload> {
  const messageId =
    input.messageId ?? ('id' in input.turn ? input.turn.id : undefined) ?? createMessageId();
  const attachments =
    input.turn.type === 'prompt'
      ? await buildSignedPromptAttachments({
          env: input.env,
          userId: input.userId,
          sessionId: input.sessionId,
          attachments: input.turn.attachments,
          createdOnPlatform: input.metadata.identity.createdOnPlatform,
        })
      : [];
  const mode = input.agentOverride?.mode ?? input.metadata.agent?.mode;
  const model = input.agentOverride?.model ?? input.metadata.agent?.model;
  if (mode === undefined || (input.turn.type === 'prompt' && model === undefined)) {
    throw new ControlPlaneMessageInputError('Session is missing a valid agent selection');
  }
  return buildControlPlanePromptPayload({
    messageId,
    turn: input.turn,
    attachments,
    finalization: input.finalization,
    agent: {
      mode,
      ...(model === undefined ? {} : { model }),
      ...((input.agentOverride?.variant ?? input.metadata.agent?.variant) === undefined
        ? {}
        : { variant: input.agentOverride?.variant ?? input.metadata.agent?.variant }),
    },
  });
}

/**
 * Builds the V2 prompt payload from a submitted or canonical turn. `agent` is
 * resolved by the caller (override merged over registered defaults) because the
 * V2 protocol admits fully-resolved selections only. The wrapper-facing
 * `agent.model` is the dispatched id (provider prefix stripped, exactly as the
 * legacy `dispatchedKilocodeModelId` does for prompt/command/compact); the full
 * id stays in stored metadata and preflight. The payload is validated by the
 * DO's strict schema; the cast only bridges the schema's non-discriminated
 * union to its inferred type.
 */
export function buildControlPlanePromptPayload(input: {
  messageId: string;
  turn: ExecutionTurnSubmission | AcceptedExecutionTurn;
  attachments: MaterializedPromptAttachment[];
  finalization?: SessionFinalization;
  agent: { mode: string; model?: string; variant?: string };
}): ControlPlanePromptPayload {
  const turn =
    input.turn.type === 'prompt'
      ? { type: 'prompt' as const, prompt: input.turn.prompt }
      : {
          type: 'command' as const,
          command: input.turn.command,
          arguments: input.turn.arguments,
        };
  const dispatchedModel = dispatchedKilocodeModelId(input.agent.model);
  return {
    messageId: input.messageId,
    ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    ...(input.finalization
      ? {
          finalization: {
            ...(input.finalization.autoCommit === undefined
              ? {}
              : { autoCommit: input.finalization.autoCommit }),
            ...(input.finalization.condenseOnComplete === undefined
              ? {}
              : { condenseOnComplete: input.finalization.condenseOnComplete }),
          },
        }
      : {}),
    turn,
    agent: {
      mode: input.agent.mode,
      ...(dispatchedModel === undefined ? {} : { model: dispatchedModel }),
      ...(input.agent.variant === undefined ? {} : { variant: input.agent.variant }),
    },
  } as ControlPlanePromptPayload;
}

/**
 * The provider pin for a registered session. Derives the selection from the
 * already-chosen metadata, exactly as the legacy DO did at sandbox creation:
 * the provider names the adapter, the allocation names its configuration, and
 * billing attribution is always present so enforcement is not silently skipped.
 */
export function buildControlPlaneSandboxSelection(
  metadata: SessionMetadata,
  env: Env,
  sandboxId: SandboxId
): ControlPlaneSandboxSelection {
  const provider = metadata.workspace?.sandboxProvider ?? 'cloudflare';
  const allocation = metadata.workspace?.sandboxAllocation;
  const sandboxKind = metadata.workspace?.sandboxKind;
  const enforcementRequested = isCloudAgentContainerBillingEnabled(env, metadata.identity);
  const billing = {
    ...buildSandboxBillingInput(metadata, sandboxId, enforcementRequested),
    enforcementRequested,
  };
  const pinned = { billing, ...(sandboxKind ? { sandboxKind } : {}) };
  if (provider === 'vercel') {
    const resources = getSandboxAllocationResources(allocation ?? 'vercel-small');
    return {
      provider,
      configuration: resources === undefined ? { provider } : { provider, resources },
      ...pinned,
    };
  }
  if (provider === 'cloudflare-containers') {
    const instance = getSandboxAllocationInstance(allocation);
    return {
      provider,
      configuration: instance === undefined ? { provider } : { provider, instance },
      ...pinned,
    };
  }
  return { provider, configuration: { provider }, ...pinned };
}

async function buildMetadata(
  command: GroupedRegisterSessionInput
): Promise<{ metadata: SessionMetadata; sandboxId: SandboxId }> {
  const built = await buildSessionMetadataFromRegistration(command);
  if (!built.ok) {
    throw new ControlPlaneRegistrationError(built.error);
  }
  const sandboxId = built.metadata.workspace?.sandboxId;
  if (sandboxId === undefined || sandboxId.length === 0) {
    throw new ControlPlaneRegistrationError('Session metadata requires a sandboxId');
  }
  return { metadata: built.metadata, sandboxId: sandboxId as SandboxId };
}

/**
 * The V2 `createSessionWithInitialAdmission` input. `command.message` carries
 * the canonical initial turn built by `buildSessionRegistrationCommand`; the
 * Worker materializes its attachments before the RPC because the DO does not
 * read R2.
 */
export async function buildControlPlaneCreateInput(input: {
  command: GroupedRegisterSessionInput;
  env: Env;
  attachments: MaterializedPromptAttachment[];
  agent: { mode: string; model?: string; variant?: string };
}): Promise<{
  metadata: SessionMetadata;
  message: ControlPlanePromptPayload;
  sandboxSelection: ControlPlaneSandboxSelection;
  runtimeAuthorizationSeal?: string;
}> {
  const { metadata, sandboxId } = await buildMetadata(input.command);
  const message = input.command.message;
  const initialMessageId = message?.initialMessageId ?? message?.turn.id ?? undefined;
  if (message === undefined || initialMessageId === undefined) {
    throw new ControlPlaneRegistrationError('Initial admission requires an initial turn');
  }
  return {
    metadata,
    message: buildControlPlanePromptPayload({
      messageId: initialMessageId,
      turn: message.turn,
      attachments: input.attachments,
      finalization: input.command.finalization,
      agent: input.agent,
    }),
    sandboxSelection: buildControlPlaneSandboxSelection(metadata, input.env, sandboxId),
    ...(input.command.runtimeAuthorizationSeal === undefined
      ? {}
      : { runtimeAuthorizationSeal: input.command.runtimeAuthorizationSeal }),
  };
}

/** The V2 `registerSessionFromMetadata` input (clone-only / lazy preparation). */
export async function buildControlPlaneRegisterInput(input: {
  command: GroupedRegisterSessionInput;
  env: Env;
}): Promise<{
  metadata: SessionMetadata;
  sandboxSelection: ControlPlaneSandboxSelection;
  runtimeAuthorizationSeal?: string;
}> {
  const { metadata, sandboxId } = await buildMetadata(input.command);
  return {
    metadata,
    sandboxSelection: buildControlPlaneSandboxSelection(metadata, input.env, sandboxId),
    ...(input.command.runtimeAuthorizationSeal === undefined
      ? {}
      : { runtimeAuthorizationSeal: input.command.runtimeAuthorizationSeal }),
  };
}
