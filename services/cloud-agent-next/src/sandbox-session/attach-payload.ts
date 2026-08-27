import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { SessionAttachPayload } from '../shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../shared/runtime-environment.js';
import { resolveGitHubTokenForRepo } from '../services/git-token-service-client.js';
import { readProfileBundle } from '../session-profile.js';
import type { GitTokenService } from '../types.js';
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
  preparation?: SessionAttachPayload['preparation']
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
  const profile = readProfileBundle(metadata);
  rejectReservedControlRuntimeEnvironment(profile.envVars);
  rejectReservedControlRuntimeEnvironment(profile.encryptedSecrets);
  const env = {
    ...(profile.envVars ?? {}),
    ...(metadata.auth.kilocodeToken ? { KILOCODE_TOKEN: metadata.auth.kilocodeToken } : {}),
  };
  rejectReservedControlRuntimeEnvironment(env);
  return {
    directory,
    ...(branch ? { branch } : {}),
    ...(metadata.auth.kiloSessionId ? { snapshotIdentity: metadata.auth.kiloSessionId } : {}),
    ...(git ? { git } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(profile.setupCommands?.length ? { setupCommands: profile.setupCommands } : {}),
    ...(preparation ? { preparation } : {}),
  };
}

export async function fillAttachGitToken(
  metadata: SessionMetadata,
  payload: SessionAttachPayload,
  env: { GIT_TOKEN_SERVICE?: GitTokenService }
): Promise<SessionAttachPayload> {
  if (!payload.git || payload.git.token) return payload;
  const repository = metadata.repository;
  if (repository?.type !== 'github') return payload;
  const resolved = await resolveGitHubTokenForRepo(env, {
    githubRepo: repository.repo,
    userId: metadata.identity.userId,
    ...(metadata.identity.orgId ? { orgId: metadata.identity.orgId } : {}),
    ...(repository.githubIntegrationId
      ? { expectedIntegrationId: repository.githubIntegrationId }
      : {}),
  });
  if (!resolved.success) return payload;
  return { ...payload, git: { ...payload.git, token: resolved.value.token } };
}
