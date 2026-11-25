/**
 * Secret-rotation step: revokes every live device session (mobile app and CLI
 * device-auth) with `revoked_reason = 'secret_rotation'`, so no device refresh
 * token can mint a new access token afterwards. Rotating NEXTAUTH_SECRET alone
 * does not end these sessions: refresh tokens are random values stored hashed
 * in `device_refresh_tokens` and do not depend on the secret.
 *
 * Usage, dry run first then --execute:
 *   pnpm --filter web script src/scripts/d2026-11-25_revoke-device-sessions-for-secret-rotation.ts
 *   pnpm --filter web script src/scripts/d2026-11-25_revoke-device-sessions-for-secret-rotation.ts --execute
 *
 * Options:
 *   --created-before=<ISO timestamp>  Revoke only sessions created before this time.
 *                                     Defaults to the time the command starts. Pass the
 *                                     time the new secret went live to keep sessions
 *                                     signed in after the rotation.
 *   --batch-size=<n>                  Rows per UPDATE statement (default 1000).
 *   --execute                         Write. Without it, the command prints counts only.
 *   --yes                             Skip the interactive confirmation of --execute.
 *
 * Idempotent: a rerun revokes only sessions that are still live, and leaves
 * sessions revoked earlier, for any reason, unchanged. Deletes no rows.
 *
 * Prints counts, the cutoff, and the database host only: no user ids, emails,
 * session ids, user agents, or token material.
 *
 * Requires POSTGRES_SCRIPT_URL.
 */

import '../lib/load-env';

import { closeAllDrizzleConnections, primaryDatabaseHost } from '@kilocode/web-shared/lib/drizzle';
import { DEVICE_SESSION_CACHE_TTL_MS } from '@kilocode/web-shared/lib/auth/device-session-cache';
import {
  DEFAULT_REVOKE_BATCH_SIZE,
  SECRET_ROTATION_REVOKED_REASON,
  countLiveDeviceSessions,
  countSecretRotationRevokedSessions,
  revokeAllLiveDeviceSessions,
} from '@/lib/auth/revoke-all-device-sessions';
import { cliConfirm } from './lib/cli-confirm';

type Args = { execute: boolean; yes: boolean; createdBefore: Date; batchSize: number };

function parseArgs(): Args {
  let execute = false;
  let yes = false;
  let createdBefore = new Date();
  let batchSize = DEFAULT_REVOKE_BATCH_SIZE;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg.startsWith('--created-before=')) {
      const value = arg.slice('--created-before='.length);
      const parsed = new Date(value);
      if (!value || Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid --created-before, expected an ISO timestamp: ${value}`);
      }
      createdBefore = parsed;
    } else if (arg.startsWith('--batch-size=')) {
      const value = Number(arg.slice('--batch-size='.length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --batch-size, expected a positive integer: ${arg}`);
      }
      batchSize = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (createdBefore.getTime() > Date.now()) {
    throw new Error('--created-before must not be in the future');
  }

  return { execute, yes, createdBefore, batchSize };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cutoff = args.createdBefore.toISOString();

  console.log(`Database host: ${primaryDatabaseHost()}`);
  console.log(`Mode: ${args.execute ? 'execute' : 'dry run'}`);
  console.log(`Revoked reason: ${SECRET_ROTATION_REVOKED_REASON}`);
  console.log(`Created before: ${cutoff}`);

  const before = await countLiveDeviceSessions(args.createdBefore);
  console.log(
    `Live device sessions to revoke: ${before.total} (app: ${before.app}, device-auth: ${before.deviceAuth})`
  );

  if (!args.execute) {
    console.log('Dry run: nothing revoked. Rerun with --execute to revoke.');
    return;
  }

  if (before.total === 0) {
    console.log('Nothing to revoke.');
    return;
  }

  if (!args.yes) {
    await cliConfirm(
      `Revoke ${before.total} live device sessions on ${primaryDatabaseHost()}? This signs out every affected device.`
    );
  }

  const result = await revokeAllLiveDeviceSessions({
    createdBefore: args.createdBefore,
    batchSize: args.batchSize,
    onBatch: ({ batch, revokedInBatch, revokedTotal }) => {
      console.log(`Batch ${batch}: revoked ${revokedInBatch} (total ${revokedTotal})`);
    },
  });

  const after = await countLiveDeviceSessions(args.createdBefore);
  const totalWithReason = await countSecretRotationRevokedSessions();

  console.log(`Revoked: ${result.revoked} in ${result.batches} batches`);
  console.log(`Live device sessions remaining before cutoff: ${after.total}`);
  console.log(`Sessions with reason ${SECRET_ROTATION_REVOKED_REASON}: ${totalWithReason}`);
  console.log(
    `Refresh is refused immediately. Access tokens signed with the current secret stay usable on a web or gateway instance for at most ${DEVICE_SESSION_CACHE_TTL_MS / 1000}s, until its device-session cache entry expires.`
  );

  if (after.total !== 0) {
    console.error('Expected no live sessions before the cutoff to remain; rerun the command.');
    process.exitCode = 1;
  }
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());
