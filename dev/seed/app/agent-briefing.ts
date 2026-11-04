import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { computeDatabaseUrl } from '@kilocode/db';
import {
  agent_briefing_context_preferences,
  agent_briefing_preferences,
  agent_briefing_snapshots,
  cli_sessions_v2,
  organization_memberships,
} from '@kilocode/db/schema';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getSeedDb } from '../lib/db';
import { isValidEmail, resolveSeedUserId } from '../lib/users';
import type { SeedResult } from '../index';

export const usage =
  '<email> [--organization-id=<uuid>] [--timezone=<IANA>] [--web-url=<url>] [--model=<id>]';
const MINUTE_MS = 60_000;
const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
};
const DEFAULT_MODEL = '~deepseek/deepseek-flash-latest';
const serviceStatusSchema = z.object({
  services: z.array(
    z.object({ name: z.string(), status: z.string(), port: z.number().optional() })
  ),
});
type Options = {
  email: string;
  organizationId: string | null;
  timezone: string | null;
  webUrl: string | null;
  model: string;
};

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:agent-briefing ${usage}`);
  console.log(
    'Seeds recent session metadata and completed-response excerpts for an existing local user.'
  );
  console.log(
    'Enables the selected contexts and captures their scheduled reports through the local cron route.'
  );
  console.log(
    'Notifications stay off. Run the summary cron separately to process the queued reports.'
  );
  console.log('Summary generation can invoke the configured paid model.');
}

function parseArgs(args: string[]): Options {
  const email = args[0]?.trim();
  if (!email || !isValidEmail(email)) {
    printUsage();
    throw new Error('A valid email is required');
  }
  const options: Options = {
    email,
    organizationId: null,
    timezone: null,
    webUrl: null,
    model: DEFAULT_MODEL,
  };
  for (const arg of args.slice(1)) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (flag === '--organization-id' && value) options.organizationId = z.uuid().parse(value);
    else if (flag === '--timezone' && value) options.timezone = value;
    else if (flag === '--web-url' && value) options.webUrl = value;
    else if (flag === '--model' && value) options.model = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function assertLoopback(url: string, label: string): void {
  if (!Object.hasOwn(LOOPBACK_HOSTS, new URL(url).hostname)) {
    throw new Error(`Agent briefing seed requires a loopback ${label}.`);
  }
}

function resolveWebUrl(override: string | null): string {
  if (override) return override.replace(/\/$/, '');
  const status = serviceStatusSchema.parse(
    JSON.parse(execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' }))
  );
  const web = status.services.find(service => service.name === 'nextjs' && service.status === 'up');
  if (web?.port) return `http://localhost:${web.port}`;
  throw new Error('No running nextjs service; pass --web-url.');
}

function stableSessionId(userId: string, key: string): string {
  const hash = createHash('sha256')
    .update(`dev-seed:agent-briefing:${userId}:${key}`)
    .digest('hex');
  return `ses_${hash.slice(0, 26)}`;
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
  if (process.env.USE_PRODUCTION_DB === 'true')
    throw new Error('Production databases are not allowed.');
  assertLoopback(computeDatabaseUrl(), 'database host');
  const webUrl = resolveWebUrl(options.webUrl);
  assertLoopback(webUrl, 'web URL');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) throw new Error('CRON_SECRET must match the local web server.');
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
    if (!membership) throw new Error('The user cannot read briefings for that organization.');
  }
  const [existing] = await db
    .select()
    .from(agent_briefing_preferences)
    .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  const timezone = options.timezone ?? existing?.timezone ?? 'UTC';
  const now = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const cutoffAt = now - 5 * MINUTE_MS;
  const nightStartAt = cutoffAt - 180 * MINUTE_MS;
  const morningEndAt = now + 180 * MINUTE_MS;
  const completedAt = new Date(cutoffAt - 20 * MINUTE_MS).toISOString();
  const localDate = localClock(new Date(cutoffAt), timezone).date;
  const sessions = [
    {
      key: 'checkout',
      title: 'Stabilize checkout retries',
      organizationId: null,
      status: 'question',
      text: 'Added a deterministic checkout regression test. The retry policy needs a decision.',
    },
    {
      key: 'docs',
      title: 'Refresh API reference',
      organizationId: null,
      status: 'idle',
      text: 'Regenerated the API reference and repaired the broken examples.',
    },
    ...(options.organizationId
      ? [
          {
            key: 'release',
            title: 'Prepare release notes',
            organizationId: options.organizationId,
            status: 'idle',
            text: 'Prepared release notes from merged changes.',
          },
        ]
      : []),
  ];
  const sessionIds = sessions.map(session => stableSessionId(userId, session.key));
  for (const sessionId of sessionIds) {
    await db
      .delete(agent_briefing_snapshots)
      .where(
        and(
          eq(agent_briefing_snapshots.kilo_user_id, userId),
          eq(agent_briefing_snapshots.local_date, localDate),
          sql`${agent_briefing_snapshots.facts}->'sessions' @> ${JSON.stringify([{ sessionId }])}::jsonb`
        )
      );
  }
  const [previousReport] = await db
    .select({ id: agent_briefing_snapshots.id })
    .from(agent_briefing_snapshots)
    .where(
      and(
        eq(agent_briefing_snapshots.kilo_user_id, userId),
        eq(agent_briefing_snapshots.local_date, localDate)
      )
    );
  if (previousReport)
    throw new Error('A report already exists for this morning; use a fresh fixture user.');
  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, userId), inArray(cli_sessions_v2.session_id, sessionIds))
    );
  for (const session of sessions) {
    const sessionId = stableSessionId(userId, session.key);
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: userId,
      title: session.title,
      created_on_platform: 'cli',
      organization_id: session.organizationId,
      status: session.status,
      status_updated_at: completedAt,
      last_activity_at: completedAt,
      briefing_excerpt: { messageId: `msg_${session.key}`, completedAt, text: session.text },
      ...(session.key === 'checkout'
        ? {
            git_url: 'https://github.com/kilo-seed/agent-briefing',
            git_branch: 'fix/checkout-retries',
            platform: 'github',
            pr_url: 'https://github.com/kilo-seed/agent-briefing/pull/4242',
            pr_number: 4242,
            pr_link_verified_at: completedAt,
          }
        : {}),
    } satisfies typeof cli_sessions_v2.$inferInsert);
  }
  const schedule = {
    timezone,
    night_start: localClock(new Date(nightStartAt), timezone).time,
    morning_start: localClock(new Date(cutoffAt), timezone).time,
    morning_end: localClock(new Date(morningEndAt), timezone).time,
    notifications_enabled: false,
    next_run_at: new Date(cutoffAt).toISOString(),
  };
  await db
    .insert(agent_briefing_preferences)
    .values({ kilo_user_id: userId, ...schedule })
    .onConflictDoUpdate({ target: agent_briefing_preferences.kilo_user_id, set: schedule });
  for (const organizationId of [
    null,
    ...(options.organizationId ? [options.organizationId] : []),
  ]) {
    const values = {
      kilo_user_id: userId,
      context_key: organizationId ?? 'personal',
      organization_id: organizationId,
      enabled: true,
      model: options.model,
    };
    await db
      .insert(agent_briefing_context_preferences)
      .values(values)
      .onConflictDoUpdate({
        target: [
          agent_briefing_context_preferences.kilo_user_id,
          agent_briefing_context_preferences.context_key,
        ],
        set: values,
      });
  }
  const response = await fetch(`${webUrl}/api/cron/agent-briefing`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Briefing scheduler returned ${response.status}.`);
  const reports = await db
    .select({
      id: agent_briefing_snapshots.id,
      organizationId: agent_briefing_snapshots.organization_id,
    })
    .from(agent_briefing_snapshots)
    .where(
      and(
        eq(agent_briefing_snapshots.kilo_user_id, userId),
        eq(agent_briefing_snapshots.local_date, localDate)
      )
    );
  const personal = reports.find(report => report.organizationId === null);
  if (!personal) throw new Error('The scheduler did not capture the personal briefing.');
  const organization = reports.find(report => report.organizationId === options.organizationId);
  console.log(
    'This fixture represents recent session snapshots with a current question and a verified pull request.'
  );
  console.log(
    'Run the local summary cron to publish the queued reports, then open the returned deep link.'
  );
  return {
    userId,
    timezone,
    localDate,
    reportId: personal.id,
    deepLink: `kiloapp:///(app)/agent-briefing/${personal.id}`,
    listDeepLink: 'kiloapp:///(app)/agent-briefing',
    organizationReportId: options.organizationId ? (organization?.id ?? null) : null,
    blockedSessionId: stableSessionId(userId, 'checkout'),
  };
}
