import { z } from 'zod';

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

const runtimeConfigSchema = z.object({
  VERCEL_TOKEN: z.string().trim().min(1),
  VERCEL_TEAM_ID: z.string().trim().min(1),
  VERCEL_PROJECT_ID: z.string().trim().min(1),
  VERCEL_SANDBOX_SNAPSHOT_ID: z.string().trim().min(1),
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: z.string().trim().min(1),
  VERCEL_SANDBOX_RUNTIME: z.literal('node24'),
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: positiveIntegerString,
  VERCEL_SANDBOX_EXTEND_DURATION_MS: positiveIntegerString,
});

export type VercelSandboxRuntimeConfig = {
  accessToken: string;
  teamId: string;
  projectId: string;
  snapshotId: string;
  runtimeBuildId: string;
  runtime: 'node24';
  initialTimeoutMs: number;
  extendDurationMs: number;
};

export type VercelSandboxCredentials = {
  accessToken: string;
  teamId: string;
};

export type VercelSandboxRuntimeConfigEnv = {
  VERCEL_TOKEN?: string;
  VERCEL_TEAM_ID?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_SANDBOX_SNAPSHOT_ID?: string;
  VERCEL_SANDBOX_RUNTIME_BUILD_ID?: string;
  VERCEL_SANDBOX_RUNTIME?: string;
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS?: string;
  VERCEL_SANDBOX_EXTEND_DURATION_MS?: string;
};

export function parseVercelSandboxCredentials(
  env: VercelSandboxRuntimeConfigEnv
): VercelSandboxCredentials | undefined {
  const accessToken = env.VERCEL_TOKEN?.trim();
  const teamId = env.VERCEL_TEAM_ID?.trim();
  return accessToken && teamId ? { accessToken, teamId } : undefined;
}

export function parseVercelSandboxRuntimeConfig(
  env: VercelSandboxRuntimeConfigEnv
): VercelSandboxRuntimeConfig | undefined {
  const result = runtimeConfigSchema.safeParse(env);
  if (!result.success) return undefined;

  return {
    accessToken: result.data.VERCEL_TOKEN,
    teamId: result.data.VERCEL_TEAM_ID,
    projectId: result.data.VERCEL_PROJECT_ID,
    snapshotId: result.data.VERCEL_SANDBOX_SNAPSHOT_ID,
    runtimeBuildId: result.data.VERCEL_SANDBOX_RUNTIME_BUILD_ID,
    runtime: result.data.VERCEL_SANDBOX_RUNTIME,
    initialTimeoutMs: result.data.VERCEL_SANDBOX_INITIAL_TIMEOUT_MS,
    extendDurationMs: result.data.VERCEL_SANDBOX_EXTEND_DURATION_MS,
  };
}

/**
 * Operational config for a session's Vercel runtime: environment values,
 * overlaid with the session's persisted runtime identity once one exists so
 * later env rotations cannot repoint an already-created runtime.
 */
export function resolveVercelSandboxRuntimeConfig(
  env: VercelSandboxRuntimeConfigEnv,
  persisted?: {
    projectId?: string;
    snapshotId?: string;
    runtimeBuildId?: string;
    runtime?: string;
  }
): VercelSandboxRuntimeConfig | undefined {
  const configured = parseVercelSandboxRuntimeConfig(env);
  if (!configured) return undefined;
  return persisted?.projectId &&
    persisted.snapshotId &&
    persisted.runtimeBuildId &&
    persisted.runtime === 'node24'
    ? {
        ...configured,
        projectId: persisted.projectId,
        snapshotId: persisted.snapshotId,
        runtimeBuildId: persisted.runtimeBuildId,
        runtime: persisted.runtime,
      }
    : configured;
}

export type VercelSandboxEnrollmentEnv = {
  VERCEL_SANDBOX_ORG_IDS?: string;
};

export type VercelSandboxEnrollment = {
  enabled: boolean;
  orgIds: Set<string>;
  allowPersonal: boolean;
};

export function parseVercelSandboxEnrollment(
  env: VercelSandboxEnrollmentEnv
): VercelSandboxEnrollment {
  const orgIds = new Set(
    (env.VERCEL_SANDBOX_ORG_IDS ?? '')
      .split(',')
      .map(orgId => orgId.trim())
      .filter(Boolean)
  );
  if (orgIds.size === 0) {
    return { enabled: false, orgIds, allowPersonal: false };
  }

  return {
    enabled: true,
    orgIds,
    allowPersonal: orgIds.has('*'),
  };
}
