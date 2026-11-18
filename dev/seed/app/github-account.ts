import { isValidEmail, resolveSeedUserId } from '../lib/users';
import {
  donorRevokedError,
  findLiveGitHubDonor,
  findRevokedGitHubDonor,
  noDonorAvailableError,
  verifyLiveGitHubAuthorization,
} from '../lib/github-account';
import type { SeedResult } from '../index';

export const usage = '[email]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:github-account ${usage}`);
  console.log('');
  console.log('Reuses a local user that already has a live GitHub user authorization');
  console.log('(user_github_app_tokens.revoked_at IS NULL). Copying a donor onto a second');
  console.log('user is not possible: (github_user_id, github_app_type) is unique.');
  console.log('');
  console.log('Verification uses the same query as githubApps.getUserAuthorization.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:github-account');
  console.log('  pnpm -s dev:seed app:github-account ada@example.com --json');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [emailArg, ...rest] = args;
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  let preferredUserId: string | undefined;
  if (emailArg) {
    if (!isValidEmail(emailArg)) {
      throw new Error(`email is not a valid address: ${emailArg}`);
    }
    preferredUserId = await resolveSeedUserId(emailArg);
    const preferred = await findLiveGitHubDonor(preferredUserId);
    if (preferred) {
      const status = await verifyLiveGitHubAuthorization(preferred.userId);
      console.log('');
      console.log(
        'This fixture represents: a reused user-owned GitHub user authorization that reports connected: true.'
      );
      return {
        userId: preferred.userId,
        email: preferred.email,
        authorizationId: preferred.authorizationId,
        githubLogin: preferred.githubLogin,
        connected: status.connected,
        revoked: status.revoked,
        reused: true,
      };
    }
    const revokedPreferred = await findRevokedGitHubDonor(preferredUserId);
    if (revokedPreferred) {
      throw donorRevokedError(revokedPreferred.githubLogin, revokedPreferred.reason);
    }
  }

  const live = await findLiveGitHubDonor();
  if (live) {
    const status = await verifyLiveGitHubAuthorization(live.userId);
    console.log('');
    console.log(
      'This fixture represents: a reused user-owned GitHub user authorization that reports connected: true.'
    );
    if (preferredUserId && preferredUserId !== live.userId) {
      console.log(
        'Note: the requested user has no GitHub authorization. Reused the live donor instead.'
      );
    }
    return {
      userId: live.userId,
      email: live.email,
      authorizationId: live.authorizationId,
      githubLogin: live.githubLogin,
      connected: status.connected,
      revoked: status.revoked,
      reused: true,
    };
  }

  const revoked = await findRevokedGitHubDonor();
  if (revoked) {
    throw donorRevokedError(revoked.githubLogin, revoked.reason);
  }

  throw noDonorAvailableError();
}
