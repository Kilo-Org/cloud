import {
  runGitLabCredentialMigration,
  type GitLabCredentialMigrationMode,
} from '@/lib/integrations/platforms/gitlab/credential-migration';
import { getGitLabCredentialEncryptionPublicKeyInfo } from '@/lib/integrations/platforms/gitlab/credential-encryption';

const MODES: readonly GitLabCredentialMigrationMode[] = ['audit', 'backfill', 'scrub'];

type ScriptOptions = {
  mode: GitLabCredentialMigrationMode;
  apply: boolean;
  privateAuditPassed: boolean;
  batchSize: number;
};

function parseChoice<T extends string>(value: string, choices: readonly T[], label: string): T {
  const choice = choices.find(candidate => candidate === value);
  if (!choice) throw new Error(`Invalid ${label}: ${value}`);
  return choice;
}

function parseOptions(args: string[]): ScriptOptions {
  let mode: GitLabCredentialMigrationMode = 'audit';
  let apply = false;
  let privateAuditPassed = false;
  let batchSize = 100;

  for (const arg of args) {
    if (!arg.startsWith('--')) {
      mode = parseChoice(arg, MODES, 'migration mode');
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--private-audit-passed') {
      privateAuditPassed = true;
    } else if (arg.startsWith('--batch-size=')) {
      batchSize = Number(arg.slice('--batch-size='.length));
    } else {
      throw new Error(`Unknown GitLab credential migration argument: ${arg}`);
    }
  }

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('GitLab credential migration batch size must be a positive integer');
  }
  return { mode, apply, privateAuditPassed, batchSize };
}

/**
 * Usage: pnpm script:run db gitlab-credential-migration [audit|backfill|scrub]
 *   [--apply] [--private-audit-passed] [--batch-size=100]
 * Scrub requires: scrub --apply --private-audit-passed
 */
export async function run(...args: string[]): Promise<void> {
  const options = parseOptions(args);
  const keyInfo = getGitLabCredentialEncryptionPublicKeyInfo();
  console.log(
    JSON.stringify({
      event: 'gitlab_credential_migration_started',
      ...options,
      keyId: keyInfo.keyId,
      publicKeySha256: keyInfo.publicKeySha256,
    })
  );

  const result = await runGitLabCredentialMigration(options);
  console.log(JSON.stringify({ event: 'gitlab_credential_migration_completed', ...result }));
}
