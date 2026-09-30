import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { SessionAttachPayload } from '../shared/sandbox-control-protocol.js';
import { materializeMcpServers } from '../mcp-config.js';
import { codeReviewIdFromCallbackTarget } from '../router/schemas.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../shared/runtime-environment.js';
import { readProfileBundle } from '../session-profile.js';
import { getSessionWorkspacePath } from '../workspace.js';

function rejectReservedControlRuntimeEnvironment(
  environment: Record<string, unknown> | undefined
): void {
  if (!environment) return;
  for (const key of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
    if (Object.hasOwn(environment, key)) {
      throw new Error(`Reserved control runtime environment variable: ${key}`);
    }
  }
}

export function validateControlSessionOptions(metadata: Pick<SessionMetadata, 'profile'>): void {
  const profile = readProfileBundle(metadata);
  rejectReservedControlRuntimeEnvironment(profile.envVars);
  rejectReservedControlRuntimeEnvironment(profile.encryptedSecrets);
}

function gitFromMetadata(
  metadata: SessionMetadata
): NonNullable<SessionAttachPayload['git']> | undefined {
  const repository = metadata.repository;
  if (!repository) return undefined;
  if (repository.type === 'github') {
    return {
      url: `https://github.com/${repository.repo}.git`,
      platform: 'github',
      ...(repository.token ? { token: repository.token } : {}),
    };
  }
  return {
    url: repository.url,
    ...(repository.type === 'gitlab'
      ? { platform: 'gitlab' as const }
      : repository.type === 'bitbucket'
        ? { platform: 'bitbucket' as const }
        : repository.platform
          ? { platform: repository.platform }
          : {}),
    ...('token' in repository && repository.token ? { token: repository.token } : {}),
  };
}

export function buildSessionAttachPayload(
  metadata: SessionMetadata,
  preparation?: SessionAttachPayload['preparation'],
  mcpPrivateKey?: string
): SessionAttachPayload {
  const directory =
    metadata.workspace?.workspacePath ??
    getSessionWorkspacePath(
      metadata.identity.orgId,
      metadata.identity.userId,
      metadata.identity.sessionId
    );
  const git = gitFromMetadata(metadata);
  const branch = metadata.workspace?.branchName ?? metadata.repository?.upstreamBranch;
  const branchMode =
    branch && metadata.workspace?.branchName === branch && !metadata.repository?.upstreamBranch
      ? 'working'
      : undefined;
  const profile = readProfileBundle(metadata);
  const bitbucketReviewId =
    metadata.identity.createdOnPlatform === 'code-review' &&
    metadata.repository?.type === 'bitbucket'
      ? codeReviewIdFromCallbackTarget(metadata.callback?.target)
      : null;
  validateControlSessionOptions(metadata);
  const env = {
    ...(profile.envVars ?? {}),
    ...(metadata.auth.kilocodeToken ? { KILOCODE_TOKEN: metadata.auth.kilocodeToken } : {}),
  };
  rejectReservedControlRuntimeEnvironment(env);
  return {
    directory,
    ...(branch ? { branch } : {}),
    ...(branchMode ? { branchMode } : {}),
    ...(metadata.auth.kiloSessionId ? { snapshotIdentity: metadata.auth.kiloSessionId } : {}),
    ...(git ? { git } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(bitbucketReviewId === null &&
    profile.mcpServers &&
    Object.keys(profile.mcpServers).length > 0
      ? { mcp: materializeMcpServers(profile.mcpServers, mcpPrivateKey) }
      : {}),
    ...(profile.setupCommands?.length ? { setupCommands: profile.setupCommands } : {}),
    ...(preparation ? { preparation } : {}),
  };
}

export function adaptSessionAttachPayloadForWrapper(
  payload: SessionAttachPayload,
  supportsWorkingBranches: boolean,
  supportsGitAuthor = false
): SessionAttachPayload {
  let adapted = payload;
  if (!supportsWorkingBranches && adapted.branchMode === 'working') {
    const { branch: _branch, branchMode: _branchMode, ...legacyPayload } = adapted;
    adapted = legacyPayload;
  }
  if (!supportsGitAuthor && adapted.git?.author) {
    const { author: _author, ...git } = adapted.git;
    adapted = { ...adapted, git };
  }
  return adapted;
}
