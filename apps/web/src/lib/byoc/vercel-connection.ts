import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { parseKeyedEnvelope } from '@kilocode/encryption';
import { byoc_connections, type ByocConnection } from '@kilocode/db/schema';
import type { VercelComputeStatusColumns } from '@/lib/cloud-agent-next/vercel-compute-status';

const identifier = z.string().trim().min(1).max(256);
const configSchema = z.object({
  token_scope: z.enum(['team', 'project']),
  team_id: identifier,
  project_id: identifier,
  team_slug: identifier.nullable().default(null),
  project_slug: identifier.nullable().default(null),
});
const runtimeSchema = z.object({
  runtime_build_id: identifier.nullable().default(null),
  runtime_snapshot_id: identifier.nullable().default(null),
  runtime_wrapper_version: z.string().min(1).max(64).nullable().default(null),
  runtime_released_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  runtime_digest: z.string().min(1).max(512).nullable().default(null),
});

export const vercelSetupStepSchema = z
  .enum([
    'validating_access',
    'create_builder',
    'install_system_dependencies',
    'install_node_dependencies',
    'snapshot_builder',
    'create_validator',
    'launch_validator_wrapper',
    'verify_validator_call_home',
    'stop_validator',
    'confirm_terminal',
  ])
  .nullable();

/** Decode provider metadata at the shared-table boundary. */
export function decodeVercelConnection(row: ByocConnection) {
  const config = configSchema.safeParse(row.config);
  const runtime = runtimeSchema.safeParse(row.runtime);
  const setupStep = vercelSetupStepSchema.safeParse(row.setup_step);
  const upgradeStep = vercelSetupStepSchema.safeParse(row.upgrade_step);
  if (
    row.provider !== 'vercel' ||
    !config.success ||
    !runtime.success ||
    !setupStep.success ||
    !upgradeStep.success
  ) {
    throw new Error('Invalid Vercel connection metadata');
  }
  if (
    row.setup_status === 'ready' &&
    (!config.data.project_slug || !runtime.data.runtime_snapshot_id || !row.setup_completed_at)
  ) {
    throw new Error('Ready Vercel connection requires completed runtime fields');
  }
  return {
    ...row,
    ...config.data,
    ...runtime.data,
    setup_step: setupStep.data,
    upgrade_step: upgradeStep.data,
    token_encrypted: parseKeyedEnvelope(
      JSON.stringify(row.credentials_encrypted),
      'byoc-vercel-credential-rsa-aes-256-gcm'
    ),
  };
}

export type VercelComputeConnection = ReturnType<typeof decodeVercelConnection>;

type VercelConnectionUpdate = Partial<VercelComputeStatusColumns> & {
  build_generation?: string;
  updated_at?: string;
};

/** Merge only changed JSON fields so concurrent updates keep unrelated metadata. */
export function vercelConnectionUpdate(update: VercelConnectionUpdate) {
  const {
    team_slug,
    project_slug,
    runtime_build_id,
    runtime_snapshot_id,
    runtime_wrapper_version,
    runtime_released_at,
    runtime_digest,
    ...shared
  } = update;
  const config = Object.fromEntries(
    Object.entries({ team_slug, project_slug }).filter(([, value]) => value !== undefined)
  );
  const runtime = Object.fromEntries(
    Object.entries({
      runtime_build_id,
      runtime_snapshot_id,
      runtime_wrapper_version,
      runtime_released_at,
      runtime_digest,
    }).filter(([, value]) => value !== undefined)
  );
  return {
    ...shared,
    ...(Object.keys(config).length
      ? {
          config: sql`${byoc_connections.config} || ${JSON.stringify(config)}::jsonb`,
        }
      : {}),
    ...(Object.keys(runtime).length
      ? {
          runtime: sql`${byoc_connections.runtime} || ${JSON.stringify(runtime)}::jsonb`,
        }
      : {}),
  };
}
