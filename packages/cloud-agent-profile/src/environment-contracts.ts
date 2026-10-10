import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import type { EncryptedEnvelope } from '@kilocode/encryption';
import { MASKED_SECRET_VALUE, type ProfileOwner } from './types';

/** Owner of a repository environment - exactly one of organization or user. */
export type EnvironmentOwner = ProfileOwner;

export type EnvironmentPlatform = 'github' | 'gitlab' | 'bitbucket';

/**
 * Per-field caps that survive every later boundary. Launch input allows 50
 * vars, 128-char keys, 256-char resolved plaintext values, and 20 commands of
 * 500; the control-plane frame allows 8192-char env values, which is why a
 * secret plaintext may be longer than a plaintext var.
 */
export const ENVIRONMENT_LIMITS = {
  MAX_NAME_LENGTH: 100,
  MAX_KEY_LENGTH: 128,
  MAX_PLAINTEXT_VALUE_LENGTH: 256,
  MAX_SECRET_VALUE_LENGTH: 8192,
  MAX_VARS: 50,
  MAX_COMMANDS: 20,
  MAX_COMMAND_LENGTH: 500,
} as const;

export const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const encryptedEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

/**
 * Keys the sandbox runtime owns. Mirrors
 * `services/cloud-agent-next/src/types.ts` `RESERVED_ENV_VARS` and
 * `services/cloud-agent-next/src/shared/runtime-environment.ts`
 * `CONTROL_RUNTIME_RESERVED_ENV_VARS`, plus the prefixes
 * `worktree-runtime.ts` drops. The profile package must not import from the
 * service, so the list is mirrored here; `environment-contracts.test.ts`
 * guards the documented contents.
 */
const RESERVED_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  'HOME',
  'SESSION_ID',
  'SESSION_HOME',
  'pnpm_config_store_dir',
  'SANDBOX_CONTROL_CREDENTIAL',
  'SANDBOX_CONTROL_URL',
  'PROVIDER_INSTANCE_ID',
  'CONTROL_LOG_UPLOAD_URL',
  'CONTROL_LOG_UPLOAD_GRANT',
  'CONTROL_WRAPPER_INSTANCE_ID',
]);

const RESERVED_ENV_VAR_PREFIXES = ['XDG_', 'KILO', 'OPENCODE'] as const;

export function isReservedEnvironmentKey(key: string): boolean {
  return (
    RESERVED_ENV_VAR_NAMES.has(key) ||
    RESERVED_ENV_VAR_PREFIXES.some(prefix => key.startsWith(prefix))
  );
}

export type EnvironmentRepositoryIdentity =
  | { platform: 'github'; repoFullName: string }
  | { platform: 'gitlab'; cloneUrl: string }
  | { platform: 'bitbucket'; workspaceUuid: string; repositoryUuid: string };

/** Normalized identity columns as stored on `cloud_agent_environments`. */
export type EnvironmentIdentityColumns = {
  repo_full_name: string;
  gitlab_clone_url: string | null;
  bitbucket_workspace_uuid: string | null;
  bitbucket_repository_uuid: string | null;
};

export type EnvironmentCreateInput = {
  owner: EnvironmentOwner;
  createdByUserId: string;
  name: string;
  platform: EnvironmentPlatform;
  repoFullName: string;
  gitlabCloneUrl?: string | null;
  bitbucketWorkspaceUuid?: string | null;
  bitbucketRepositoryUuid?: string | null;
  plainVars?: Record<string, string>;
  secrets?: Record<string, string>;
  commands?: string[];
};

export type EnvironmentSecretChange =
  | { key: string; value: string }
  | { key: string; delete: true };

export type EnvironmentUpdateInput = {
  owner: EnvironmentOwner;
  environmentId: string;
  name?: string;
  plainVars?: Record<string, string>;
  secrets?: EnvironmentSecretChange[];
  commands?: string[];
};

/** The primitives a repository environment contributes to a session. */
export type EnvironmentSessionLayer = {
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  setupCommands?: string[];
};

export type EnvironmentPlainVarResponse = {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
};

export type EnvironmentResponse = {
  id: string;
  name: string;
  platform: EnvironmentPlatform;
  repoFullName: string;
  gitlabCloneUrl: string | null;
  bitbucketWorkspaceUuid: string | null;
  bitbucketRepositoryUuid: string | null;
  createdAt: string;
  updatedAt: string;
  plainVars: EnvironmentPlainVarResponse[];
  commands: string[];
  /** Secret key names only. Values and envelopes are never returned. */
  secretKeys: string[];
};

export type EnvironmentSummary = {
  id: string;
  name: string;
  platform: EnvironmentPlatform;
  repoFullName: string;
  gitlabCloneUrl: string | null;
  bitbucketWorkspaceUuid: string | null;
  bitbucketRepositoryUuid: string | null;
  createdAt: string;
  updatedAt: string;
  plainVarCount: number;
  secretCount: number;
  commandCount: number;
};

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

export function validateEnvironmentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > ENVIRONMENT_LIMITS.MAX_NAME_LENGTH) {
    throw badRequest(`Environment name must be 1-${ENVIRONMENT_LIMITS.MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

export function assertValidEnvironmentKey(key: string): void {
  if (key.length > ENVIRONMENT_LIMITS.MAX_KEY_LENGTH || !ENVIRONMENT_KEY_PATTERN.test(key)) {
    throw badRequest('Invalid environment variable key');
  }
  if (isReservedEnvironmentKey(key)) {
    throw badRequest(`Reserved environment variable key: ${key}`);
  }
}

export function validateEnvironmentPlainVars(
  vars: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    assertValidEnvironmentKey(key);
    if (value.length > ENVIRONMENT_LIMITS.MAX_PLAINTEXT_VALUE_LENGTH) {
      throw badRequest(
        `Plaintext environment variable values are limited to ${ENVIRONMENT_LIMITS.MAX_PLAINTEXT_VALUE_LENGTH} characters`
      );
    }
    out[key] = value;
  }
  return out;
}

export function validateEnvironmentSecretValue(value: string): string {
  if (value === MASKED_SECRET_VALUE) {
    throw badRequest('A masked placeholder is not a secret value');
  }
  if (value.length > ENVIRONMENT_LIMITS.MAX_SECRET_VALUE_LENGTH) {
    throw badRequest(
      `Secret values are limited to ${ENVIRONMENT_LIMITS.MAX_SECRET_VALUE_LENGTH} characters`
    );
  }
  return value;
}

export function validateEnvironmentSecrets(
  secrets: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets ?? {})) {
    assertValidEnvironmentKey(key);
    out[key] = validateEnvironmentSecretValue(value);
  }
  return out;
}

export function validateEnvironmentCommands(commands: string[] | undefined): string[] {
  const list = commands ?? [];
  if (list.length > ENVIRONMENT_LIMITS.MAX_COMMANDS) {
    throw badRequest(`Maximum ${ENVIRONMENT_LIMITS.MAX_COMMANDS} setup commands allowed`);
  }
  for (const command of list) {
    if (command.length === 0 || command.length > ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH) {
      throw badRequest(
        `Setup commands must be 1-${ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH} characters`
      );
    }
  }
  return [...list];
}

export function validateEnvironmentVarCount(total: number): void {
  if (total > ENVIRONMENT_LIMITS.MAX_VARS) {
    throw badRequest(`Maximum ${ENVIRONMENT_LIMITS.MAX_VARS} variables and secrets allowed`);
  }
}

const uuidSchema = z.uuid();

/** GitHub repository identity is trimmed and lowercased before comparison. */
export function normalizeRepoFullName(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

/** Bitbucket UUID identity is lowercased before storage and comparison. */
export function normalizeBitbucketUuid(uuid: string): string {
  return uuid.toLowerCase();
}

export function resolveEnvironmentIdentity(input: {
  platform: EnvironmentPlatform;
  repoFullName: string;
  gitlabCloneUrl?: string | null;
  bitbucketWorkspaceUuid?: string | null;
  bitbucketRepositoryUuid?: string | null;
}): EnvironmentIdentityColumns {
  const repoFullName = normalizeRepoFullName(input.repoFullName);
  if (repoFullName.length === 0) throw badRequest('Repository name is required');

  switch (input.platform) {
    case 'github':
      return {
        repo_full_name: repoFullName,
        gitlab_clone_url: null,
        bitbucket_workspace_uuid: null,
        bitbucket_repository_uuid: null,
      };
    case 'gitlab': {
      const cloneUrl = input.gitlabCloneUrl?.trim() ?? '';
      if (cloneUrl.length === 0) throw badRequest('GitLab clone URL is required');
      return {
        repo_full_name: repoFullName,
        gitlab_clone_url: cloneUrl,
        bitbucket_workspace_uuid: null,
        bitbucket_repository_uuid: null,
      };
    }
    case 'bitbucket': {
      const workspaceUuid = input.bitbucketWorkspaceUuid?.trim() ?? '';
      const repositoryUuid = input.bitbucketRepositoryUuid?.trim() ?? '';
      if (!uuidSchema.safeParse(workspaceUuid).success) {
        throw badRequest('Bitbucket workspace UUID is required');
      }
      if (!uuidSchema.safeParse(repositoryUuid).success) {
        throw badRequest('Bitbucket repository UUID is required');
      }
      return {
        repo_full_name: repoFullName,
        gitlab_clone_url: null,
        bitbucket_workspace_uuid: normalizeBitbucketUuid(workspaceUuid),
        bitbucket_repository_uuid: normalizeBitbucketUuid(repositoryUuid),
      };
    }
  }
}
