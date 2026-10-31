import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { z } from 'zod';
import { getPgDb } from '../../db/pg.js';
import type { Env } from '../../types.js';
import { events } from './sqlite-schema.js';

type HistoryLineage = { parentID: string; info?: Record<string, unknown> };
const lineageSchema = z.object({ parentID: z.string().min(1) });

export function readStoredHistoryLineage(
  db: DrizzleSqliteDODatabase,
  rootKiloSessionId: string,
  kiloSessionId: string
): HistoryLineage | null | undefined {
  let current = kiloSessionId;
  let parentID: string | undefined;
  const visited = new Set<string>();
  for (let depth = 0; depth < 64 && current !== rootKiloSessionId; depth += 1) {
    if (visited.has(current)) return null;
    visited.add(current);
    const row = db
      .select({
        parentID: sql<unknown>`json_extract(${events.payload}, '$.properties.info.parentID')`,
      })
      .from(events)
      .where(eq(events.entity_id, `session/${current}`))
      .get();
    if (row === undefined) return undefined;
    const parsed = lineageSchema.safeParse(row);
    if (!parsed.success) return null;
    parentID ??= parsed.data.parentID;
    current = parsed.data.parentID;
  }
  return current === rootKiloSessionId && parentID !== undefined ? { parentID } : null;
}

export async function readOwnedHistoryLineage(input: {
  env: Pick<Env, 'HYPERDRIVE'>;
  userId: string;
  sessionId: string;
  rootKiloSessionId: string;
  kiloSessionId: string;
}): Promise<HistoryLineage | null> {
  const db = getPgDb(input.env);
  let current = input.kiloSessionId;
  let parentID: string | undefined;
  const visited = new Set<string>();
  for (let depth = 0; depth < 64 && current !== input.rootKiloSessionId; depth += 1) {
    if (visited.has(current)) return null;
    visited.add(current);
    const [row] = await db
      .select({ parentID: cli_sessions_v2.parent_session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, input.userId),
          eq(cli_sessions_v2.session_id, current),
          eq(cli_sessions_v2.cloud_agent_session_id, input.sessionId)
        )
      )
      .limit(1);
    const parsed = lineageSchema.safeParse(row);
    if (!parsed.success) return null;
    parentID ??= parsed.data.parentID;
    current = parsed.data.parentID;
  }
  return current === input.rootKiloSessionId && parentID !== undefined ? { parentID } : null;
}
