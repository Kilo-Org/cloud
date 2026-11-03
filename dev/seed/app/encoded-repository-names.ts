import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import { and, eq, inArray, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';

export const usage = '<email>';

/**
 * Sessions whose repository names are not ASCII, with `git_url` in the shape a
 * stored session really holds.
 *
 * `normalizeGitUrl` (`@kilocode/worker-utils`) rebuilds the URL from
 * `URL.pathname` and lower-cases the whole path, so `山田-API` is persisted as
 * `%e5%b1%b1%e7%94%b0-api` — every non-ASCII byte is percent-encoded. That is
 * also the string the list query compares a project filter against, which is
 * why the rows are inserted through the same normalizer rather than with the
 * readable URL.
 *
 * `eyebrowName` is what the Past sessions row shows (the label upper-cases the
 * repository name in the active locale) and `projectLabel` is the project
 * filter sheet row, which shows the decoded `owner/repo` as stored.
 */
export const ENCODED_REPOSITORY_SESSIONS = [
  {
    sessionId: 'ses_encodedRepo000000000001',
    title: 'Repair pull request link parsing',
    gitUrl: 'https://github.com/kilo-e2e-fixtures/%E5%B1%B1%E7%94%B0-API',
    gitBranch: 'main',
    createdOnPlatform: 'cli',
    eyebrowName: '山田-API',
    projectLabel: 'kilo-e2e-fixtures/山田-api',
    ageHours: 3,
  },
  {
    sessionId: 'ses_encodedRepo000000000002',
    title: 'Tighten diff viewer spacing',
    gitUrl: 'https://github.com/kilo-e2e-fixtures/%E7%A7%BB%E5%8A%A8%E7%AB%AF',
    gitBranch: 'feature/spacing',
    createdOnPlatform: 'cloud-agent-web',
    eyebrowName: '移动端',
    projectLabel: 'kilo-e2e-fixtures/移动端',
    ageHours: 27,
  },
  {
    sessionId: 'ses_encodedRepo000000000003',
    title: 'Backfill session metadata',
    gitUrl:
      'https://github.com/kilo-e2e-fixtures/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5',
    gitBranch: 'main',
    createdOnPlatform: 'cli',
    eyebrowName: 'МЕТАДАННЫЕ',
    projectLabel: 'kilo-e2e-fixtures/метаданные',
    ageHours: 51,
  },
] as const;

/** The Past sessions list the rows above appear in. */
export const HISTORY_DEEP_LINK = 'kiloapp:///(app)/(tabs)/(2_agents)/history';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:encoded-repository-names ${usage}`);
  console.log('');
  console.log('Seeds three stored sessions whose repository names are non-ASCII and');
  console.log('percent-encoded in git_url, the shape normalizeGitUrl stores.');
  console.log('The Agents > Past sessions rows show the decoded repo eyebrow, and the');
  console.log('project filter sheet shows the decoded project rows:');
  for (const session of ENCODED_REPOSITORY_SESSIONS) {
    console.log(`  ${session.eyebrowName}   ${session.projectLabel}`);
  }
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:encoded-repository-names evgeny@kilocode.ai');
  console.log('  pnpm -s dev:seed app:encoded-repository-names evgeny@kilocode.ai --json');
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
  const sessionIds = ENCODED_REPOSITORY_SESSIONS.map(session => session.sessionId);

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
    ENCODED_REPOSITORY_SESSIONS.map(session => {
      const at = new Date(now - session.ageHours * 60 * 60 * 1000).toISOString();
      return {
        session_id: session.sessionId,
        kilo_user_id: user.userId,
        title: session.title,
        created_on_platform: session.createdOnPlatform,
        git_url: normalizeGitUrl(session.gitUrl),
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
  console.log('This fixture represents: stored sessions whose repository names are not');
  console.log('ASCII, saved percent-encoded exactly as normalizeGitUrl stores them.');
  console.log('Suggested next step: open the history deep link and read the repo eyebrow');
  console.log('of each row, then open the project filter sheet.');
  for (const session of ENCODED_REPOSITORY_SESSIONS) {
    console.log(`  ${session.eyebrowName}   ${session.projectLabel}`);
  }
  console.log(`  ${HISTORY_DEEP_LINK}`);

  return {
    userId: user.userId,
    email: user.email,
    sessionIds: sessionIds.join(','),
    eyebrowNames: ENCODED_REPOSITORY_SESSIONS.map(session => session.eyebrowName).join(','),
    projectLabels: ENCODED_REPOSITORY_SESSIONS.map(session => session.projectLabel).join(','),
    deepLink: HISTORY_DEEP_LINK,
  };
}
