import type { ClientConfig } from 'pg';

export function computeDatabaseUrl(): string {
  const useProductionDb = process.env.USE_PRODUCTION_DB === 'true';

  const postgresUrl = useProductionDb
    ? process.env.POSTGRES_URL_PRODUCTION || ''
    : process.env.POSTGRES_URL || '';

  if (!postgresUrl) {
    throw new Error(
      useProductionDb ? 'POSTGRES_URL_PRODUCTION not configured' : 'POSTGRES_URL not configured'
    );
  }

  if (process.env.NODE_ENV !== 'test') {
    return postgresUrl;
  }

  // Isolate each Jest worker's database. Append to the path segment so query
  // parameters such as sslmode stay valid instead of becoming part of the
  // last parameter's value.
  const workerId = process.env.JEST_WORKER_ID || '1';
  const url = new URL(postgresUrl);
  url.pathname = `${url.pathname}-${workerId}`;
  return url.toString();
}

/** The port `pg` connects to when a connection string omits one. */
const DEFAULT_POSTGRES_PORT = 5432;

export type PostgresConnectionTarget = {
  /** The server, lowercase so one host compares equal however a URL spells it. */
  host: string;
  /** The port, with the default filled in when the URL omits it. */
  port: number;
  /**
   * The database the pool connects to. `pg` falls back to the user name when the URL names no
   * database, so an empty path names the user's database rather than no database.
   */
  database: string;
  /** The user the pool connects as. */
  user: string;
};

/**
 * The database a connection names, as `getDatabaseClientConfig` reports it.
 *
 * Accepts either a connection string or an already-parsed `URL`, because both describe one
 * connection and a caller holding the `URL` must pass it: parsing the string again would build a
 * second decoded representation of the same connection, and the fields could then disagree with
 * the password and sslmode the caller reads from its own `URL`.
 *
 * This is the one parse for the connection this package builds field by field: the pool
 * configuration below, and every caller that has to name the target without handling the URL.
 * `new URL()` leaves a non-special scheme such as `postgres:` unnormalized, so the host keeps its
 * case and the path keeps its escapes, while the pool receives decoded values. Query parameters
 * are not part of this target, because this parse is paired with the field-built connection and
 * never with a `connectionString`. A client that hands `pg` a `connectionString` directly, such as
 * `getWorkerDb`, is parsed by `pg` itself, which does read `?host=` and `?port=`.
 */
export function postgresConnectionTarget(connection: string | URL): PostgresConnectionTarget {
  const url = typeof connection === 'string' ? new URL(connection) : connection;
  const user = decodeURIComponent(url.username);
  return {
    host: decodeURIComponent(url.hostname).toLowerCase(),
    port: Number(url.port) || DEFAULT_POSTGRES_PORT,
    database: decodeURIComponent(url.pathname.slice(1)) || user,
    user,
  };
}

/**
 * WHATWG `URL` keeps the user, password, host and database name percent-encoded, while `pg` only
 * decodes parts it parses itself out of a `connectionString`. The config here is built by hand and
 * handed to `pg.Pool` without one, so the escapes must be decoded before they reach the server. A
 * malformed escape throws `URIError`, matching `pg-connection-string`.
 */
export function getDatabaseClientConfig(postgresUrl: string): ClientConfig {
  const databaseUrl = new URL(postgresUrl);
  // This single parse feeds the target fields, the password and the sslmode below, so the config
  // cannot disagree with itself about which connection it describes.
  const { host, port, database, user } = postgresConnectionTarget(databaseUrl);
  const clientConfig: ClientConfig = {
    user,
    password: decodeURIComponent(databaseUrl.password),
    host,
    port,
    database,
  };

  if (process.env.DATABASE_CA) {
    clientConfig.ssl = {
      ca: process.env.DATABASE_CA.replace(/\\n/g, '\n'),
      rejectUnauthorized: true,
      servername: host,
    };
  } else {
    clientConfig.ssl = resolveSslFromSslmode(databaseUrl);
  }

  return clientConfig;
}

/**
 * The connection string's sslmode decides whether TLS is used when `DATABASE_CA`
 * is unset. `require`, `prefer` and `no-verify` select the encrypted mode;
 * `verify-ca`/`verify-full` select the encrypted mode that also verifies the
 * server certificate against the Node system trust store. `allow` negotiates
 * plaintext first and upgrades to TLS, which Node's `pg` cannot retry, so it is
 * treated like `disable` rather than forcing a connection style the caller did
 * not pin down.
 */
type VerifyCertificateSslmode = 'prefer' | 'require' | 'no-verify' | 'verify-ca' | 'verify-full';

const VERIFY_CERTIFICATE_BY_SSLMODE: Record<VerifyCertificateSslmode, boolean> = {
  prefer: false,
  require: false,
  'no-verify': false,
  'verify-ca': true,
  'verify-full': true,
};

/** `Object.hasOwn` so inherited keys like `constructor` never resolve to a mode. */
function isVerifyCertificateSslmode(value: string): value is VerifyCertificateSslmode {
  return Object.hasOwn(VERIFY_CERTIFICATE_BY_SSLMODE, value);
}

function resolveSslFromSslmode(databaseUrl: URL): ClientConfig['ssl'] {
  const sslmode = databaseUrl.searchParams.get('sslmode')?.trim().toLowerCase();

  if (!sslmode || sslmode === 'disable' || sslmode === 'allow') return false;

  if (!isVerifyCertificateSslmode(sslmode)) {
    throw new Error(`Unsupported sslmode in database URL: ${sslmode}`);
  }

  return { rejectUnauthorized: VERIFY_CERTIFICATE_BY_SSLMODE[sslmode] };
}
