import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { computeDatabaseUrl } from '@kilocode/db';
import {
  agent_briefing_events,
  agent_briefing_preferences,
  agent_briefing_reports,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
  organization_memberships,
} from '@kilocode/db/schema';
import { and, eq, inArray, ne } from 'drizzle-orm';

import {
  activityEvidence,
  persistBriefingEvidence,
  statusEvidence,
} from '../../../services/session-ingest/src/ingest/briefing-evidence';
import type { IngestBatch } from '../../../services/session-ingest/src/types/session-sync';
import { getSeedDb } from '../lib/db';
import { isValidEmail, resolveSeedUserId } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email> [--organization-id=<uuid>] [--timezone=<IANA>] [--web-url=<url>]';

const MINUTE_MS = 60_000;
const NIGHT_MINUTES = 180;
const CUTOFF_AGO_MINUTES = 5;
const MORNING_REMAINING_MINUTES = 180;
const SEED_GIT_URL = 'https://github.com/kilo-seed/agent-briefing';
const SEED_PR_NUMBER = 4242;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type Options = {
  email: string;
  organizationId: string | null;
  timezone: string | null;
  webUrl: string | null;
};

type FixtureSession = {
  key: string;
  title: string;
  parentKey: string | null;
  organizationId: string | null;
  status: string;
};

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:agent-briefing ${usage}`);
  console.log('');
  console.log('Publishes a current Morning briefing for an existing local user (for example');
  console.log('one created by fake login). The schedule is moved so the night ended five');
  console.log('minutes ago and the morning is active for three more hours.');
  console.log('');
  console.log('Evidence goes through the real session-ingest briefing producers');
  console.log('(activityEvidence/statusEvidence + persistBriefingEvidence), plus usage rows');
  console.log('and a verified pull request. The real scheduler then runs through the');
  console.log('authenticated /api/cron/agent-briefing endpoint of the local web server.');
  console.log('');
  console.log('Options:');
  console.log(
    '  --organization-id=<uuid>  Also publish an organization report (user must be a member).'
  );
  console.log('  --timezone=<IANA>         Saved briefing timezone (default: existing, else UTC).');
  console.log('  --web-url=<url>           Loopback web URL when dev:status does not list nextjs.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:agent-briefing kilo-igor@example.com');
}

function parseArgs(args: string[]): Options {
  const email = args[0]?.trim();
  if (!email || !isValidEmail(email)) {
    printUsage();
    throw new Error('a valid email is required');
  }
  const options: Options = { email, organizationId: null, timezone: null, webUrl: null };
  for (const arg of args.slice(1)) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (flag === '--organization-id' && value) options.organizationId = value;
    else if (flag === '--timezone' && value) options.timezone = value;
    else if (flag === '--web-url' && value) options.webUrl = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function assertLoopback(url: string, label: string): void {
  const { hostname } = new URL(url);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`Agent briefing seed requires a loopback ${label}; received ${hostname}.`);
  }
}

function resolveWebUrl(override: string | null): string {
  if (override) return override.replace(/\/$/, '');
  const status: unknown = JSON.parse(
    execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' })
  );
  const services =
    typeof status === 'object' &&
    status !== null &&
    'services' in status &&
    Array.isArray(status.services)
      ? status.services
      : [];
  for (const service of services) {
    if (
      typeof service === 'object' &&
      service !== null &&
      service.name === 'nextjs' &&
      service.status === 'up' &&
      typeof service.port === 'number'
    ) {
      return `http://localhost:${service.port}`;
    }
  }
  throw new Error('dev:status does not report a running nextjs service; pass --web-url.');
}

function stableHex(userId: string, slot: string): string {
  return createHash('sha256').update(`dev-seed:agent-briefing:${userId}:${slot}`).digest('hex');
}

function stableSessionId(userId: string, key: string): string {
  return `ses_${stableHex(userId, `session:${key}`).slice(0, 26)}`;
}

function stableUuid(userId: string, key: string): string {
  const hex = stableHex(userId, `usage:${key}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Canonical ULID: the status protocol orders same-millisecond transitions by it. */
function transitionId(at: number): string {
  let time = '';
  for (let value = at, index = 0; index < 10; index++, value = Math.floor(value / 32)) {
    time = CROCKFORD[value % 32] + time;
  }
  const random = [...randomBytes(16)].map(byte => CROCKFORD[byte % 32]).join('');
  return time + random;
}

function localClock(date: Date, timezone: string): { time: string; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
  return {
    time: `${part('hour')}:${part('minute')}`,
    date: `${part('year')}-${part('month')}-${part('day')}`,
  };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const options = parseArgs(args);
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('Agent briefing seed refuses to run with USE_PRODUCTION_DB=true.');
  }
  const connectionString = computeDatabaseUrl();
  assertLoopback(connectionString, 'database host');
  const webUrl = resolveWebUrl(options.webUrl);
  assertLoopback(webUrl, 'web URL');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new Error(
      'CRON_SECRET is not set. The local web server must run with the same CRON_SECRET to authorize /api/cron/agent-briefing.'
    );
  }

  const db = getSeedDb();
  const userId = await resolveSeedUserId(options.email);
  if (options.organizationId) {
    const [membership] = await db
      .select({ role: organization_memberships.role })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, options.organizationId),
          eq(organization_memberships.kilo_user_id, userId),
          ne(organization_memberships.role, 'billing_manager')
        )
      );
    if (!membership)
      throw new Error('User is not a briefing-eligible member of that organization.');
  }

  const [existingPreferences] = await db
    .select({ timezone: agent_briefing_preferences.timezone })
    .from(agent_briefing_preferences)
    .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  const timezone = options.timezone ?? existingPreferences?.timezone ?? 'UTC';

  const minute = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const cutoffAt = minute - CUTOFF_AGO_MINUTES * MINUTE_MS;
  const nightStartAt = cutoffAt - NIGHT_MINUTES * MINUTE_MS;
  const morningEndAt = minute + MORNING_REMAINING_MINUTES * MINUTE_MS;
  const at = (minutesIntoNight: number) => nightStartAt + minutesIntoNight * MINUTE_MS;
  const localDate = localClock(new Date(cutoffAt), timezone).date;

  const sessions: FixtureSession[] = [
    {
      key: 'checkout',
      title: 'Stabilize checkout retries',
      parentKey: null,
      organizationId: null,
      status: 'question',
    },
    {
      key: 'checkout-matrix',
      title: 'Run checkout test matrix',
      parentKey: 'checkout',
      organizationId: null,
      status: 'idle',
    },
    {
      key: 'docs',
      title: 'Refresh API reference',
      parentKey: null,
      organizationId: null,
      status: 'idle',
    },
    ...(options.organizationId
      ? [
          {
            key: 'org-release',
            title: 'Prepare release notes',
            parentKey: null,
            organizationId: options.organizationId,
            status: 'idle',
          },
        ]
      : []),
  ];
  const sessionIds = Object.fromEntries(
    sessions.map(session => [session.key, stableSessionId(userId, session.key)])
  );
  const usageRows = [
    { key: 'checkout', sessionKey: 'checkout', minutes: 25, cost: 180_000 },
    { key: 'checkout-matrix', sessionKey: 'checkout-matrix', minutes: 50, cost: 70_000 },
    { key: 'docs', sessionKey: 'docs', minutes: 110, cost: 40_000 },
    ...(options.organizationId
      ? [{ key: 'org-release', sessionKey: 'org-release', minutes: 130, cost: 95_000 }]
      : []),
  ];
  const usageIds = usageRows.map(row => stableUuid(userId, row.key));

  await db
    .delete(microdollar_usage_metadata)
    .where(inArray(microdollar_usage_metadata.id, usageIds));
  await db.delete(microdollar_usage).where(inArray(microdollar_usage.id, usageIds));
  await db
    .delete(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.kilo_user_id, userId),
        eq(agent_briefing_reports.local_date, localDate)
      )
    );
  const childFirst = [...sessions].sort(
    (a, b) => Number(b.parentKey !== null) - Number(a.parentKey !== null)
  );
  for (const session of childFirst) {
    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, userId),
          eq(cli_sessions_v2.session_id, sessionIds[session.key])
        )
      );
  }

  const prUrl = `${SEED_GIT_URL}/pull/${SEED_PR_NUMBER}`;
  for (const session of sessions) {
    const isCheckout = session.key === 'checkout';
    await db.insert(cli_sessions_v2).values({
      session_id: sessionIds[session.key],
      kilo_user_id: userId,
      title: session.title,
      created_on_platform: 'cli',
      organization_id: session.organizationId,
      parent_session_id: session.parentKey ? sessionIds[session.parentKey] : null,
      status: session.status,
      status_updated_at: new Date(isCheckout ? at(60) : at(120)).toISOString(),
      last_activity_at: new Date(at(120)).toISOString(),
      ...(isCheckout
        ? {
            git_url: SEED_GIT_URL,
            git_branch: 'fix/checkout-retries',
            platform: 'github',
            pr_url: prUrl,
            pr_number: SEED_PR_NUMBER,
            pr_head_ref: 'fix/checkout-retries',
            pr_head_sha: stableHex(userId, 'head-sha').slice(0, 40),
            pr_link_verified_at: new Date(at(90)).toISOString(),
          }
        : {}),
    } satisfies typeof cli_sessions_v2.$inferInsert);
  }

  const outcomes: Record<string, { minutes: number; text: string; tool: boolean }> = {
    checkout: {
      minutes: 20,
      text: 'Reproduced the flaky checkout retry and added a deterministic regression test.',
      tool: false,
    },
    'checkout-matrix': {
      minutes: 45,
      text: 'Checkout test matrix passed on Chromium, Firefox, and WebKit.',
      tool: true,
    },
    docs: {
      minutes: 100,
      text: 'Regenerated the API reference and fixed two broken examples.',
      tool: false,
    },
    'org-release': {
      minutes: 125,
      text: 'Drafted release notes for the 2.4 rollout from merged changes.',
      tool: false,
    },
  };
  for (const session of sessions) {
    const sessionId = sessionIds[session.key];
    const outcome = outcomes[session.key];
    const start = at(outcome.minutes);
    const messageId = `msg${stableHex(userId, `${session.key}:message`).slice(0, 16)}`;
    const partId = `prt${stableHex(userId, `${session.key}:part`).slice(0, 16)}`;
    const items: IngestBatch = [
      {
        type: 'message',
        data: {
          id: messageId,
          sessionID: sessionId,
          role: 'assistant',
          time: { created: start, completed: start + MINUTE_MS },
        },
      },
      outcome.tool
        ? {
            type: 'part',
            data: {
              id: partId,
              sessionID: sessionId,
              messageID: messageId,
              type: 'tool',
              tool: 'bash',
              state: {
                status: 'completed',
                output: outcome.text,
                time: { start, end: start + MINUTE_MS },
              },
            },
          }
        : {
            type: 'part',
            data: {
              id: partId,
              sessionID: sessionId,
              messageID: messageId,
              type: 'text',
              text: outcome.text,
              time: { start, end: start + MINUTE_MS },
            },
          },
    ];
    await persistBriefingEvidence(connectionString, userId, sessionId, activityEvidence(items));
  }

  const checkoutId = sessionIds.checkout;
  for (const session of sessions) {
    const sessionId = sessionIds[session.key];
    const blocked = session.status === 'question';
    const busyAt = blocked ? at(15) : at(outcomes[session.key].minutes - 5);
    const finalAt = blocked ? at(60) : at(outcomes[session.key].minutes + 2);
    const finalTransitionId = transitionId(finalAt);
    await persistBriefingEvidence(
      connectionString,
      userId,
      sessionId,
      statusEvidence([
        {
          type: 'session_status',
          data: {
            status: 'busy',
            previousStatus: 'idle',
            occurredAt: new Date(busyAt).toISOString(),
            transitionId: transitionId(busyAt),
          },
        },
        {
          type: 'session_status',
          data: {
            status: session.status,
            previousStatus: 'busy',
            occurredAt: new Date(finalAt).toISOString(),
            transitionId: finalTransitionId,
          },
        },
      ])
    );
    await db
      .update(cli_sessions_v2)
      .set({
        status: session.status,
        status_updated_at: new Date(finalAt).toISOString(),
        status_transition_id: finalTransitionId,
      })
      .where(
        and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, sessionId))
      );
  }

  // Same row the verified GitHub PR producer (markSessionsVerifyingPullRequest in
  // apps/web) writes; seeds cannot import apps/web/src, and the real producer needs
  // a signed GitHub webhook delivery.
  const openedAt = new Date(at(90)).toISOString();
  await db
    .insert(agent_briefing_events)
    .values({
      id: JSON.stringify([userId, checkoutId, 'pull_request', prUrl]),
      kilo_user_id: userId,
      session_id: checkoutId,
      organization_id: null,
      kind: 'pull_request',
      occurred_at: openedAt,
      title: `Opened pull request #${SEED_PR_NUMBER}`,
      url: prUrl,
      payload: { openedAt },
    } satisfies typeof agent_briefing_events.$inferInsert)
    .onConflictDoNothing();

  for (const [index, row] of usageRows.entries()) {
    const session = sessions.find(value => value.key === row.sessionKey);
    const createdAt = new Date(at(row.minutes)).toISOString();
    await db.insert(microdollar_usage).values({
      id: usageIds[index],
      kilo_user_id: userId,
      organization_id: session?.organizationId ?? null,
      cost: row.cost,
      input_tokens: 12_000,
      output_tokens: 1_800,
      cache_write_tokens: 0,
      cache_hit_tokens: 4_000,
      created_at: createdAt,
      provider: 'dev-seed',
      model: 'anthropic/claude-sonnet-4',
    } satisfies typeof microdollar_usage.$inferInsert);
    await db.insert(microdollar_usage_metadata).values({
      id: usageIds[index],
      message_id: `dev-seed:agent-briefing:${row.key}`,
      session_id: sessionIds[row.sessionKey],
      created_at: createdAt,
    } satisfies typeof microdollar_usage_metadata.$inferInsert);
  }

  const schedule = {
    timezone,
    night_start: localClock(new Date(nightStartAt), timezone).time,
    morning_start: localClock(new Date(cutoffAt), timezone).time,
    morning_end: localClock(new Date(morningEndAt), timezone).time,
    notifications_enabled: false,
    next_run_at: new Date(nightStartAt).toISOString(),
    created_at: new Date(nightStartAt - MINUTE_MS).toISOString(),
    updated_at: new Date().toISOString(),
  };
  await db
    .insert(agent_briefing_preferences)
    .values({ kilo_user_id: userId, ...schedule })
    .onConflictDoUpdate({ target: agent_briefing_preferences.kilo_user_id, set: schedule });

  const response = await fetch(`${webUrl}/api/cron/agent-briefing`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Briefing scheduler returned ${response.status}.`);

  const reports = await db
    .select({
      id: agent_briefing_reports.id,
      organizationId: agent_briefing_reports.organization_id,
      publishedAt: agent_briefing_reports.published_at,
    })
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.kilo_user_id, userId),
        eq(agent_briefing_reports.local_date, localDate)
      )
    );
  const personal = reports.find(report => report.organizationId === null);
  if (!personal?.publishedAt) throw new Error('The scheduler did not publish a Personal briefing.');
  const organization = options.organizationId
    ? reports.find(report => report.organizationId === options.organizationId)
    : undefined;
  if (options.organizationId && !organization?.publishedAt) {
    throw new Error('The scheduler did not publish the organization briefing.');
  }

  console.log('This fixture represents: a finished night with one blocked root session (its');
  console.log('child test run rolls up under it), one verified pull request, a second');
  console.log('session, and attributable overnight spend. Notifications stay off, AI is not');
  console.log('enabled, and no transcript is ingested, so nothing sends a push or calls a model.');
  console.log(
    `Suggested next step: open kiloapp://agent-briefing/${personal.id} on a signed-in dev build.`
  );

  return {
    userId,
    timezone,
    localDate,
    nightStartAt: new Date(nightStartAt).toISOString(),
    cutoffAt: new Date(cutoffAt).toISOString(),
    morningEndAt: new Date(morningEndAt).toISOString(),
    reportId: personal.id,
    deepLink: `kiloapp://agent-briefing/${personal.id}`,
    listDeepLink: 'kiloapp://agent-briefing',
    organizationReportId: organization?.id ?? null,
    organizationDeepLink: organization ? `kiloapp://agent-briefing/${organization.id}` : null,
    blockedSessionId: checkoutId,
    pullRequestUrl: prUrl,
  };
}
