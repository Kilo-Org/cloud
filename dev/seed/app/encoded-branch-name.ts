import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import { and, eq, inArray, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';

export const usage = '<email>';

/**
 * Sessions whose stored branch is percent-encoded, plus the two controls that
 * keep a decoder honest.
 *
 * Some stored sessions hold the branch percent-encoded, the same way a stored
 * `git_url` holds its non-ASCII path: `fix/%E8%AB%8B%E6%B1%82%E6%9B%B8` is
 * `fix/請求書`. This fixture reproduces that stored shape. Every surface that
 * names the branch — the Agents row subtitle and its spoken label, the
 * shared-session page, the system-search entry — decodes each `/`-segment once,
 * so the row reads `fix/請求書`.
 *
 * The second row is a plain branch, which the decoder must leave alone, and the
 * third holds a lone `%`: that escape cannot be decoded, so its raw text stays
 * on screen instead of throwing or blanking the subtitle.
 *
 * Open `HISTORY_DEEP_LINK` (Agents > Past sessions) and read each row's
 * subtitle: `fix/請求書`, `fix/checkout-retries`, `fix/100%`.
 */
export const ENCODED_BRANCH_SESSIONS = [
  {
    sessionId: 'ses_encodedBranch0000001',
    title: 'Reissue the invoice export',
    gitBranch: 'fix/%E8%AB%8B%E6%B1%82%E6%9B%B8',
    label: 'fix/請求書',
    ageHours: 1,
  },
  {
    sessionId: 'ses_encodedBranch0000002',
    title: 'Backfill the retry budget',
    gitBranch: 'fix/checkout-retries',
    label: 'fix/checkout-retries',
    ageHours: 3,
  },
  {
    sessionId: 'ses_encodedBranch0000003',
    title: 'Trim the retry budget',
    gitBranch: 'fix/100%',
    label: 'fix/100%',
    ageHours: 6,
  },
] as const;

/** The repository every row above names. */
const GIT_URL = 'https://github.com/kilo-e2e-fixtures/requests';

/** The Past sessions list the rows above appear in. */
export const HISTORY_DEEP_LINK = 'kiloapp:///(app)/(tabs)/(2_agents)/history';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:encoded-branch-name ${usage}`);
  console.log('');
  console.log('Seeds three stored sessions whose git_branch is a percent-encoded ref,');
  console.log('a plain branch, and a branch carrying a malformed escape.');
  console.log('The Agents > Past sessions rows show the decoded branch subtitle:');
  for (const session of ENCODED_BRANCH_SESSIONS) {
    console.log(`  ${session.gitBranch}   ->   ${session.label}`);
  }
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:encoded-branch-name evgeny@kilocode.ai');
  console.log('  pnpm -s dev:seed app:encoded-branch-name evgeny@kilocode.ai --json');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const email = args.find(arg => !arg.startsWith('-'));
  if (!email) {
    printUsage();
    throw new Error('Missing email');
  }
  if (!isValidEmail(email)) {
    throw new Error(`Not an email address: ${email}`);
  }

  assertLocalSeedDatabase('app:encoded-branch-name');
  const db = getSeedDb();
  const matches = await db
    .select({ userId: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizeSeedEmail(email))
      )
    );

  if (matches.length === 0) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }

  const exactMatches = matches.filter(match => match.email === email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    throw new Error(
      `Multiple users matched ${email}: ${resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ')}`
    );
  }

  const [user] = resolvedMatches;
  const sessionIds = ENCODED_BRANCH_SESSIONS.map(session => session.sessionId);

  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, user.userId),
        inArray(cli_sessions_v2.session_id, sessionIds)
      )
    );

  const now = Date.now();
  await db.insert(cli_sessions_v2).values(
    ENCODED_BRANCH_SESSIONS.map(session => {
      const at = new Date(now - session.ageHours * 60 * 60 * 1000).toISOString();
      return {
        session_id: session.sessionId,
        kilo_user_id: user.userId,
        title: session.title,
        created_on_platform: 'cli',
        git_url: normalizeGitUrl(GIT_URL),
        git_branch: session.gitBranch,
        status: 'completed',
        status_updated_at: at,
        last_activity_at: at,
        created_at: at,
        updated_at: at,
      } satisfies typeof cli_sessions_v2.$inferInsert;
    })
  );

  console.log('');
  console.log('This fixture represents: stored sessions whose branch arrived');
  console.log('percent-encoded, plus a plain branch and a malformed escape.');
  console.log('Suggested next step: open the history deep link and read the branch');
  console.log('subtitle of each row.');
  for (const session of ENCODED_BRANCH_SESSIONS) {
    console.log(`  ${session.label}`);
  }
  console.log(`  ${HISTORY_DEEP_LINK}`);

  return {
    userId: user.userId,
    email: user.email,
    sessionIds: sessionIds.join(','),
    encodedBranch: ENCODED_BRANCH_SESSIONS[0].gitBranch,
    plainBranch: ENCODED_BRANCH_SESSIONS[1].gitBranch,
    malformedBranch: ENCODED_BRANCH_SESSIONS[2].gitBranch,
    deepLink: HISTORY_DEEP_LINK,
  };
}
