import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
  DrizzleGitLabCredentialAuditStore,
  GitLabCredentialAuditService,
  type GitLabCredentialAuditRequest,
} from './gitlab-credential-audit.js';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';

export function buildGitLabCredentialAuditAdminQuery(db: WorkerDb, kiloUserId: string) {
  return db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.id, kiloUserId),
        eq(kilocode_users.is_admin, true),
        isNull(kilocode_users.blocked_reason)
      )
    )
    .limit(1);
}

export async function runGitLabCredentialAudit(
  env: CloudflareEnv,
  kiloUserId: string,
  input: GitLabCredentialAuditRequest
) {
  if (!env.HYPERDRIVE) throw new Error('Hyperdrive not configured');
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  const [admin] = await buildGitLabCredentialAuditAdminQuery(db, kiloUserId);
  if (!admin) return { authorized: false as const };

  const crypto = new GitLabCredentialCrypto(env);
  const result = await new GitLabCredentialAuditService(
    new DrizzleGitLabCredentialAuditStore(db),
    crypto
  ).audit(input);
  return { authorized: true as const, result };
}
