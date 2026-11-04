/**
 * Seeds fake MCP connect events so the MCP guardrails audit log can be reviewed locally.
 * Local development only: real connect events are recorded by
 * POST /api/organizations/[id]/guardrails/mcp-connections, but no client reports them yet.
 *
 * Usage (from apps/web):
 *   pnpm script:run mcp-guardrails seed-connect-events <organizationId> [eventCount]
 */
import {
  organization_mcp_connect_events,
  organization_memberships,
  type NewOrganizationMcpConnectEvent,
} from '@kilocode/db/schema';
import type {
  OrganizationMcpConnectDecision,
  OrganizationMcpConnectTarget,
} from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { mcpIdentityKey } from '@/lib/organizations/guardrails/mcp-identity';
import { eq } from 'drizzle-orm';

const DEFAULT_EVENT_COUNT = 60;
const MAX_EVENT_COUNT = 500;
const CLIENTS = ['cli', 'cloud_agent', 'vscode', 'jetbrains'];
const DECISIONS: OrganizationMcpConnectDecision[] = ['allowed', 'denied', 'denied'];
const DAY_MS = 24 * 60 * 60 * 1_000;

const SERVERS: { target: OrganizationMcpConnectTarget; name: string | null }[] = [
  { target: { kind: 'remote', url: 'https://mcp.linear.app/mcp' }, name: 'linear' },
  { target: { kind: 'remote', url: 'https://mcp.notion.com/mcp' }, name: 'notion' },
  {
    target: {
      kind: 'package',
      ecosystem: 'npm',
      identifier: '@modelcontextprotocol/server-github',
    },
    name: 'github',
  },
  { target: { kind: 'package', ecosystem: 'pypi', identifier: 'mcp-server-fetch' }, name: null },
  { target: { kind: 'remote', url: 'https://tools.internal.example.com/mcp' }, name: 'internal' },
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function run(organizationId?: string, eventCountArg?: string) {
  if (!organizationId) throw new Error('Usage: seed-connect-events <organizationId> [eventCount]');
  const eventCount = Math.min(
    Number.parseInt(eventCountArg ?? '', 10) || DEFAULT_EVENT_COUNT,
    MAX_EVENT_COUNT
  );

  const members = await db
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .where(eq(organization_memberships.organization_id, organizationId));
  if (members.length === 0) throw new Error(`Organization ${organizationId} has no members.`);

  const now = Date.now();
  const events: NewOrganizationMcpConnectEvent[] = Array.from({ length: eventCount }, () => {
    const server = pick(SERVERS);
    return {
      organization_id: organizationId,
      kilo_user_id: pick(members).userId,
      client: pick(CLIENTS),
      decision: pick(DECISIONS),
      identity_key: mcpIdentityKey(server.target),
      target: server.target,
      server_name: server.name,
      created_at: new Date(now - Math.random() * 30 * DAY_MS).toISOString(),
    };
  });
  await db.insert(organization_mcp_connect_events).values(events);
  console.log(`Inserted ${events.length} connect events for ${members.length} members.`);
}
