import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import { z } from 'zod';

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

export type VercelSandboxRuntimeConfig = {
  accessToken: string;
  teamId: string;
  /** Project-scoped tokens must omit team-level query parameters. */
  scope?: 'team' | 'project';
  projectId: string;
  snapshotId: string;
  runtimeBuildId: string;
  runtime: 'node24';
  resources?: VercelSandboxResources;
  initialTimeoutMs: number;
  extendDurationMs: number;
};

export type VercelSandboxRuntimeDefaults = Pick<
  VercelSandboxRuntimeConfig,
  'runtime' | 'initialTimeoutMs' | 'extendDurationMs'
>;

export type VercelSandboxCredentials = {
  accessToken: string;
  teamId: string;
  /** Project-scoped tokens must omit team-level query parameters. */
  scope?: 'team' | 'project';
};

export type VercelSandboxRuntimeConfigEnv = {
  VERCEL_SANDBOX_RUNTIME?: string;
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS?: string;
  VERCEL_SANDBOX_EXTEND_DURATION_MS?: string;
};

export function parseVercelSandboxRuntimeDefaults(
  env: VercelSandboxRuntimeConfigEnv
): VercelSandboxRuntimeDefaults | undefined {
  const result = z
    .object({
      VERCEL_SANDBOX_RUNTIME: z.literal('node24'),
      VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: positiveIntegerString,
      VERCEL_SANDBOX_EXTEND_DURATION_MS: positiveIntegerString,
    })
    .safeParse(env);
  if (!result.success) return undefined;

  return {
    runtime: result.data.VERCEL_SANDBOX_RUNTIME,
    initialTimeoutMs: result.data.VERCEL_SANDBOX_INITIAL_TIMEOUT_MS,
    extendDurationMs: result.data.VERCEL_SANDBOX_EXTEND_DURATION_MS,
  };
}
