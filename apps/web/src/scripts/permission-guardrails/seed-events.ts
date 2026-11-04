/**
 * Seeds fake daily permission events so the permission guardrails usage log can be reviewed
 * locally. Local development only: real events are reported by
 * POST /api/organizations/[id]/permissions/events, but no client reports them yet.
 *
 * Usage (from apps/web):
 *   pnpm script:run permission-guardrails seed-events <organizationId> [entryCount]
 */
import {
  organization_memberships,
  organization_permission_events_daily,
  type NewOrganizationPermissionEventDaily,
} from '@kilocode/db/schema';
import type { OrganizationPermissionEventDecision } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq, sql } from 'drizzle-orm';

const DEFAULT_ENTRY_COUNT = 80;
const MAX_ENTRY_COUNT = 500;
const CLIENTS = ['cli', 'cloud_agent', 'vscode', 'jetbrains'];
const DECISIONS: OrganizationPermissionEventDecision[] = ['allowed', 'asked', 'denied', 'denied'];
const DAY_MS = 24 * 60 * 60 * 1_000;

const KEYS: { permission: string; commandKey: string }[] = [
  { permission: 'bash', commandKey: 'git status' },
  { permission: 'bash', commandKey: 'git push' },
  { permission: 'bash', commandKey: 'git log' },
  { permission: 'bash', commandKey: 'npm install' },
  { permission: 'bash', commandKey: 'rm' },
  { permission: 'bash', commandKey: 'curl' },
  { permission: 'read', commandKey: '*' },
  { permission: 'edit', commandKey: '*' },
  { permission: 'webfetch', commandKey: '*' },
  { permission: 'external_directory', commandKey: '*' },
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function run(organizationId?: string, entryCountArg?: string) {
  if (!organizationId) throw new Error('Usage: seed-events <organizationId> [entryCount]');
  const entryCount = Math.min(
    Number.parseInt(entryCountArg ?? '', 10) || DEFAULT_ENTRY_COUNT,
    MAX_ENTRY_COUNT
  );

  const members = await db
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .where(eq(organization_memberships.organization_id, organizationId));
  if (members.length === 0) throw new Error(`Organization ${organizationId} has no members.`);

  const now = Date.now();
  const entries = new Map<string, NewOrganizationPermissionEventDaily>();
  for (let index = 0; index < entryCount; index++) {
    const key = pick(KEYS);
    const seenAt = new Date(now - Math.random() * 30 * DAY_MS);
    const entry: NewOrganizationPermissionEventDaily = {
      organization_id: organizationId,
      day: seenAt.toISOString().slice(0, 10),
      kilo_user_id: pick(members).userId,
      client: pick(CLIENTS),
      permission: key.permission,
      command_key: key.commandKey,
      decision: pick(DECISIONS),
      count: 1 + Math.floor(Math.random() * 20),
      first_seen_at: seenAt.toISOString(),
      last_seen_at: seenAt.toISOString(),
    };
    const uniqueKey = [
      entry.day,
      entry.kilo_user_id,
      entry.client,
      entry.permission,
      entry.command_key,
      entry.decision,
    ].join('\u0000');
    entries.set(uniqueKey, entry);
  }

  const rows = [...entries.values()];
  const events = organization_permission_events_daily;
  await db
    .insert(events)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        events.organization_id,
        events.day,
        events.kilo_user_id,
        events.client,
        events.permission,
        events.command_key,
        events.decision,
      ],
      set: {
        count: sql`${events.count} + excluded.count`,
        first_seen_at: sql`least(${events.first_seen_at}, excluded.first_seen_at)`,
        last_seen_at: sql`greatest(${events.last_seen_at}, excluded.last_seen_at)`,
      },
    });
  console.log(`Upserted ${rows.length} daily permission events for ${members.length} members.`);
}
