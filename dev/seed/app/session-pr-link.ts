import { cli_sessions_v2, github_branch_pull_requests, kilocode_users } from '@kilocode/db/schema';
import { and, eq, like, or, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage =
  '<email> <sessionId> <prUrl> <prNumber> <platform> [--state=open] [--title=...] [--review-decision=approved] [--git-url=...] [--git-branch=...] [--head-ref=...] [--head-sha=...] [--verified-at=...] [--unverified] [--other-pr-url=...] [--other-pr-number=...] [--other-session-id=...] [--other-title=...] [--no-cache] | <email> <sessionId> --empty';

// Matches the github_branch_pull_requests_review_decision_check constraint.
const REVIEW_DECISIONS: ReadonlyArray<string> = [
  'approved',
  'changes_requested',
  'review_required',
];

type OtherPrOptions = {
  sessionId: string;
  prUrl: string;
  prNumber: number;
  title: string | null;
};

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
  // The head ref/commit the session reported for its own PR, and when that link
  // was verified against GitHub. `null` head sha / verified-at models the
  // legacy-CLI case where the link must stay unshown.
  prHeadRef: string;
  prHeadSha: string | null;
  verifiedAt: string | null;
  // An unrelated PR on the same branch name, owned by another session of the
  // same user. The new (git_url, pr_number, owned_by_user_id) cache key lets it
  // coexist with the main session's own PR instead of overwriting it.
  other: OtherPrOptions | null;
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
  console.log('Seeds the verified PR link on a cli_sessions_v2 row for E2E mobile/web');
  console.log('session detail. Set mode writes platform/pr_url/pr_number plus the git');
  console.log('identity and the verified-link contract columns (pr_head_ref, pr_head_sha,');
  console.log('pr_link_verified_at), and (unless --no-cache) upserts the');
  console.log('github_branch_pull_requests state cache row keyed by PR identity. Empty');
  console.log('mode nulls every link column and never writes a cache row.');
  console.log('');
  console.log('Options:');
  console.log('  --state=<state>                 PR state for the cache row (default: open)');
  console.log('  --title=<title>                 PR title for the cache row');
  console.log(
    '  --review-decision=<decision>    approved | changes_requested | review_required (default: approved)'
  );
  console.log('  --git-url=<url>                 Git remote url (required in set mode)');
  console.log('  --git-branch=<branch>           Git branch (required in set mode)');
  console.log(
    '  --head-ref=<ref>                Session PR head ref reported by the CLI (default: --git-branch)'
  );
  console.log('  --head-sha=<sha>                Session PR head commit reported by the CLI');
  console.log(
    '  --verified-at=<timestamp>       When the link was verified against GitHub (default: now)'
  );
  console.log(
    '  --unverified                    Leave pr_link_verified_at NULL (link stays hidden)'
  );
  console.log(
    '  --other-pr-url=<url>            Also seed an unrelated PR on the same branch, owned by another session'
  );
  console.log('  --other-pr-number=<number>      PR number for --other-pr-url');
  console.log(
    '  --other-session-id=<id>         Session id owning the unrelated PR (default: <sessionId>other)'
  );
  console.log('  --other-title=<title>           PR title for the unrelated PR cache row');
  console.log('  --no-cache                      Skip the cache row upsert(s)');
  console.log('  --empty                         Clear the PR link instead of setting it');
  console.log('');
  console.log('Examples:');
  console.log(
    '  pnpm dev:seed app:session-pr-link ada@example.com ses_e2eprhappy0000000000000001 \\'
  );
  console.log('    https://github.com/kilo-stub/discussion-mixed/pull/1 1 github \\');
  console.log(
    '    --state=open --review-decision=approved --git-url=https://github.com/kilo-stub/discussion-mixed.git \\'
  );
  console.log('    --git-branch=fix/typo --head-ref=fix/typo --head-sha=abc123... \\');
  console.log(
    '    --other-pr-url=https://github.com/kilo-stub/discussion-mixed/pull/2 --other-pr-number=2'
  );
  console.log(
    '  pnpm dev:seed app:session-pr-link ada@example.com ses_e2eprempty0000000000000001 --empty'
  );
}

function sessionTitleFor(sessionId: string): string {
  if (sessionId.includes('other')) return 'E2E PR other';
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
  let headRef: string | null = null;
  let headSha: string | null = null;
  let verifiedAt: string | null = null;
  let unverified = false;
  let otherPrUrl: string | null = null;
  let otherPrNumberRaw: string | null = null;
  let otherSessionId: string | null = null;
  let otherTitle: string | null = null;
  let noCache = false;
  let empty = false;

  const VALUE_FLAGS = [
    '--state',
    '--title',
    '--review-decision',
    '--git-url',
    '--git-branch',
    '--head-ref',
    '--head-sha',
    '--verified-at',
    '--other-pr-url',
    '--other-pr-number',
    '--other-session-id',
    '--other-title',
  ];

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
      } else if (flag === '--git-branch') {
        gitBranch = value;
      } else if (flag === '--head-ref') {
        headRef = value;
      } else if (flag === '--head-sha') {
        headSha = value;
      } else if (flag === '--verified-at') {
        verifiedAt = value;
      } else if (flag === '--other-pr-url') {
        otherPrUrl = value;
      } else if (flag === '--other-pr-number') {
        otherPrNumberRaw = value;
      } else if (flag === '--other-session-id') {
        otherSessionId = value;
      } else {
        otherTitle = value;
      }
      continue;
    }

    if (arg === '--unverified') {
      unverified = true;
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

  if (unverified && verifiedAt !== null) {
    throw new Error('--unverified and --verified-at are mutually exclusive');
  }

  let resolvedVerifiedAt: string | null = null;
  if (!unverified) {
    const parsed = verifiedAt === null ? new Date() : new Date(verifiedAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`--verified-at is not a valid timestamp: ${verifiedAt}`);
    }
    resolvedVerifiedAt = parsed.toISOString();
  }

  const hasOther =
    otherPrUrl !== null ||
    otherPrNumberRaw !== null ||
    otherSessionId !== null ||
    otherTitle !== null;
  let other: OtherPrOptions | null = null;
  if (hasOther) {
    if (otherPrUrl === null || otherPrNumberRaw === null) {
      throw new Error('--other-pr-url and --other-pr-number must be provided together');
    }
    const otherPrNumber = Number(otherPrNumberRaw);
    if (!Number.isInteger(otherPrNumber) || otherPrNumber <= 0) {
      throw new Error(`--other-pr-number must be a positive integer: ${otherPrNumberRaw}`);
    }
    const resolvedOtherSessionId = otherSessionId ?? `${sessionId}other`;
    if (resolvedOtherSessionId === sessionId) {
      throw new Error('--other-session-id must differ from <sessionId>');
    }
    other = {
      sessionId: resolvedOtherSessionId,
      prUrl: otherPrUrl.trim(),
      prNumber: otherPrNumber,
      title: otherTitle,
    };
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
    prHeadRef: headRef ?? gitBranch,
    prHeadSha: headSha,
    verifiedAt: resolvedVerifiedAt,
    other,
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
  // only its own session row (and, in set mode, its own cache rows) rather than
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
    if (options.other) {
      await db
        .delete(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, options.other.sessionId),
            eq(cli_sessions_v2.kilo_user_id, userId),
            like(cli_sessions_v2.session_id, 'ses_e2epr%')
          )
        );
    }

    // Clear every cache row for this user/branch so the main PR and the
    // unrelated same-branch PR cannot leave stale rows behind on a rerun.
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
        pr_head_ref: null,
        pr_head_sha: null,
        pr_link_verified_at: null,
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
      pr_head_ref: options.prHeadRef,
      pr_head_sha: options.prHeadSha,
      pr_link_verified_at: options.verifiedAt,
    })
    .where(sessionWhere);

  // Cache keyed by PR identity (git_url, pr_number, owner), never by branch:
  // two sessions on the same branch name keep two distinct state rows.
  async function upsertCache(values: typeof github_branch_pull_requests.$inferInsert) {
    await db
      .insert(github_branch_pull_requests)
      .values(values)
      .onConflictDoUpdate({
        target: [
          github_branch_pull_requests.git_url,
          github_branch_pull_requests.pr_number,
          github_branch_pull_requests.owned_by_user_id,
        ],
        targetWhere: sql`${github_branch_pull_requests.pr_number} IS NOT NULL`,
        set: {
          pr_url: sql`excluded.pr_url`,
          pr_number: sql`excluded.pr_number`,
          pr_state: sql`excluded.pr_state`,
          pr_title: sql`excluded.pr_title`,
          pr_head_sha: sql`excluded.pr_head_sha`,
          pr_review_decision: sql`excluded.pr_review_decision`,
          pr_last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        },
      });
  }

  let cacheWritten = false;
  if (!options.noCache) {
    await upsertCache({
      git_url: options.gitUrl,
      git_branch: options.gitBranch,
      owned_by_user_id: userId,
      owned_by_organization_id: null,
      pr_url: options.prUrl,
      pr_number: options.prNumber,
      pr_state: options.state,
      pr_title: options.title,
      pr_head_sha: options.prHeadSha,
      pr_review_decision: options.reviewDecision,
      pr_last_synced_at: sql`now()`,
    } satisfies typeof github_branch_pull_requests.$inferInsert);
    cacheWritten = true;
  }

  if (options.other) {
    const other = options.other;
    await db
      .insert(cli_sessions_v2)
      .values({
        session_id: other.sessionId,
        kilo_user_id: userId,
        title: sessionTitleFor(other.sessionId),
        created_on_platform: 'cli',
      } satisfies typeof cli_sessions_v2.$inferInsert)
      .onConflictDoNothing();

    await db
      .update(cli_sessions_v2)
      .set({
        platform: options.platform,
        pr_url: other.prUrl,
        pr_number: other.prNumber,
        git_url: options.gitUrl,
        git_branch: options.gitBranch,
        pr_head_ref: options.gitBranch,
        pr_head_sha: null,
        pr_link_verified_at: options.verifiedAt,
      })
      .where(
        and(
          eq(cli_sessions_v2.session_id, other.sessionId),
          eq(cli_sessions_v2.kilo_user_id, userId)
        )
      );

    if (!options.noCache) {
      await upsertCache({
        git_url: options.gitUrl,
        git_branch: options.gitBranch,
        owned_by_user_id: userId,
        owned_by_organization_id: null,
        pr_url: other.prUrl,
        pr_number: other.prNumber,
        pr_state: options.state,
        pr_title: other.title ?? sessionTitleFor(other.sessionId),
        pr_head_sha: null,
        pr_review_decision: options.reviewDecision,
        pr_last_synced_at: sql`now()`,
      } satisfies typeof github_branch_pull_requests.$inferInsert);
    }
  }

  return {
    sessionId: options.sessionId,
    prUrl: options.prUrl,
    prNumber: options.prNumber,
    platform: options.platform,
    cacheWritten,
    otherSessionId: options.other?.sessionId ?? null,
    otherPrUrl: options.other?.prUrl ?? null,
    otherPrNumber: options.other?.prNumber ?? null,
  };
}
