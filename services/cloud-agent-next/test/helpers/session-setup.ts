import { expect } from 'vitest';
import type { CloudAgentSession } from '../../src/persistence/CloudAgentSession.js';
import type { CallbackTarget } from '../../src/callbacks/index.js';
import type {
  LegacyRegisteredInitialAdmissionRequest,
  SubmittedSessionMessageRequest,
} from '../../src/execution/types.js';
import type { AgentMode } from '../../src/schema.js';
import type { Images } from '../../src/router/schemas.js';
import type { SessionProfileBundle } from '../../src/session-profile.js';

type RegisterSessionInput = Parameters<CloudAgentSession['registerSession']>[0];
type RecordSessionReadyInput = Parameters<CloudAgentSession['recordSessionReady']>[0];
type QueueSessionUserMessageInput = {
  userId: string;
  botId?: string;
  messageId?: string | null;
  prompt: string;
  mode?: AgentMode;
  model?: string;
  variant?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  images?: Images;
};

type TestRegisterSessionInput = {
  sessionId: string;
  userId: string;
  orgId?: string;
  botId?: string;
  prompt: string;
  mode: AgentMode;
  model: string;
  variant?: string;
  kiloSessionId?: string;
  kilocodeToken?: string;
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  platform?: 'github' | 'gitlab';
  upstreamBranch?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  appendSystemPrompt?: string;
  callbackTarget?: CallbackTarget;
  images?: Images;
  createdOnPlatform?: string;
  shallow?: boolean;
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
  initialMessageId?: string;
  initialTurn?:
    | {
        type: 'prompt';
        prompt: string;
        images?: Images;
      }
    | {
        type: 'command';
        command: string;
        arguments: string;
      };
  profile?: SessionProfileBundle;
};

/**
 * Shorthand input for session integration tests. The helper maps this legacy-looking
 * fixture shape to the grouped DO registration command so tests stay compact while
 * production DO methods only receive grouped parameters.
 */
export type RegisterReadySessionInput = TestRegisterSessionInput &
  Partial<
    Pick<
      RecordSessionReadyInput,
      | 'workspacePath'
      | 'sandboxId'
      | 'sessionHome'
      | 'branchName'
      | 'githubInstallationId'
      | 'githubAppType'
      | 'gitlabTokenManaged'
    >
  >;

type SessionRegistrar = Pick<CloudAgentSession, 'registerSession' | 'recordSessionReady'>;

const FALLBACK_KILO_SESSION_ID = 'ses_test_fallback_session_id_32';

export function groupedRegisterSessionInput(input: TestRegisterSessionInput): RegisterSessionInput {
  const repository: RegisterSessionInput['repository'] = input.githubRepo
    ? {
        type: 'github',
        repo: input.githubRepo,
        token: input.githubToken,
        branch: input.upstreamBranch,
      }
    : input.gitUrl && input.platform === 'gitlab'
      ? {
          type: 'gitlab',
          url: input.gitUrl,
          token: input.gitToken,
          branch: input.upstreamBranch,
        }
      : input.gitUrl
        ? {
            type: 'git',
            url: input.gitUrl,
            token: input.gitToken,
            platform: input.platform,
            branch: input.upstreamBranch,
          }
        : undefined;

  return {
    identity: {
      sessionId: input.sessionId,
      userId: input.userId,
      orgId: input.orgId,
      botId: input.botId,
      createdOnPlatform: input.createdOnPlatform,
    },
    auth: {
      kiloSessionId: input.kiloSessionId,
      kilocodeToken: input.kilocodeToken,
    },
    message: {
      initialMessageId: input.initialMessageId,
      turn: input.initialTurn
        ? { ...input.initialTurn, id: input.initialMessageId }
        : {
            type: 'prompt',
            id: input.initialMessageId,
            prompt: input.prompt,
            images: input.images,
          },
    },
    agent: {
      mode: input.mode,
      model: input.model,
      variant: input.variant,
      appendSystemPrompt: input.appendSystemPrompt,
    },
    repository,
    profile: input.profile,
    finalization: {
      autoCommit: input.autoCommit,
      condenseOnComplete: input.condenseOnComplete,
      gateThreshold: input.gateThreshold,
    },
    callback: input.callbackTarget ? { target: input.callbackTarget } : undefined,
    workspace: input.shallow === undefined ? undefined : { shallow: input.shallow },
  };
}

export function queueUserMessageInput(
  input: QueueSessionUserMessageInput
): SubmittedSessionMessageRequest {
  return {
    userId: input.userId,
    botId: input.botId,
    turn: {
      type: 'prompt',
      id: input.messageId,
      prompt: input.prompt,
      images: input.images,
    },
    agent: {
      mode: input.mode,
      model: input.model,
      variant: input.variant,
    },
    finalization: {
      autoCommit: input.autoCommit,
      condenseOnComplete: input.condenseOnComplete,
    },
  };
}

export function queueRegisteredInitialInput(input: {
  userId: string;
  botId?: string;
}): LegacyRegisteredInitialAdmissionRequest {
  return {
    userId: input.userId,
    botId: input.botId,
  };
}

/**
 * Register a cloud-agent session and immediately mark it ready for tests that
 * need a session in the "workspace fields populated" state (warm-followup flush
 * policy, accepted-execution callbacks, interrupt semantics, and so on).
 *
 * Sensible defaults are filled in for the workspace-ready fields (including a
 * stable synthetic kiloSessionId) when the caller doesn't supply them so that
 * call sites that only care about the "session is prepared" bit can register
 * with the minimal input shape.
 */
export async function registerReadySession(
  instance: SessionRegistrar,
  input: RegisterReadySessionInput
): Promise<void> {
  const registerResult = await instance.registerSession(groupedRegisterSessionInput(input));
  expect(registerResult.success).toBe(true);

  const readyResult = await instance.recordSessionReady({
    workspacePath: input.workspacePath ?? `/workspace/${input.userId}/sessions/${input.sessionId}`,
    sandboxId: input.sandboxId ?? 'usr-123456789abc',
    sessionHome: input.sessionHome ?? `/home/${input.sessionId}`,
    branchName: input.branchName ?? input.upstreamBranch ?? `session/${input.sessionId}`,
    kiloSessionId: input.kiloSessionId ?? FALLBACK_KILO_SESSION_ID,
    githubInstallationId: input.githubInstallationId,
    githubAppType: input.githubAppType,
    gitToken: input.gitToken,
    gitlabTokenManaged: input.gitlabTokenManaged,
  });
  expect(readyResult.success).toBe(true);
}
