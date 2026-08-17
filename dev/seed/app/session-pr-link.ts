import { cli_sessions_v2, github_branch_pull_requests, kilocode_users } from '@kilocode/db/schema';
import { and, eq, like, or, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage =
  '<email> <sessionId> <prUrl> <prNumber> <platform> [--state=open] [--title=...] [--review-decision=approved] [--git-url=...] [--git-branch=...] [--no-cache] | <email> <sessionId> --empty';

// Matches the github_branch_pull_requests_review_decision_check constraint.
const REVIEW_DECISIONS: ReadonlyArray<string> = [
  'approved',
  'changes_requested',
  'review_required',
];

type SetOptions = {
  mode: 'set';
  email: string;
  sessionId: string;
  prUrl: string;
  prNumber: number;
  platform: string;
  state: string;
  title: string | null;
  reviewDecision: string;
  gitUrl: string;
  gitBranch: string;
  noCache: boolean;
};

type EmptyOptions = {
  mode: 'empty';
  email: string;
  sessionId: string;
};

type SeedOptions = SetOptions | EmptyOptions;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:session-pr-link ${usage}`);
  console.log('');
  console.log('Seeds the PR link on a cli_sessions_v2 row for E2E mobile session detail.');
  console.log('Set mode writes platform/pr_url/pr_number plus the git identity, and (unless');
  console.log('--no-cache) upserts the github_branch_pull_requests cache row. Empty mode');
  console.log('nulls all five columns and never writes a cache row.');
  console.log('');
  console.log('Options:');
  console.log('  --state=<state>                 PR state for the cache row (default: open)');
  console.log('  --title=<title>                 PR title for the cache row');
  console.log(
    '  --review-decision=<decision>    approved | changes_requested | review_required (default: approved)'
  );
  console.log('  --git-url=<url>                 Git remote url (required in set mode)');
  console.log('  --git-branch=<branch>           Git branch (required in set mode)');
  console.log('  --no-cache                      Skip the cache row upsert');
  console.log('  --empty                         Clear the PR link instead of setting it');
  console.log('');
  console.log('Examples:');
  console.log(
    '  pnpm dev:seed app:session-pr-link ada@example.com ses_e2eprhappy0000000000000001 \\'
  );
  console.log('    https://github.com/kilo-stub/discussion-mixed/pull/1 1 github \\');
  console.log('    --state=open --review-decision=approved \\');
  console.log('    --git-url=https://github.com/kilo-stub/discussion-mixed.git --git-branch=main');
  console.log(
    '  pnpm dev:seed app:session-pr-link ada@example.com ses_e2eprempty0000000000000001 --empty'
  );
}

function isValidEmail(email: string): boolean {
  // Intentionally permissive; we only guard against obvious nonsense in dev.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sessionTitleFor(sessionId: string): string {
  if (sessionId.includes('e2eprhappy')) return 'E2E PR happy';
  if (sessionId.includes('e2eprempty')) return 'E2E PR empty';
  if (sessionId.includes('e2eprgitlab')) return 'E2E PR gitlab';
  if (sessionId.includes('e2eprpend')) return 'E2E PR pending';
  return sessionId;
}

function takeFlagValue(args: string[], index: number, flag: string): string {
  const arg = args[index];
  if (arg.length > flag.length && arg[flag.length] === '=') {
    const inline = arg.slice(flag.length + 1).trim();
    if (!inline) {
      throw new Error(`${flag} requires a value`);
    }
    return inline;
  }

  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return next.trim();
}

function parseArgs(args: string[]): SeedOptions {
  const positionals: string[] = [];
  let state = 'open';
  let title: string | null = null;
  let reviewDecision = 'approved';
  let gitUrl: string | null = null;
  let gitBranch: string | null = null;
  let noCache = false;
  let empty = false;

  const VALUE_FLAGS = ['--state', '--title', '--review-decision', '--git-url', '--git-branch'];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const flag = VALUE_FLAGS.find(name => arg === name || arg.startsWith(`${name}=`));

    if (flag) {
      const value = takeFlagValue(args, index, flag);
      if (arg === flag) index++; // value came from the next argv slot

      if (flag === '--state') {
        state = value;
      } else if (flag === '--title') {
        title = value;
      } else if (flag === '--review-decision') {
        reviewDecision = value;
      } else if (flag === '--git-url') {
        gitUrl = value;
      } else {
        gitBranch = value;
      }
      continue;
    }

    if (arg === '--no-cache') {
      noCache = true;
      continue;
    }
    if (arg === '--empty') {
      empty = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    positionals.push(arg.trim());
  }

  const [email, sessionId, ...rest] = positionals;

  if (!email || !sessionId) {
    printUsage();
    throw new Error('email and sessionId are required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  if (empty) {
    if (rest.length > 0) {
      printUsage();
      throw new Error(`--empty mode takes only <email> <sessionId>; got: ${rest.join(' ')}`);
    }
    return { mode: 'empty', email: email.trim(), sessionId };
  }

  const [prUrl, prNumberRaw, platform, ...extra] = rest;
  if (!prUrl || !prNumberRaw || !platform) {
    printUsage();
    throw new Error('set mode requires <prUrl> <prNumber> <platform>');
  }
  if (extra.length > 0) {
    printUsage();
    throw new Error(`Unexpected positional argument: ${extra.join(' ')}`);
  }

  const prNumber = Number(prNumberRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`prNumber must be a positive integer: ${prNumberRaw}`);
  }

  if (gitUrl === null || gitBranch === null) {
    printUsage();
    throw new Error('set mode requires --git-url and --git-branch');
  }

  if (!REVIEW_DECISIONS.includes(reviewDecision)) {
    throw new Error(
      `--review-decision must be one of ${REVIEW_DECISIONS.join(', ')}: ${reviewDecision}`
    );
  }

  return {
    mode: 'set',
    email: email.trim(),
    sessionId,
    prUrl: prUrl.trim(),
    prNumber,
    platform: platform.trim(),
    state,
    title,
    reviewDecision,
    gitUrl,
    gitBranch,
    noCache,
  };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);
  const db = getSeedDb();

  // Resolve the user id from the email, mirroring app:user-id.
  const normalizedEmail = normalizeSeedEmail(options.email);
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, options.email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(
      `No user found for email ${options.email}. Create one first: ` +
        `pnpm dev:seed app:create-user "Name" ${options.email}`
    );
  }

  const exactMatches = matches.filter(match => match.email === options.email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const list = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${options.email}: ${list}`);
  }

  const userId = resolvedMatches[0].userId;

  // Reset only this invocation's own fixtures so reruns are idempotent. The E2E
  // seeds the four scenarios as separate commands, so each invocation deletes
  // only its own session row (and, in set mode, its own cache row) rather than
  // every `ses_e2epr` row, which would clobber the sibling scenarios. The plan
  // allows only the `ses_e2epr` prefix, so guard the delete with it and keep
  // the per-id match.
  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.session_id, options.sessionId),
        eq(cli_sessions_v2.kilo_user_id, userId),
        like(cli_sessions_v2.session_id, 'ses_e2epr%')
      )
    );

  if (options.mode === 'set') {
    await db
      .delete(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, options.gitUrl),
          eq(github_branch_pull_requests.git_branch, options.gitBranch),
          eq(github_branch_pull_requests.owned_by_user_id, userId)
        )
      );
  }

  // Insert a minimal session row if it does not exist yet.
  await db
    .insert(cli_sessions_v2)
    .values({
      session_id: options.sessionId,
      kilo_user_id: userId,
      title: sessionTitleFor(options.sessionId),
      created_on_platform: 'cli',
    } satisfies typeof cli_sessions_v2.$inferInsert)
    .onConflictDoNothing();

  const sessionWhere = and(
    eq(cli_sessions_v2.session_id, options.sessionId),
    eq(cli_sessions_v2.kilo_user_id, userId)
  );

  if (options.mode === 'empty') {
    await db
      .update(cli_sessions_v2)
      .set({
        platform: null,
        pr_url: null,
        pr_number: null,
        git_url: null,
        git_branch: null,
      })
      .where(sessionWhere);

    return {
      sessionId: options.sessionId,
      prUrl: null,
      prNumber: null,
      platform: null,
      cacheWritten: false,
    };
  }

  await db
    .update(cli_sessions_v2)
    .set({
      platform: options.platform,
      pr_url: options.prUrl,
      pr_number: options.prNumber,
      git_url: options.gitUrl,
      git_branch: options.gitBranch,
    })
    .where(sessionWhere);

  let cacheWritten = false;
  if (!options.noCache) {
    const cacheValues = {
      git_url: options.gitUrl,
      git_branch: options.gitBranch,
      owned_by_user_id: userId,
      owned_by_organization_id: null,
      pr_url: options.prUrl,
      pr_number: options.prNumber,
      pr_state: options.state,
      pr_title: options.title,
      pr_review_decision: options.reviewDecision,
      pr_last_synced_at: sql`now()`,
    } satisfies typeof github_branch_pull_requests.$inferInsert;

    await db
      .insert(github_branch_pull_requests)
      .values(cacheValues)
      .onConflictDoUpdate({
        target: [
          github_branch_pull_requests.git_url,
          github_branch_pull_requests.git_branch,
          github_branch_pull_requests.owned_by_user_id,
        ],
        targetWhere: sql`${github_branch_pull_requests.owned_by_user_id} IS NOT NULL`,
        set: {
          pr_url: sql`excluded.pr_url`,
          pr_number: sql`excluded.pr_number`,
          pr_state: sql`excluded.pr_state`,
          pr_title: sql`excluded.pr_title`,
          pr_review_decision: sql`excluded.pr_review_decision`,
          pr_last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        },
      });
    cacheWritten = true;
  }

  return {
    sessionId: options.sessionId,
    prUrl: options.prUrl,
    prNumber: options.prNumber,
    platform: options.platform,
    cacheWritten,
  };
}
