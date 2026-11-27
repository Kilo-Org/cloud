import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import {
  CA_BUNDLE_PATH,
  ProbeError,
  SESSION_LABEL_PREFIX,
  actAsLogin,
  actAsOwner,
  connect,
  countSessions,
  endLeftovers,
  ownPair,
  probe,
  serverMessageOf,
  sqlstateOf,
  type Login,
  type ProbeReason,
  type SessionPair,
} from './session.ts';

/** The advisory lock every proxy run holds while it migrates (§6 step 4). */
const RUN_LOCK_KEY = '7420310552';

const MIGRATIONS_PATH = 'packages/db/src/migrations';
const SQL_FILE = /^\d{4}_[a-z0-9_-]+\.sql$/;

export type ApplyRequest = Login & {
  runId: string;
  recordedPairs: SessionPair[];
  /** `meta/_journal.json` as fetched. */
  journal: string;
  /** `<tag>.sql` → file text, every file the journal names. */
  files: Record<string, string>;
  /** The owner-approved migration blobs (§5 step 5). */
  reviewed: { path: string; blob: string }[];
};

export type FailureCode =
  | 'probe_failed'
  | 'leftover_not_ended'
  | 'lock_busy'
  | 'journal_order_invalid'
  | 'migration_not_reviewed'
  | 'invalid_index_present'
  | 'migration_failed';

export type RunFailure = {
  code: FailureCode;
  reason: ProbeReason | null;
  sqlstate: string | null;
  migrationTag: string | null;
  indexes: string[];
};

export type AppliedMigration = { tag: string; hash: string; createdAt: number };

export type RunStatus = {
  runId: string;
  /** `probing` until the probe passes, `migrating` after it, `done` once the session closed. */
  phase: 'probing' | 'migrating' | 'done';
  pair: SessionPair | null;
  pending: string[] | null;
  applied: AppliedMigration[];
  /** Set once the leftover cleanup ran (§6 step 3). */
  cleanup: { terminated: number; unexpected: number } | null;
  failure: RunFailure | null;
  heartbeatAt: string;
};

export type RunHandle = {
  runId: string;
  status(): RunStatus;
  /** Sends a cancel request for the running statement. */
  cancel(): Promise<void>;
  done: Promise<void>;
};

type Log = (event: Record<string, string | number | null>) => void;

type JournalEntry = { tag: string; when: number };

class RunStop extends Error {
  readonly failure: RunFailure;
  /** `cause` is the failed statement's error, whose server message is logged (never returned). */
  constructor(failure: Partial<RunFailure> & { code: FailureCode }, cause?: unknown) {
    super(failure.code, { cause });
    this.failure = { reason: null, sqlstate: null, migrationTag: null, indexes: [], ...failure };
  }
}

/** git's blob id of a file: `sha1("blob <len>\0" + bytes)`. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest('hex');
}

function journalEntries(journal: string): JournalEntry[] {
  const parsed: unknown = JSON.parse(journal);
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new Error('journal has no entries');
  }
  const { entries } = parsed;
  if (!Array.isArray(entries)) throw new Error('journal entries is not an array');
  return entries.map((entry: unknown) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('tag' in entry) ||
      !('when' in entry) ||
      typeof entry.tag !== 'string' ||
      typeof entry.when !== 'number'
    ) {
      throw new Error('journal entry is malformed');
    }
    return { tag: entry.tag, when: entry.when };
  });
}

/**
 * Index names a pending migration rebuilds with `DROP INDEX CONCURRENTLY IF EXISTS <name>`
 * (quoted or not, with or without `public.`): the retry path `packages/db/AGENTS.md` designs.
 */
export function rebuiltIndexes(sqlTexts: readonly string[]): Set<string> {
  const names = new Set<string>();
  const pattern =
    /DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+(?:"?public"?\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  for (const text of sqlTexts) {
    for (const match of text.matchAll(pattern)) names.add(match[1] ?? match[2]);
  }
  return names;
}

/**
 * The retryable or not judgement is the Durable Object's; a dropped connection, which node-postgres
 * reports without a SQLSTATE, is reported as `08006` (connection failure) so it counts as one.
 */
function failedStatementSqlstate(error: unknown): string | null {
  const sqlstate = sqlstateOf(error);
  if (sqlstate !== null) return sqlstate;
  const message = error instanceof Error ? error.message : '';
  if (/Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|socket/i.test(message)) return '08006';
  return null;
}

/**
 * Sends the protocol's CancelRequest for `pid` over TLS with the bundled CA, the way psql's
 * cancel does: it needs the backend's secret key, not the password the run already dropped.
 */
function sendCancel(login: Login, pid: number, secretKey: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const socket = netConnect({ host: login.target.host, port: login.target.port });
  const finish = () => {
    socket.destroy();
    resolve();
  };
  socket.setTimeout(10_000, finish);
  socket.on('error', finish);
  socket.once('connect', () => {
    const sslRequest = Buffer.alloc(8);
    sslRequest.writeInt32BE(8, 0);
    sslRequest.writeInt32BE(80877103, 4);
    socket.write(sslRequest);
  });
  socket.once('data', answer => {
    if (answer[0] !== 0x53) return finish();
    const secure = tlsConnect({
      socket,
      servername: login.target.host,
      ca: readFileSync(CA_BUNDLE_PATH, 'utf8'),
      rejectUnauthorized: true,
    });
    secure.on('error', finish);
    secure.once('secureConnect', () => {
      const cancel = Buffer.alloc(16);
      cancel.writeInt32BE(16, 0);
      cancel.writeInt32BE(80877102, 4);
      cancel.writeInt32BE(pid, 8);
      cancel.writeInt32BE(secretKey, 12);
      secure.end(cancel);
    });
    secure.once('close', finish);
  });
  return promise;
}

/** The backend key node-postgres keeps after the handshake; its types do not declare it. */
function backendKey(client: pg.Client): { pid: number; secretKey: number } | null {
  const pid = 'processID' in client ? client.processID : undefined;
  const secretKey = 'secretKey' in client ? client.secretKey : undefined;
  return typeof pid === 'number' && typeof secretKey === 'number' ? { pid, secretKey } : null;
}

/**
 * Starts one run (§6 steps 1-8) in the background and returns its handle. The password is
 * dropped from the request once the session is open; nothing here logs the target, the user, the
 * password or any SQL text.
 */
export function startApply(request: ApplyRequest, log: Log): RunHandle {
  const login: Login = {
    target: request.target,
    user: request.user,
    password: request.password,
    loginMode: request.loginMode,
    sessionKey: request.sessionKey,
  };
  request.password = '';
  const status: Omit<RunStatus, 'heartbeatAt'> = {
    runId: request.runId,
    phase: 'probing',
    pair: null,
    pending: null,
    applied: [],
    cleanup: null,
    failure: null,
  };
  let client: pg.Client | null = null;

  const run = async (): Promise<void> => {
    const entries = journalEntries(request.journal);
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      mkdirSync(join(dir, 'meta'));
      writeFileSync(join(dir, 'meta', '_journal.json'), request.journal);
      for (const [name, text] of Object.entries(request.files)) {
        if (!SQL_FILE.test(name)) throw new Error('unexpected migration file name');
        writeFileSync(join(dir, name), text);
      }

      try {
        client = await connect(login, `${SESSION_LABEL_PREFIX}${request.runId}`);
      } finally {
        login.password = '';
      }
      await probe(client, login.loginMode);
      status.pair = await ownPair(client);
      status.phase = 'migrating';

      await actAsLogin(client, login);
      const counts = await countSessions(client, login, request.recordedPairs);
      const ended = await endLeftovers(client, login, request.recordedPairs);
      status.cleanup = { terminated: ended.ended, unexpected: counts.unexpected };
      if (ended.notEnded > 0) throw new RunStop({ code: 'leftover_not_ended' });
      await actAsOwner(client, login);

      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [RUN_LOCK_KEY]
      );
      if (lock.rows[0]?.locked !== true) throw new RunStop({ code: 'lock_busy' });

      const before = await newestApplied(client);
      const pending = entries.filter(entry => before === null || entry.when > before);
      status.pending = pending.map(entry => entry.tag);
      for (let index = 1; index < pending.length; index += 1) {
        if (pending[index].when <= pending[index - 1].when) {
          throw new RunStop({ code: 'journal_order_invalid', migrationTag: pending[index].tag });
        }
      }
      const reviewed = new Set(request.reviewed.map(item => `${item.path}@${item.blob}`));
      const pendingTexts: string[] = [];
      for (const entry of pending) {
        const text = request.files[`${entry.tag}.sql`];
        if (
          text === undefined ||
          !reviewed.has(`${MIGRATIONS_PATH}/${entry.tag}.sql@${gitBlobSha(text)}`)
        ) {
          throw new RunStop({ code: 'migration_not_reviewed', migrationTag: entry.tag });
        }
        pendingTexts.push(text);
      }

      const rebuilt = rebuiltIndexes(pendingTexts);
      const invalid = await client.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT i.indisvalid AND n.nspname = 'public'`
      );
      const stray = invalid.rows.map(row => row.relname).filter(name => !rebuilt.has(name));
      if (stray.length > 0) {
        throw new RunStop({ code: 'invalid_index_present', indexes: stray.sort() });
      }

      try {
        await migrate(drizzle({ client }), { migrationsFolder: dir });
      } catch (error) {
        status.applied = await appliedSince(client, before, entries, request.files);
        const appliedTags = new Set(status.applied.map(item => item.tag));
        throw new RunStop(
          {
            code: 'migration_failed',
            sqlstate: failedStatementSqlstate(error),
            migrationTag: pending.find(entry => !appliedTags.has(entry.tag))?.tag ?? null,
          },
          error
        );
      }
      status.applied = await appliedSince(client, before, entries, request.files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const done = run()
    .catch((error: unknown) => {
      if (error instanceof ProbeError) {
        status.failure = {
          code: 'probe_failed',
          reason: error.reason,
          sqlstate: error.sqlstate,
          migrationTag: null,
          indexes: [],
        };
      } else if (error instanceof RunStop) {
        status.failure = error.failure;
      } else {
        status.failure = {
          code: 'migration_failed',
          reason: null,
          sqlstate: failedStatementSqlstate(error),
          migrationTag: null,
          indexes: [],
        };
      }
      log({
        event: 'run_failed',
        runId: request.runId,
        code: status.failure.code,
        reason: status.failure.reason,
        sqlstate: status.failure.sqlstate,
        // Only after login: a refused login's server message names the user.
        message: status.phase === 'migrating' ? serverMessageOf(error) : null,
      });
    })
    .finally(async () => {
      const open: pg.Client | null = client;
      if (open !== null) {
        await open.query('SELECT pg_advisory_unlock_all()').catch(() => {});
        await open.end().catch(() => {});
      }
      status.phase = 'done';
      log({ event: 'run_done', runId: request.runId, result: status.failure ? 'failed' : 'ok' });
    });

  return {
    runId: request.runId,
    status: () => ({
      ...status,
      applied: [...status.applied],
      heartbeatAt: new Date().toISOString(),
    }),
    cancel: async () => {
      const open: pg.Client | null = client;
      const key = open === null ? null : backendKey(open);
      if (key !== null && status.phase !== 'done') await sendCancel(login, key.pid, key.secretKey);
    },
    done,
  };
}

/** `max(created_at)` of drizzle's table, or null when the table does not exist yet. */
async function newestApplied(client: pg.Client): Promise<number | null> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present"
  );
  if (present.rows[0]?.present !== true) return null;
  const result = await client.query<{ before: string | null }>(
    'SELECT max(created_at)::text AS before FROM drizzle.__drizzle_migrations'
  );
  const before = result.rows[0]?.before;
  return before === null || before === undefined ? null : Number(before);
}

/** The rows newer than `before`, matched to journal entries by `when` and by hash (§6 step 8). */
async function appliedSince(
  client: pg.Client,
  before: number | null,
  entries: readonly JournalEntry[],
  files: Record<string, string>
): Promise<AppliedMigration[]> {
  const result = await client
    .query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations
       WHERE $1::bigint IS NULL OR created_at > $1::bigint ORDER BY created_at`,
      [before === null ? null : String(before)]
    )
    .catch(() => ({ rows: [] }));
  const applied: AppliedMigration[] = [];
  for (const row of result.rows) {
    const createdAt = Number(row.created_at);
    const entry = entries.find(candidate => candidate.when === createdAt);
    const text = entry === undefined ? undefined : files[`${entry.tag}.sql`];
    if (entry === undefined || text === undefined) continue;
    if (createHash('sha256').update(text).digest('hex') !== row.hash) continue;
    applied.push({ tag: entry.tag, hash: row.hash, createdAt });
  }
  return applied;
}
