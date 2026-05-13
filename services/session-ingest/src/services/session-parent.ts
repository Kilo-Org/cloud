import { and, eq, sql } from 'drizzle-orm';
import type { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

const PARENT_SESSION_LINK_ATTEMPTS = 3;
const PARENT_SESSION_LINK_DELAY_MS = 250;

type WorkerDb = ReturnType<typeof getWorkerDb>;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('code' in err && err.code === '23503') return true;
  return 'cause' in err && isForeignKeyViolation(err.cause);
}

async function sessionAlreadyLinkedToParent(
  db: WorkerDb,
  kiloUserId: string,
  sessionId: string,
  parentSessionId: string
): Promise<boolean> {
  const sessionRows = await db
    .select({ parent_session_id: cli_sessions_v2.parent_session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);

  return sessionRows[0]?.parent_session_id === parentSessionId;
}

async function updateParentSessionIdIfParentExists(
  db: WorkerDb,
  kiloUserId: string,
  sessionId: string,
  parentSessionId: string
): Promise<boolean> {
  const updatedRows = await db
    .update(cli_sessions_v2)
    .set({ parent_session_id: parentSessionId })
    .where(
      and(
        eq(cli_sessions_v2.session_id, sessionId),
        eq(cli_sessions_v2.kilo_user_id, kiloUserId),
        sql`${cli_sessions_v2.parent_session_id} IS DISTINCT FROM ${parentSessionId}`,
        sql`EXISTS (
          SELECT 1 FROM ${cli_sessions_v2} parent_session
          WHERE parent_session.session_id = ${parentSessionId}
            AND parent_session.kilo_user_id = ${kiloUserId}
        )`
      )
    )
    .returning({ session_id: cli_sessions_v2.session_id });

  return updatedRows.length > 0;
}

export async function setSafeParentSessionId(
  db: WorkerDb,
  kiloUserId: string,
  sessionId: string,
  parentSessionId: string,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<boolean> {
  if (parentSessionId === sessionId) return false;

  const attempts = options.attempts ?? PARENT_SESSION_LINK_ATTEMPTS;
  const delayMs = options.delayMs ?? PARENT_SESSION_LINK_DELAY_MS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await sessionAlreadyLinkedToParent(db, kiloUserId, sessionId, parentSessionId)) return true;

    try {
      if (await updateParentSessionIdIfParentExists(db, kiloUserId, sessionId, parentSessionId)) {
        return true;
      }
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
    }

    if (attempt < attempts && delayMs > 0) await sleep(delayMs);
  }

  return false;
}
