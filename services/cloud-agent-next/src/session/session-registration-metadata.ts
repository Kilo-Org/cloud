/** Builds the grouped metadata used by control-plane session registration. */
import { generateBranchSlug } from '@kilocode/worker-utils/deployment-slug';
import { sessionReferenceOf, type EnvironmentScope } from '../environment-build/reference.js';
import {
  isLegacySharedSandboxWorkspace,
  serializeSessionMetadata,
  type SessionMetadata,
} from '../persistence/session-metadata.js';
import { readProfileBundle, type SessionProfileBundle } from '../session-profile.js';
import { BUILTIN_AGENT_MODES } from '../schema.js';
import { isRepositoryAgentOrigin } from '../shared/agent-modes.js';
import type {
  AgentSelection,
  ExecutionTurnSubmission,
  SessionFinalization,
} from '../execution/types.js';
import { launchRepositoryIdentity } from './environment-launch.js';
import type { SessionRepositoryRequest } from './session-requests.js';
import type { EnvironmentSetupBinding } from '../shared/environment-setup.js';

export type GroupedRegisterSessionInput = {
  allowSubagentSessions?: boolean;
  parentCloudAgentSessionId?: string;
  identity: SessionMetadata['identity'];
  auth: SessionMetadata['auth'];
  runtimeAuthorizationSeal?: string;
  clone?: SessionMetadata['clone'];
  /** Server-only continuation marker; never client-controlled. */
  continuation?: boolean;
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
  /** The environment scope preflight authorized; registration adds the branch of each V2 repository. */
  environment?: EnvironmentScope;
  /** The environment setup role preflight bound; never client-controlled. */
  environmentSetup?: EnvironmentSetupBinding;
  /** The additional-repository branches the client requested for the environment. */
  requestedEnvironmentRepositories?: { repoFullName: string; branch?: string }[];
  finalization?: SessionFinalization;
  callback?: SessionMetadata['callback'];
  workspace?: Pick<
    NonNullable<SessionMetadata['workspace']>,
    | 'sandboxId'
    | 'sandboxKind'
    | 'sandboxProvider'
    | 'sandboxProviderBinding'
    | 'shallow'
    | 'credentialContainment'
    | 'devcontainerRequested'
    | 'sandboxAllocation'
    | 'egressMode'
    | 'egressAllowlist'
    | 'egressAudit'
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
        ...(repository.allowUserAuthorization === undefined
          ? {}
          : { allowUserAuthorization: repository.allowUserAuthorization }),
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

export function validateModeAgainstRuntimeAgents(
  metadata: SessionMetadata,
  mode = metadata.agent?.mode
): string | null {
  // Only internal automation can stamp the Worker-owned billing origin.
  const { billingOrigin, createdOnPlatform } = metadata.identity;
  if (
    !mode ||
    BUILTIN_AGENT_MODES.has(mode) ||
    (billingOrigin === createdOnPlatform && isRepositoryAgentOrigin(billingOrigin))
  )
    return null;

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
 * The environment reference a session stores: the authorized scope, and for a V2
 * environment the branch each repository resolved to. A V2 reference needs the
 * launch repository to tell it from the additional ones.
 */
function environmentReferenceFromRegistration(
  input: Pick<
    GroupedRegisterSessionInput,
    'environment' | 'repository' | 'requestedEnvironmentRepositories'
  >,
  generatedBranch: string
):
  | { ok: true; reference: SessionMetadata['environment'] | undefined }
  | { ok: false; error: string } {
  const scope = input.environment;
  if (scope === undefined) return { ok: true, reference: undefined };
  if (scope.repositories === undefined) {
    return { ok: true, reference: scope };
  }
  const launch = input.repository ? launchRepositoryIdentity(input.repository) : undefined;
  if (launch === undefined) {
    return {
      ok: false,
      error: 'Invalid metadata: a multi-repository environment needs a launch repository',
    };
  }
  return {
    ok: true,
    reference: sessionReferenceOf(scope, {
      generatedBranch,
      launch,
      launchBranch: input.repository?.branch,
      requested: input.requestedEnvironmentRepositories ?? [],
    }),
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
  // Every sandbox serves one workspace: a registration never places a session
  // on a retired shared sandbox.
  if (isLegacySharedSandboxWorkspace(input.workspace)) {
    return { ok: false, error: 'Invalid metadata: shared sandboxes are retired' };
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

  const generatedBranch = `kilo/${generateBranchSlug()}`;
  const environment = environmentReferenceFromRegistration(input, generatedBranch);
  if (!environment.ok) return environment;

  const initialMessage = initialMessageFromRegistration(input.message);
  const metadata: SessionMetadata = {
    metadataSchemaVersion: 2,
    allowSubagentSessions: input.allowSubagentSessions ?? false,
    parentCloudAgentSessionId: input.parentCloudAgentSessionId,
    identity: input.identity,
    auth: input.auth,
    // Metadata without clone remains an empty-session bootstrap; remove
    // this fallback only after old prepared sessions age out.
    clone: input.clone,
    ...(input.continuation ? { continuation: true as const } : {}),
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
    ...(environment.reference ? { environment: environment.reference } : {}),
    environmentSetup: input.environmentSetup,
    callback: input.callback,
    workspace: {
      ...input.workspace,
      sandboxProvider: input.workspace?.sandboxProvider ?? 'cloudflare',
      branchName: repository?.upstreamBranch ?? generatedBranch,
      ...(environment.reference?.repositories ? { generatedBranchName: generatedBranch } : {}),
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
