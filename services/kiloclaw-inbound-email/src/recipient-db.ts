import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_inbound_email_aliases, kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppEnv } from './types';

export async function lookupInstanceIdByAlias(env: AppEnv, alias: string): Promise<string | null> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const [row] = await db
    .select({ instanceId: kiloclaw_inbound_email_aliases.instance_id })
    .from(kiloclaw_inbound_email_aliases)
    .innerJoin(
      kiloclaw_instances,
      eq(kiloclaw_instances.id, kiloclaw_inbound_email_aliases.instance_id)
    )
    .where(
      and(eq(kiloclaw_inbound_email_aliases.alias, alias), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1);

  return row?.instanceId ?? null;
}
