import { getWorkerDb } from '@kilocode/db/client';
import { buildGitLabCredentialAuditAdminQuery } from './gitlab-credential-audit-handler.js';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import {
  DrizzleGitLabCredentialRepairStore,
  GitLabCredentialRepairService,
  type GitLabCredentialRepairRequest,
} from './gitlab-credential-repair.js';

export async function runGitLabCredentialRepair(
  env: CloudflareEnv,
  kiloUserId: string,
  input: GitLabCredentialRepairRequest
) {
  if (!env.HYPERDRIVE) throw new Error('Hyperdrive not configured');
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  const [admin] = await buildGitLabCredentialAuditAdminQuery(db, kiloUserId);
  if (!admin) return { authorized: false as const };

  const result = await new GitLabCredentialRepairService(
    new DrizzleGitLabCredentialRepairStore(db),
    new GitLabCredentialCrypto(env)
  ).repair(input);
  return { authorized: true as const, result };
}
