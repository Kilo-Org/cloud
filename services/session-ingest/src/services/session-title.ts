import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import {
  DEFAULT_SESSION_TITLE_PATTERN,
  isDefaultSessionTitle,
} from '../ingest/default-session-title';

export const sessionTitleSchema = z.string().trim().min(1).max(200);

export const reportSessionTitleSchema = z.object({
  title: sessionTitleSchema,
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
  const existingIsPlaceholder = isDefaultSessionTitle(existing.title);
  if (generated && !existingIsPlaceholder) return { kind: 'refused' };
  // A late or retried non-generated report can still carry the creation
  // placeholder (`New session - <timestamp>`) after the agent or a user has
  // named the session. That reporter may not know about the newer title, so
  // letting the placeholder through would reset the sidebar row to "New chat".
  // Real renames still win last-write.
  if (!generated && !existingIsPlaceholder && isDefaultSessionTitle(title)) {
    return { kind: 'refused' };
  }

  // Re-check the stored title inside the UPDATE so the placeholder refusal is
  // atomic: a real title (user rename or generated title) that commits after
  // this request's read still wins. Without this predicate a late or retried
  // placeholder report would overwrite it via the ownership-only WHERE clause.
  const placeholderOnly = sql`(${cli_sessions_v2.title} is null or ${cli_sessions_v2.title} ~ ${DEFAULT_SESSION_TITLE_PATTERN.source})`;

  const writeWhere = generated
    ? and(
        ownership,
        placeholderOnly,
        existing.title == null
          ? isNull(cli_sessions_v2.title)
          : eq(cli_sessions_v2.title, existing.title)
      )
    : isDefaultSessionTitle(title)
      ? and(ownership, placeholderOnly)
      : ownership;

  const [updatedRow] = await db
    .update(cli_sessions_v2)
    .set({ title, updated_at: existing.updated_at })
    .where(writeWhere)
    .returning();

  if (!updatedRow)
    return generated || isDefaultSessionTitle(title) ? { kind: 'refused' } : { kind: 'not_found' };
  return { kind: 'applied', row: updatedRow };
}
