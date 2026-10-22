import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import { isDefaultSessionTitle } from '../ingest/default-session-title';

export const reportSessionTitleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  generated: z.boolean(),
});

export type ReportedSessionTitleInput = z.infer<typeof reportSessionTitleSchema>;

export type ReportedSessionTitleResult =
  | { kind: 'not_found' }
  | { kind: 'refused' }
  | { kind: 'applied'; row: typeof cli_sessions_v2.$inferSelect };

export async function applyReportedSessionTitle(
  db: Pick<WorkerDb, 'select' | 'update'>,
  params: {
    sessionId: string;
    kiloUserId: string;
    input: ReportedSessionTitleInput;
    scope?: SQL;
  }
): Promise<ReportedSessionTitleResult> {
  const ownership = and(
    eq(cli_sessions_v2.session_id, params.sessionId),
    eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
    params.scope
  );

  const [existing] = await db.select().from(cli_sessions_v2).where(ownership).limit(1);
  if (!existing) return { kind: 'not_found' };

  const { title, generated } = params.input;
  if (generated && !isDefaultSessionTitle(existing.title)) return { kind: 'refused' };

  const writeWhere = generated
    ? and(
        ownership,
        existing.title == null
          ? isNull(cli_sessions_v2.title)
          : eq(cli_sessions_v2.title, existing.title)
      )
    : ownership;

  const [updatedRow] = await db
    .update(cli_sessions_v2)
    .set({ title, updated_at: existing.updated_at })
    .where(writeWhere)
    .returning();

  if (!updatedRow) return generated ? { kind: 'refused' } : { kind: 'not_found' };
  return { kind: 'applied', row: updatedRow };
}
