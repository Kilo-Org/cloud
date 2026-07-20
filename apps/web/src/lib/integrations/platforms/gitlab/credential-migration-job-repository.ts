import 'server-only';

import { db } from '@/lib/drizzle';
import {
  gitlab_credential_migration_jobs,
  type GitLabCredentialMigrationJob,
} from '@kilocode/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  emptyGitLabCredentialAuditCounts,
  type GitLabCredentialAuditCounts,
} from './credential-migration-audit';
import type { GitLabCredentialMigrationMode } from './credential-migration';

const ISSUE_INTEGRATION_IDS_LIMIT = 500;
const PublicAuditCountsSchema = z
  .object({
    legacyTokenBearingIntegrations: z.number().int().nonnegative(),
    oauthMissingCredentials: z.number().int().nonnegative(),
    patMissingCredentials: z.number().int().nonnegative(),
    projectMissingCredentials: z.number().int().nonnegative(),
    credentialProfileMismatches: z.number().int().nonnegative(),
    providerMetadataMismatches: z.number().int().nonnegative(),
    crossTablePrimaryCredentialDuplicates: z.number().int().nonnegative(),
    malformedMetadata: z.number().int().nonnegative(),
    unmappableLegacyEntries: z.number().int().nonnegative(),
    integrationTypeDisagreements: z.number().int().nonnegative(),
    legacySecretFields: z.number().int().nonnegative(),
  })
  .strict();
const TimestampSchema = z
  .union([z.string(), z.date()])
  .transform(value =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString()
  );

export const GitLabCredentialPrivateAuditCountsSchema = z
  .object({
    credentials: z.number().int().nonnegative(),
    secrets: z.number().int().nonnegative(),
    passedCredentials: z.number().int().nonnegative(),
    profileFailures: z.number().int().nonnegative(),
    configurationFailures: z.number().int().nonnegative(),
    parseFailures: z.number().int().nonnegative(),
    unknownKeyFailures: z.number().int().nonnegative(),
    decryptOrAadFailures: z.number().int().nonnegative(),
  })
  .strict();
export type GitLabCredentialPrivateAuditCounts = z.infer<
  typeof GitLabCredentialPrivateAuditCountsSchema
>;

const JobSchema = z
  .object({
    id: z.uuid(),
    requested_mode: z.enum(['audit', 'backfill', 'scrub']),
    phase: z.enum([
      'public_audit',
      'backfill',
      'private_audit',
      'scrub',
      'final_public_audit',
      'final_private_audit',
    ]),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    requested_by_user_id: z.string().min(1),
    cursor: z.string().nullable(),
    lease_token: z.uuid().nullable(),
    lease_expires_at: TimestampSchema.nullable(),
    scanned_integrations: z.number().int().nonnegative(),
    mutated_integrations: z.number().int().nonnegative(),
    public_audit_counts: PublicAuditCountsSchema,
    private_audit_counts: GitLabCredentialPrivateAuditCountsSchema,
    private_audit_key_id: z.string().min(1).nullable(),
    private_audit_public_key_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    retry_count: z.number().int().nonnegative(),
    issue_integration_ids: z.array(z.uuid()).max(ISSUE_INTEGRATION_IDS_LIMIT),
    error_code: z.string().min(1).max(120).nullable(),
    started_at: TimestampSchema.nullable(),
    completed_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export type GitLabCredentialMigrationJobRecord = z.infer<typeof JobSchema>;
export type GitLabCredentialMigrationPhase = GitLabCredentialMigrationJobRecord['phase'];
export type LeasedGitLabCredentialMigrationJobRecord = GitLabCredentialMigrationJobRecord & {
  lease_token: string;
};

export class GitLabCredentialMigrationJobConflictError extends Error {
  constructor() {
    super('A GitLab credential migration job is already active');
  }
}

function emptyPrivateAuditCounts(): GitLabCredentialPrivateAuditCounts {
  return {
    credentials: 0,
    secrets: 0,
    passedCredentials: 0,
    profileFailures: 0,
    configurationFailures: 0,
    parseFailures: 0,
    unknownKeyFailures: 0,
    decryptOrAadFailures: 0,
  };
}

function initialPhase(mode: GitLabCredentialMigrationMode): GitLabCredentialMigrationPhase {
  if (mode === 'audit') return 'public_audit';
  if (mode === 'backfill') return 'backfill';
  return 'private_audit';
}

function parseJob(value: GitLabCredentialMigrationJob): GitLabCredentialMigrationJobRecord {
  return JobSchema.parse(value);
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export async function createGitLabCredentialMigrationJob(input: {
  mode: GitLabCredentialMigrationMode;
  requestedByUserId: string;
}): Promise<GitLabCredentialMigrationJobRecord> {
  try {
    const [job] = await db
      .insert(gitlab_credential_migration_jobs)
      .values({
        requested_mode: input.mode,
        phase: initialPhase(input.mode),
        status: 'queued',
        requested_by_user_id: input.requestedByUserId,
        public_audit_counts: emptyGitLabCredentialAuditCounts(),
        private_audit_counts: emptyPrivateAuditCounts(),
        issue_integration_ids: [],
      })
      .returning();
    if (!job) throw new Error('Failed to create GitLab credential migration job');
    return parseJob(job);
  } catch (error) {
    if (isUniqueViolation(error)) throw new GitLabCredentialMigrationJobConflictError();
    throw error;
  }
}

export async function getGitLabCredentialMigrationJob(
  id: string
): Promise<GitLabCredentialMigrationJobRecord | null> {
  const [job] = await db
    .select()
    .from(gitlab_credential_migration_jobs)
    .where(eq(gitlab_credential_migration_jobs.id, id))
    .limit(1);
  return job ? parseJob(job) : null;
}

export async function listRecentGitLabCredentialMigrationJobs(
  limit = 20
): Promise<GitLabCredentialMigrationJobRecord[]> {
  const jobs = await db
    .select()
    .from(gitlab_credential_migration_jobs)
    .orderBy(desc(gitlab_credential_migration_jobs.created_at))
    .limit(limit);
  return jobs.map(parseJob);
}

export async function acquireGitLabCredentialMigrationJobLease(
  leaseSeconds = 300
): Promise<LeasedGitLabCredentialMigrationJobRecord | null> {
  const leaseToken = crypto.randomUUID();
  const result = await db.execute<GitLabCredentialMigrationJob>(sql`
    UPDATE gitlab_credential_migration_jobs
    SET
      status = 'running',
      lease_token = ${leaseToken}::uuid,
      lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => ${leaseSeconds}),
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT id
      FROM gitlab_credential_migration_jobs
      WHERE status IN ('queued', 'running')
        AND (lease_token IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const job = result.rows[0];
  return job ? { ...parseJob(job), lease_token: leaseToken } : null;
}

export async function checkpointGitLabCredentialMigrationJob(input: {
  jobId: string;
  leaseToken: string;
  cursor: string | null;
  scannedIntegrations: number;
  mutatedIntegrations: number;
  publicAuditCounts: GitLabCredentialAuditCounts;
  privateAuditCounts: GitLabCredentialPrivateAuditCounts;
  issueIntegrationIds: string[];
  // Required so callers explicitly pass the persisted value or null to clear.
  privateAuditKeyId: string | null;
  privateAuditPublicKeySha256: string | null;
}): Promise<LeasedGitLabCredentialMigrationJobRecord | null> {
  const issueIntegrationIds = [...new Set(input.issueIntegrationIds)].slice(
    0,
    ISSUE_INTEGRATION_IDS_LIMIT
  );
  const result = await db.execute<GitLabCredentialMigrationJob>(sql`
    UPDATE gitlab_credential_migration_jobs
    SET
      cursor = ${input.cursor},
      scanned_integrations = ${input.scannedIntegrations},
      mutated_integrations = ${input.mutatedIntegrations},
      public_audit_counts = ${JSON.stringify(input.publicAuditCounts)}::jsonb,
      private_audit_counts = ${JSON.stringify(input.privateAuditCounts)}::jsonb,
      private_audit_key_id = ${input.privateAuditKeyId},
      private_audit_public_key_sha256 = ${input.privateAuditPublicKeySha256},
      retry_count = 0,
      issue_integration_ids = ${JSON.stringify(issueIntegrationIds)}::jsonb,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${input.jobId}::uuid
      AND status = 'running'
      AND lease_token = ${input.leaseToken}::uuid
    RETURNING *
  `);
  const job = result.rows[0];
  return job ? { ...parseJob(job), lease_token: input.leaseToken } : null;
}

export async function hasGitLabCredentialMigrationJobLease(
  jobId: string,
  leaseToken: string
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id::text
    FROM gitlab_credential_migration_jobs
    WHERE id = ${jobId}::uuid
      AND status = 'running'
      AND lease_token = ${leaseToken}::uuid
      AND lease_expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `);
  return result.rows.length > 0;
}

export async function incrementGitLabCredentialMigrationJobRetry(
  jobId: string,
  leaseToken: string
): Promise<LeasedGitLabCredentialMigrationJobRecord | null> {
  const result = await db.execute<GitLabCredentialMigrationJob>(sql`
    UPDATE gitlab_credential_migration_jobs
    SET retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${jobId}::uuid
      AND status = 'running'
      AND lease_token = ${leaseToken}::uuid
    RETURNING *
  `);
  const job = result.rows[0];
  return job ? { ...parseJob(job), lease_token: leaseToken } : null;
}

export async function transitionGitLabCredentialMigrationJobPhase(input: {
  jobId: string;
  leaseToken: string;
  phase: GitLabCredentialMigrationPhase;
  clearPublicAudit?: boolean;
  clearPrivateAudit?: boolean;
}): Promise<LeasedGitLabCredentialMigrationJobRecord | null> {
  const result = await db.execute<GitLabCredentialMigrationJob>(sql`
    UPDATE gitlab_credential_migration_jobs
    SET
      phase = ${input.phase},
      cursor = NULL,
      public_audit_counts = CASE
        WHEN ${input.clearPublicAudit ?? false} THEN ${JSON.stringify(emptyGitLabCredentialAuditCounts())}::jsonb
        ELSE public_audit_counts
      END,
      private_audit_counts = CASE
        WHEN ${input.clearPrivateAudit ?? false} THEN ${JSON.stringify(emptyPrivateAuditCounts())}::jsonb
        ELSE private_audit_counts
      END,
      private_audit_key_id = CASE WHEN ${input.clearPrivateAudit ?? false} THEN NULL ELSE private_audit_key_id END,
      private_audit_public_key_sha256 = CASE WHEN ${input.clearPrivateAudit ?? false} THEN NULL ELSE private_audit_public_key_sha256 END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${input.jobId}::uuid
      AND status = 'running'
      AND lease_token = ${input.leaseToken}::uuid
    RETURNING *
  `);
  const job = result.rows[0];
  return job ? { ...parseJob(job), lease_token: input.leaseToken } : null;
}

export async function completeGitLabCredentialMigrationJob(
  jobId: string,
  leaseToken: string
): Promise<boolean> {
  const result = await db
    .update(gitlab_credential_migration_jobs)
    .set({
      status: 'succeeded',
      completed_at: sql`CURRENT_TIMESTAMP`,
      lease_token: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(gitlab_credential_migration_jobs.id, jobId),
        eq(gitlab_credential_migration_jobs.status, 'running'),
        eq(gitlab_credential_migration_jobs.lease_token, leaseToken)
      )
    )
    .returning({ id: gitlab_credential_migration_jobs.id });
  return result.length > 0;
}

export async function failGitLabCredentialMigrationJob(
  jobId: string,
  leaseToken: string,
  errorCode: string
): Promise<boolean> {
  const result = await db
    .update(gitlab_credential_migration_jobs)
    .set({
      status: 'failed',
      error_code: errorCode.slice(0, 120),
      completed_at: sql`CURRENT_TIMESTAMP`,
      lease_token: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(gitlab_credential_migration_jobs.id, jobId),
        eq(gitlab_credential_migration_jobs.status, 'running'),
        eq(gitlab_credential_migration_jobs.lease_token, leaseToken)
      )
    )
    .returning({ id: gitlab_credential_migration_jobs.id });
  return result.length > 0;
}

export async function cancelGitLabCredentialMigrationJob(
  jobId: string
): Promise<GitLabCredentialMigrationJobRecord | null> {
  const [job] = await db
    .update(gitlab_credential_migration_jobs)
    .set({
      status: 'cancelled',
      completed_at: sql`CURRENT_TIMESTAMP`,
      lease_token: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(gitlab_credential_migration_jobs.id, jobId),
        inArray(gitlab_credential_migration_jobs.status, ['queued', 'running'])
      )
    )
    .returning();
  return job ? parseJob(job) : null;
}

export async function releaseGitLabCredentialMigrationJobLease(
  jobId: string,
  leaseToken: string
): Promise<void> {
  await db
    .update(gitlab_credential_migration_jobs)
    .set({ lease_token: null, lease_expires_at: null })
    .where(
      and(
        eq(gitlab_credential_migration_jobs.id, jobId),
        eq(gitlab_credential_migration_jobs.status, 'running'),
        eq(gitlab_credential_migration_jobs.lease_token, leaseToken)
      )
    );
}
