import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as z from 'zod';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { MCP_CONNECT_CLIENTS } from '@/lib/organizations/guardrails/mcp-connections';
import { recordPermissionEvents } from '@/lib/organizations/guardrails/permission-policy';
import {
  MAX_COMMAND_KEY_LENGTH,
  MAX_PERMISSION_EVENT_COUNT,
  MAX_PERMISSION_EVENTS_PER_REQUEST,
  MAX_PERMISSION_LENGTH,
  PERMISSION_EVENT_DECISIONS,
  PermissionTierSchema,
} from '@/lib/organizations/permissions/types';

const MAX_DAY_AGE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

const COMMAND_LINE_CHARACTERS = new Set(['$', '`', '|', ';', '&', '<', '>', '\u2028', '\u2029']);

function isCommandPrefix(key: string): boolean {
  return [...key].every(char => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f && !COMMAND_LINE_CHARACTERS.has(char);
  });
}

const DaySchema = z.iso
  .date()
  .refine(
    day => day >= utcDay(MAX_DAY_AGE) && day <= utcDay(0),
    `Day must be within the last ${MAX_DAY_AGE} days (UTC) and not in the future`
  );

const CommandKeySchema = z
  .string()
  .min(1)
  .max(MAX_COMMAND_KEY_LENGTH)
  .refine(isCommandPrefix, 'Command key must be a command prefix, not a command line');

const EntrySchema = z
  .object({
    day: DaySchema,
    permission: z.string().trim().min(1).max(MAX_PERMISSION_LENGTH),
    commandKey: CommandKeySchema,
    decision: z.enum(PERMISSION_EVENT_DECISIONS),
    count: z.number().int().min(1).max(MAX_PERMISSION_EVENT_COUNT),
    firstSeenAt: z.iso.datetime({ offset: true }),
    lastSeenAt: z.iso.datetime({ offset: true }),
    ruleId: z.uuid().optional(),
    tier: PermissionTierSchema.optional(),
  })
  .refine(entry => Date.parse(entry.firstSeenAt) <= Date.parse(entry.lastSeenAt), {
    message: 'firstSeenAt must not be after lastSeenAt',
  });

const BodySchema = z.object({
  client: z.enum(MCP_CONNECT_CLIENTS),
  policyRevision: z.number().int().min(0).max(2147483647).optional(),
  entries: z.array(EntrySchema).max(MAX_PERMISSION_EVENTS_PER_REQUEST),
});

/**
 * Adds a client's daily aggregates of organization permission decisions. Answers with the current
 * policy revision so a client holding a stale policy refetches it. The body is never logged,
 * because command keys can carry sensitive text.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ revision: number } | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    return nextResponse;
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = BodySchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: z.prettifyError(body.error) }, { status: 400 });
  }

  return NextResponse.json(
    await recordPermissionEvents({
      organization: data.organization,
      kiloUserId: data.user.id,
      client: body.data.client,
      policyRevision: body.data.policyRevision,
      entries: body.data.entries,
    })
  );
}
