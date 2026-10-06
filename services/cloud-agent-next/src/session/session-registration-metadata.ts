/**
 * Plane-neutral session-metadata construction for session registration.
 *
 * The JSON shape here is the one both planes persist: the legacy
 * `CloudAgentSession` DO builds its stored metadata through
 * `buildSessionMetadataFromRegistration`, and the control-plane Worker builds
 * the `createSessionWithInitialAdmission`/`registerSessionFromMetadata` input
 * through the same function. One owner means a registration field can never
 * mean two different things depending on the plane.
 */
import { generateBranchSlug } from '@kilocode/worker-utils/deployment-slug';
import { serializeSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';
import { deriveSharedSandboxId } from '../sandbox-id.js';
import { readProfileBundle, type SessionProfileBundle } from '../session-profile.js';
import { BUILTIN_AGENT_MODES } from '../schema.js';
import type {
  AgentSelection,
  ExecutionTurnSubmission,
  SessionFinalization,
} from '../execution/types.js';
import type { SessionRepositoryRequest } from './session-requests.js';

export type GroupedRegisterSessionInput = {
  identity: SessionMetadata['identity'];
  auth: SessionMetadata['auth'];
  runtimeAuthorizationSeal?: string;
  clone?: SessionMetadata['clone'];
  /** Omitted for a clone-only create: no synthetic initial turn is registered. */
  message?: {
    initialMessageId?: string;
    turn: ExecutionTurnSubmission;
  };
  agent: AgentSelection & {
    appendSystemPrompt?: string;
  };
  repository?: SessionRepositoryRequest;
  profile?: SessionProfileBundle;
  finalization?: SessionFinalization;
  callback?: SessionMetadata['callback'];
  workspace?: Pick<
    NonNullable<SessionMetadata['workspace']>,
    | 'sandboxId'
    | 'sandboxRoute'
    | 'sandboxProvider'
    | 'shallow'
    | 'credentialContainment'
    | 'devcontainerRequested'
    | 'sandboxAllocation'
  >;
};

export type BuildSessionMetadataResult =
  | { ok: true; metadata: SessionMetadata }
  | { ok: false; error: string };

function repositoryMetadataFromRegistrationInput(
  repository: GroupedRegisterSessionInput['repository']
): SessionMetadata['repository'] | undefined {
  if (!repository) return undefined;

  switch (repository.type) {
    case 'github':
      return {
        type: 'github',
        repo: repository.repo,
        githubAccessPurpose: repository.githubAccessPurpose ?? 'workflow',
        ...(repository.githubIntegrationId
          ? { githubIntegrationId: repository.githubIntegrationId }
          : {}),
        ...(repository.pullRequestNumber !== undefined
          ? { pullRequestNumber: repository.pullRequestNumber }
          : {}),
        upstreamBranch: repository.branch,
      };
    case 'gitlab':
      return {
        type: 'gitlab',
        url: repository.url,
        platform: 'gitlab',
        upstreamBranch: repository.branch,
      };
    case 'bitbucket':
      return {
        type: 'bitbucket',
        url: repository.url,
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
        bitbucketIntegrationId: repository.bitbucketIntegrationId,
        upstreamBranch: repository.branch,
      };
    case 'git':
      return {
        type: 'git',
        url: repository.url,
        token: repository.token,
        upstreamBranch: repository.branch,
      };
  }

  throw new Error('repository.type must be github, gitlab, bitbucket, or git');
}

export async function validateSharedSandboxRouteAssignment(workspace: {
  sandboxId?: string;
  sandboxRoute?: NonNullable<SessionMetadata['workspace']>['sandboxRoute'];
}): Promise<string | null> {
  const route = workspace.sandboxRoute;
  if (!route) return null;
  try {
    const expectedSandboxId = route.suffix
      ? await deriveSharedSandboxId(route.routeKey, route.suffix)
      : route.routeKey;
    return workspace.sandboxId === expectedSandboxId
      ? null
      : 'Shared sandbox assignment does not match its route suffix';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function validateModeAgainstRuntimeAgents(
  metadata: SessionMetadata,
  mode = metadata.agent?.mode
): string | null {
  if (!mode || BUILTIN_AGENT_MODES.has(mode)) return null;

  const knownSlugs = new Set((readProfileBundle(metadata).runtimeAgents ?? []).map(a => a.slug));
  if (knownSlugs.has(mode)) return null;

  return `Mode "${mode}" is not a built-in and does not match any runtimeAgents on this session`;
}

function initialMessageFromRegistration(
  message: GroupedRegisterSessionInput['message']
): SessionMetadata['initialMessage'] {
  if (!message) return undefined;
  return {
    id: message.initialMessageId ?? message.turn.id ?? undefined,
    prompt:
      message.turn.type === 'prompt'
        ? message.turn.prompt
        : message.turn.arguments.length > 0
          ? `/${message.turn.command} ${message.turn.arguments}`
          : `/${message.turn.command}`,
    attachments: message.turn.type === 'prompt' ? message.turn.attachments : undefined,
    turn:
      message.turn.type === 'prompt'
        ? {
            type: 'prompt',
            prompt: message.turn.prompt,
            attachments: message.turn.attachments,
          }
        : {
            type: 'command',
            command: message.turn.command,
            arguments: message.turn.arguments,
          },
  };
}

/**
 * Builds and validates the grouped `SessionMetadata` a registration persists.
 * The error strings match the legacy `registerSession` rejections exactly so the
 * Worker maps a rejection to the same failure as before.
 */
export async function buildSessionMetadataFromRegistration(
  input: GroupedRegisterSessionInput,
  now = Date.now()
): Promise<BuildSessionMetadataResult> {
  const routeAssignmentError = await validateSharedSandboxRouteAssignment(input.workspace ?? {});
  if (routeAssignmentError) {
    return { ok: false, error: `Invalid metadata: ${routeAssignmentError}` };
  }

  let repository: SessionMetadata['repository'];
  try {
    repository = repositoryMetadataFromRegistrationInput(input.repository);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const initialMessage = initialMessageFromRegistration(input.message);
  const metadata: SessionMetadata = {
    metadataSchemaVersion: 2,
    identity: input.identity,
    auth: input.auth,
    // Metadata without clone remains an empty-session bootstrap; remove
    // this fallback only after old prepared sessions age out.
    clone: input.clone,
    repository,
    ...(initialMessage ? { initialMessage } : {}),
    agent: {
      mode: input.agent.mode,
      model: input.agent.model,
      variant: input.agent.variant,
      appendSystemPrompt: input.agent.appendSystemPrompt,
    },
    finalization: input.finalization,
    profile: input.profile,
    callback: input.callback,
    workspace: {
      ...input.workspace,
      sandboxProvider: input.workspace?.sandboxProvider ?? 'cloudflare',
      branchName: repository?.upstreamBranch ?? `kilo/${generateBranchSlug()}`,
    },
    lifecycle: {
      version: now,
      timestamp: now,
    },
  };

  let serialized: SessionMetadata;
  try {
    serialized = serializeSessionMetadata(metadata);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const modeError = validateModeAgainstRuntimeAgents(serialized);
  if (modeError) {
    return { ok: false, error: modeError };
  }

  return { ok: true, metadata: serialized };
}
