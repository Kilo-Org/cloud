import pg from 'pg';
import { SCRAM_VERIFIER_PATTERN, scramVerifier } from './scram';

/** The primary's direct endpoint, read from the primary Hyperdrive config's origin. */
export type DirectTarget = { host: string; port: number; database: string };

export type AlterResult =
  /** The pending password is now the login's password. */
  | { status: 'altered' }
  /** The pending password already logs in: an earlier run's `ALTER` succeeded before it crashed. */
  | { status: 'already_applied' }
  /** Neither the pending nor the current password logs in: the login is lost to the job. */
  | { status: 'auth_failed' }
  /** No connection, a timeout, or a server that refused for another reason: try again later. */
  | { status: 'unreachable'; detail: string }
  /** The server refused the `ALTER` itself (a privilege or a setting): a configuration error. */
  | { status: 'refused'; detail: string };

const CONNECT_TIMEOUT_MS = 10_000;

/** `invalid_password` and `invalid_authorization_specification` (a login that may not connect). */
const AUTH_SQLSTATE = /^(28P01|28000)$/;

function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
}

type Session = { status: 'open'; client: pg.Client } | { status: 'auth_failed' };

/**
 * The `pg` client settings of one direct session. A loopback host (development only; the origin
 * pins admit no other) connects in plaintext; every other host requires TLS with certificate
 * verification, and no setting here turns that off.
 */
export function directClientConfig(target: DirectTarget, login: string): pg.ClientConfig {
  const loopback = target.host === '127.0.0.1' || target.host === 'localhost';
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: login,
    ssl: loopback ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'uts-login-rotation',
  };
}

/** A server that asked for the password in clear text or as MD5 instead of SCRAM-SHA-256. */
class NotScramError extends Error {
  override readonly name = 'NotScramError';
}

/**
 * One direct session as `login`. The password goes only into a SCRAM-SHA-256 exchange: `pg` reads
 * it through the function below, which refuses once the server has asked for a cleartext or MD5
 * password, so neither form ever leaves the Worker.
 */
async function openSession(
  target: DirectTarget,
  login: string,
  password: string
): Promise<Session> {
  let notScram = false;
  const client = new pg.Client({
    ...directClientConfig(target, login),
    password: async () => {
      if (notScram) throw new NotScramError('server did not ask for SCRAM-SHA-256');
      return password;
    },
  });
  // These listeners run before the client's own, which then asks the function above.
  const refuse = () => {
    notScram = true;
  };
  client.connection.once('authenticationCleartextPassword', refuse);
  client.connection.once('authenticationMD5Password', refuse);
  try {
    await client.connect();
    return { status: 'open', client };
  } catch (error) {
    await client.end().catch(() => undefined);
    if (notScram)
      throw new DirectConnectionError('server did not ask for SCRAM-SHA-256', 'refused');
    const state = sqlState(error);
    if (state !== null && AUTH_SQLSTATE.test(state)) return { status: 'auth_failed' };
    throw new DirectConnectionError(
      state === null ? 'connection failed' : `SQLSTATE ${state}`,
      'unreachable'
    );
  }
}

class DirectConnectionError extends Error {
  override readonly name = 'DirectConnectionError';

  constructor(
    message: string,
    readonly status: 'unreachable' | 'refused'
  ) {
    super(message);
  }
}

/**
 * Sets `pending` as `login`'s password over a direct socket (`cloudflare:sockets`), never through
 * Hyperdrive (design 5.2). It first tries the pending password, so a run after a crash that
 * followed a successful `ALTER` changes nothing, then the current one, and runs
 * `ALTER ROLE CURRENT_USER PASSWORD` with a SCRAM verifier of the pending password. A login may
 * always change its own password, so no role-altering credential exists.
 */
export async function alterLoginPassword(
  target: DirectTarget,
  login: string,
  current: string,
  pending: string
): Promise<AlterResult> {
  try {
    const withPending = await openSession(target, login, pending);
    if (withPending.status === 'open') {
      await withPending.client.end().catch(() => undefined);
      return { status: 'already_applied' };
    }
    const withCurrent = await openSession(target, login, current);
    if (withCurrent.status === 'auth_failed') return { status: 'auth_failed' };
    const verifier = await scramVerifier(pending);
    // ALTER ROLE takes no bind parameters; the pattern admits only base64 and separators.
    if (!SCRAM_VERIFIER_PATTERN.test(verifier)) {
      await withCurrent.client.end().catch(() => undefined);
      return { status: 'refused', detail: 'verifier did not match its pattern' };
    }
    try {
      // The reader logins default to read-only transactions (0000_roles.sql), which refuse
      // ALTER ROLE; an explicit READ WRITE transaction overrides that default for this one
      // statement only.
      await withCurrent.client.query(
        `BEGIN READ WRITE; ALTER ROLE CURRENT_USER PASSWORD '${verifier}'; COMMIT`
      );
      return { status: 'altered' };
    } catch (error) {
      const state = sqlState(error);
      // Class 08 and 57 are connection and operator failures; anything else refused the statement.
      if (state === null || /^(08|57)/.test(state)) {
        return {
          status: 'unreachable',
          detail: state === null ? 'alter failed' : `SQLSTATE ${state}`,
        };
      }
      return { status: 'refused', detail: `SQLSTATE ${state}` };
    } finally {
      await withCurrent.client.end().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof DirectConnectionError) {
      return { status: error.status, detail: error.message };
    }
    throw error;
  }
}
