/**
 * Everything about *many* chats: which ones there are, what to call them, what
 * order they come in, and how one is thrown away.
 *
 * None of it belongs to the harness SDK. Its store saves one conversation and
 * reads it back, and that is the whole of its job — a list, a title and a
 * delete are the app's, because only the app knows who is signed in, which
 * organization is paying, and what a person expects a screen to show.
 *
 * So this file reads across two owners on the one database: the `chats` table
 * the app owns (`src/lib/persist/schema.ts`), and the `sessions`, `turns` and
 * `parts` tables the SDK's SQLite store plugin owns. The join is the point of
 * the file, and it is why the SQL is here in one place and nowhere else.
 */

/** What SQLite takes as a bound value here. Chats hold text and numbers. */
type SqlValue = string | number;

/** The part of an Expo database this file uses, so a test can supply one. */
export type ChatDatabase = {
  readonly getAllSync: <T>(source: string, params: SqlValue[]) => T[];
  readonly runSync: (source: string, params: SqlValue[]) => void;
};

/** One row of the chat list. */
export type ChatSummary = {
  readonly sessionId: string;
  /** The model the conversation is on now, which a switch changes. */
  readonly model: string;
  /** The first thing the user said, or empty for a chat with nothing in it. */
  readonly title: string;
  readonly updatedAt: number;
};

type SummaryRow = {
  readonly session_id: string;
  readonly model: string;
  readonly title: string | null;
  readonly updated_at: number;
};

/**
 * The list, newest first.
 *
 * The title is the first thing the user said, read as a subquery rather than by
 * loading every turn of every conversation to draw one screen. Both subqueries
 * are answered by the store's own `(session_id, id)` indexes.
 *
 * A chat whose session the SDK never wrote — a create that failed half way —
 * is left out by the join rather than drawn as a row that opens onto nothing.
 */
const LIST = `
  select
    chats.session_id,
    sessions.model,
    chats.updated_at,
    (
      select parts.body from parts
      join turns on parts.turn_id = turns.id
      where turns.session_id = chats.session_id
        and turns.role = 'user' and parts.kind = 'text'
      order by parts.id limit 1
    ) as title
  from chats
  join sessions on sessions.id = chats.session_id
  where chats.scope = ?
  order by chats.updated_at desc
`;

export function listChats(db: ChatDatabase, scope: string): ChatSummary[] {
  return db.getAllSync<SummaryRow>(LIST, [scope]).map(row => ({
    sessionId: row.session_id,
    model: row.model,
    title: row.title ?? '',
    updatedAt: row.updated_at,
  }));
}

/** The scope a chat belongs to, or null when the chat is not one of ours. */
export function scopeOfChat(db: ChatDatabase, sessionId: string): string | null {
  const rows = db.getAllSync<{ scope: string }>('select scope from chats where session_id = ?', [
    sessionId,
  ]);
  return rows[0]?.scope ?? null;
}

/** The model a session was opened on, which the SDK's store holds. */
export function modelOfSession(db: ChatDatabase, sessionId: string): string | null {
  const rows = db.getAllSync<{ model: string }>('select model from sessions where id = ?', [
    sessionId,
  ]);
  return rows[0]?.model ?? null;
}

/** Records a chat, so the list has it. */
export function rememberChat(
  db: ChatDatabase,
  chat: { readonly sessionId: string; readonly scope: string; readonly at: number }
): void {
  db.runSync(
    'insert into chats (session_id, scope, updated_at) values (?, ?, ?) ' +
      'on conflict (session_id) do update set updated_at = excluded.updated_at',
    [chat.sessionId, chat.scope, chat.at]
  );
}

/** Moves a chat to the top of the list. Called when something is said in it. */
export function touchChat(db: ChatDatabase, sessionId: string, at: number): void {
  db.runSync('update chats set updated_at = ? where session_id = ?', [at, sessionId]);
}

/**
 * Moves a chat onto another session, keeping its place in the list.
 *
 * Switching models is what moves one: the harness copies the conversation onto
 * a session opened on the other model, and the chat the person is looking at is
 * now that session. The row is updated rather than added to, so one
 * conversation stays one row.
 */
export function moveChat(
  db: ChatDatabase,
  move: { readonly from: string; readonly to: string; readonly at: number }
): void {
  db.runSync('update chats set session_id = ?, updated_at = ? where session_id = ?', [
    move.to,
    move.at,
    move.from,
  ]);
}

/**
 * Forgets the conversation the SDK holds under one session.
 *
 * Children first: the store runs with foreign keys on, so a session deleted out
 * from under its own turns is refused. Half a delete would leave turns nothing
 * can reach and nothing can remove.
 */
export function forgetSession(db: ChatDatabase, sessionId: string): void {
  db.runSync('delete from parts where session_id = ?', [sessionId]);
  db.runSync('delete from turns where session_id = ?', [sessionId]);
  db.runSync('delete from sessions where id = ?', [sessionId]);
}

/** Forgets a chat: the row that lists it, and the conversation under it. */
export function deleteChat(db: ChatDatabase, sessionId: string): void {
  forgetSession(db, sessionId);
  db.runSync('delete from chats where session_id = ?', [sessionId]);
}

/**
 * Forgets every chat of one account, which is what signing out does.
 *
 * A conversation is the most personal thing this app keeps on the device, so it
 * goes when the account does rather than waiting for the next person to sign in
 * under the same install. An account with several organizations has a scope for
 * each, so this takes the account rather than one scope.
 *
 * An unknown account wipes the lot, because privacy wins over keeping someone
 * else's chats through a sign-out that could not name them.
 */
export function wipeChats(db: ChatDatabase, userId: string | null): void {
  const rows =
    userId === null
      ? db.getAllSync<{ session_id: string }>('select session_id from chats', [])
      : db.getAllSync<{ session_id: string }>('select session_id from chats where scope like ?', [
          `${userId}:%`,
        ]);
  for (const { session_id: sessionId } of rows) {
    deleteChat(db, sessionId);
  }
}
