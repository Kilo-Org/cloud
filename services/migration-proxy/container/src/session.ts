import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * One Postgres session of the proxy (contract §2): a single `pg.Client`, never a pool, with
 * `verify-full` TLS against the bundled Supabase Root 2021 CA. Nothing here logs or returns the
 * target, the user or the password.
 */

export type LoginMode = 'member' | 'direct';
export type SessionKey = 'label' | 'pid';

export type Target = { host: string; port: number; database: string };

export type Login = {
  target: Target;
  /** The login as configured, `kilo_migration_proxy` or `kilo_migration_proxy.<ref>` through a pooler. */
  user: string;
  password: string;
  loginMode: LoginMode;
  sessionKey: SessionKey;
};

/** A session the proxy opened, as `pg_stat_activity` names it. */
export type SessionPair = { pid: number; backendStart: string };

export type ProbeReason =
  | 'connect_timeout'
  | 'tls_verify_failed'
  | 'not_primary'
  | 'auth_failed'
  | 'wrong_role';

/** A failure before or during the probe; the reason is all that leaves the container. */
export class ProbeError extends Error {
  readonly reason: ProbeReason;
  readonly sqlstate: string | null;
  constructor(reason: ProbeReason, sqlstate: string | null = null) {
    super(`probe failed: ${reason}`);
    this.name = 'ProbeError';
    this.reason = reason;
    this.sqlstate = sqlstate;
  }
}

/** A path string, not a URL object: the Worker's and Node's URL types differ in shared typechecks. */
export const CA_BUNDLE_PATH = decodeURIComponent(
  new URL('../ca-bundle.pem', import.meta.url).pathname
);

/**
 * A probe statement: node-postgres honours a per-query `query_timeout` (30 s, §6 step 2), which
 * its type declarations leave out of `QueryConfig`.
 */
function probeQuery(text: string): pg.QueryConfig {
  const query: pg.QueryConfig & { query_timeout: number } = { text, query_timeout: 30_000 };
  return query;
}

export const SESSION_LABEL_PREFIX = 'kilo-migration-proxy:';

/** The login role without a pooler's `.<project ref>` suffix: what `pg_stat_activity.usename` shows. */
export function baseUser(user: string): string {
  return user.replace(/\.[a-z]{20}$/, '');
}

/** The role the probe and the cleanup require each session to log in as. */
const MEMBER_LOGIN = 'kilo_migration_proxy';
const OWNER_ROLE = 'postgres';

const TLS_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

/** Maps a failed connect to a probe reason without reading its message out of the container. */
export function connectFailure(error: unknown): ProbeError {
  const code = errorCode(error);
  if (code === '28P01' || code === '28000') return new ProbeError('auth_failed', code);
  // too_many_connections: the login's limit of 2 is taken, often by a leftover; a retry can pass.
  if (code === '53300') return new ProbeError('connect_timeout', code);
  if (code === '57P03') return new ProbeError('not_primary', code);
  if (code !== null && TLS_ERROR_CODES.has(code)) return new ProbeError('tls_verify_failed');
  // node-postgres reports a server without TLS, or one that refuses it, by message only.
  if (error instanceof Error && /does not support SSL|SSL connection/i.test(error.message)) {
    return new ProbeError('tls_verify_failed');
  }
  if (code !== null && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08')) {
    // Any other server refusal at login (a missing role or database, a connection limit) is a
    // setup fault, not a network one.
    return new ProbeError('auth_failed', code);
  }
  return new ProbeError('connect_timeout', code !== null && /^08/.test(code) ? code : null);
}

/**
 * Opens the session: TLS with the bundled CA and the host name checked, a 10 s connect timeout,
 * TCP keepalive for hours-long index builds, and the session label.
 */
export async function connect(login: Login, applicationName: string): Promise<pg.Client> {
  const client = new pg.Client({
    host: login.target.host,
    port: login.target.port,
    database: login.target.database,
    user: login.user,
    password: login.password,
    ssl: {
      ca: readFileSync(CA_BUNDLE_PATH, 'utf8'),
      rejectUnauthorized: true,
      servername: login.target.host,
    },
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    application_name: applicationName,
  });
  // A dropped connection emits 'error' on the client; the pending query rejects with it too, so
  // the listener only keeps the process alive.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw connectFailure(error);
  }
  return client;
}

/** `(pg_backend_pid(), backend_start)` of this session, with microseconds, in UTC. */
export async function ownPair(client: pg.Client): Promise<SessionPair> {
  const result = await probeStatement<{ pid: number; backend_start: string }>(
    client,
    `SELECT pid, to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start
     FROM pg_stat_activity WHERE pid = pg_backend_pid()`
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('own session missing from pg_stat_activity');
  return { pid: row.pid, backendStart: row.backend_start };
}

/**
 * A probe statement's failure: node-postgres's read timeout (no answer within 30 s) is the server
 * not answering, `connect_timeout` (retryable), never a migration failure.
 */
export function probeStatementFailure(error: unknown): unknown {
  return error instanceof Error && /Query read timeout/i.test(error.message)
    ? new ProbeError('connect_timeout')
    : error;
}

async function probeStatement<Row extends pg.QueryResultRow>(
  client: pg.Client,
  text: string
): Promise<pg.QueryResult<Row>> {
  try {
    return await client.query<Row>(probeQuery(text));
  } catch (error) {
    throw probeStatementFailure(error);
  }
}

/**
 * §6 step 2: the first statements of the connection. Member mode requires the dedicated login
 * acting as `postgres`; direct mode requires `postgres` itself; neither may be a standby.
 */
export async function probe(client: pg.Client, loginMode: LoginMode): Promise<void> {
  const result = await probeStatement<{
    current_user: string;
    session_user: string;
    in_recovery: boolean;
  }>(client, 'SELECT current_user, session_user, pg_is_in_recovery() AS in_recovery');
  const row = result.rows[0];
  if (row === undefined) throw new ProbeError('wrong_role');
  const roleOk =
    loginMode === 'member'
      ? row.session_user === MEMBER_LOGIN && row.current_user === OWNER_ROLE
      : row.session_user === OWNER_ROLE && row.current_user === OWNER_ROLE;
  if (!roleOk) throw new ProbeError('wrong_role');
  if (row.in_recovery) throw new ProbeError('not_primary');
}

async function currentUser(client: pg.Client): Promise<string> {
  const result = await client.query<{ current_user: string }>('SELECT current_user');
  return result.rows[0]?.current_user ?? '';
}

/**
 * Makes the session act as the login itself, so it may signal its own role's backends and read
 * their rows in `pg_stat_activity` in full. Member mode: `SET ROLE NONE`, never `RESET ROLE`,
 * which would return to the role setting `postgres`. Direct mode: `postgres` already is the login.
 */
export async function actAsLogin(client: pg.Client, login: Login): Promise<void> {
  if (login.loginMode === 'member') {
    await client.query('SET ROLE NONE');
    if ((await currentUser(client)) !== baseUser(login.user)) throw new ProbeError('wrong_role');
    return;
  }
  const result = await client.query<{ same: boolean }>(
    'SELECT current_user = session_user AS same'
  );
  if (result.rows[0]?.same !== true) throw new ProbeError('wrong_role');
}

/** Member mode: back to `postgres`, which owns every migration object (§6 step 3, last line). */
export async function actAsOwner(client: pg.Client, login: Login): Promise<void> {
  if (login.loginMode !== 'member') return;
  await client.query('SET ROLE postgres');
  if ((await currentUser(client)) !== OWNER_ROLE) throw new ProbeError('wrong_role');
}

/**
 * The recorded pairs as two parallel arrays, the form every query binds them in (never spliced
 * into SQL).
 */
export function pairArrays(pairs: readonly SessionPair[]): [number[], string[]] {
  return [pairs.map(pair => pair.pid), pairs.map(pair => pair.backendStart)];
}

/**
 * §3: the other sessions of the login, split into the proxy's own leftovers (label, in label
 * mode, and a recorded pair) and everything else (`unexpected`). Run as the login itself.
 */
export async function countSessions(
  client: pg.Client,
  login: Login,
  pairs: readonly SessionPair[]
): Promise<{ leftover: number; unexpected: number }> {
  const [pids, starts] = pairArrays(pairs);
  const labelCondition =
    login.sessionKey === 'label'
      ? `coalesce(a.application_name, '') LIKE '${SESSION_LABEL_PREFIX}%' AND `
      : '';
  const result = await client.query<{ leftover: string; unexpected: string }>(
    `WITH recorded AS (SELECT * FROM unnest($1::int[], $2::timestamptz[]) AS r(pid, backend_start))
     SELECT count(*) FILTER (WHERE own) AS leftover, count(*) FILTER (WHERE NOT own) AS unexpected
     FROM (
       SELECT ${labelCondition}EXISTS (SELECT 1 FROM recorded r
                                       WHERE r.pid = a.pid AND r.backend_start = a.backend_start) AS own
       FROM pg_stat_activity a
       WHERE a.usename = $3 AND a.pid <> pg_backend_pid()
     ) s`,
    [pids, starts, baseUser(login.user)]
  );
  const row = result.rows[0];
  return { leftover: Number(row?.leftover ?? 0), unexpected: Number(row?.unexpected ?? 0) };
}

/**
 * §6 step 3: ends the sessions a lost run left. Label mode ends every labelled session of the
 * login, so a stuck build never blocks the run; pid mode ends only recorded pairs. Each waits up
 * to 30 s for the backend to go. Returns how many were ended and how many did not end in time.
 */
export async function endLeftovers(
  client: pg.Client,
  login: Login,
  pairs: readonly SessionPair[]
): Promise<{ ended: number; notEnded: number }> {
  const [pids, starts] = pairArrays(pairs);
  const filter =
    login.sessionKey === 'label'
      ? `coalesce(a.application_name, '') LIKE '${SESSION_LABEL_PREFIX}%'`
      : `EXISTS (SELECT 1 FROM recorded r WHERE r.pid = a.pid AND r.backend_start = a.backend_start)`;
  const result = await client.query<{ pid: number; matched: boolean; ended: boolean }>(
    `WITH recorded AS (SELECT * FROM unnest($1::int[], $2::timestamptz[]) AS r(pid, backend_start))
     SELECT a.pid,
            EXISTS (SELECT 1 FROM recorded r
                    WHERE r.pid = a.pid AND r.backend_start = a.backend_start) AS matched,
            pg_terminate_backend(a.pid, 30000) AS ended
     FROM pg_stat_activity a
     WHERE a.usename = $3
       AND ${filter}
       AND a.pid <> pg_backend_pid()`,
    [pids, starts, baseUser(login.user)]
  );
  const ended = result.rows.filter(row => row.ended).length;
  return { ended, notEnded: result.rows.length - ended };
}

/** The SQLSTATE of a failed statement, through drizzle's query wrapper when present. */
export function sqlstateOf(error: unknown): string | null {
  const code = errorCode(error);
  if (code !== null && /^[0-9A-Z]{5}$/.test(code)) return code;
  if (error instanceof Error && error.cause !== undefined) return sqlstateOf(error.cause);
  return null;
}

/**
 * The server's own `message` field of a failed statement, never drizzle's wrapper text (which
 * holds the SQL and its parameters).
 */
export function serverMessageOf(error: unknown): string | null {
  if (error instanceof pg.DatabaseError) return error.message;
  if (error instanceof Error && error.cause !== undefined) return serverMessageOf(error.cause);
  return null;
}
