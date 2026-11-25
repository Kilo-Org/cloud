import { readFileSync } from 'node:fs';
import type pg from 'pg';

/**
 * Connection rules for the operator scripts (migrations, the platform access check), which log in
 * as the identity store's admin login, the most privileged credential it has.
 *
 * * A loopback host (the local container) may use plaintext.
 * * Any other host needs `sslmode=verify-full` and `sslrootcert=<CA file>` (the Supabase CA), so
 *   the login and every statement after it travel over TLS to a verified server. Without them,
 *   `pg` would connect in plaintext.
 * * The URL may carry no other query parameter, so nothing in it can weaken those settings.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const ALLOWED_PARAMETERS = new Set(['sslmode', 'sslrootcert']);

export class ConnectionPolicyError extends Error {
  override name = 'ConnectionPolicyError';
}

/** `true` for 127.0.0.1, localhost and ::1. */
export function isLoopbackHost(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Builds the `pg` settings for `connectionUrl`, or throws `ConnectionPolicyError`. `readCa` reads
 * the CA file that `sslrootcert` names.
 */
export function operatorClientConfig(
  connectionUrl: string,
  readCa: (path: string) => string = path => readFileSync(path, 'utf8')
): pg.ClientConfig {
  const url = new URL(connectionUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConnectionPolicyError('the database URL must use postgres://');
  }
  for (const name of url.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(name)) {
      throw new ConnectionPolicyError(`the database URL parameter ${name} is not allowed`);
    }
  }

  const base = {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? 5432 : Number(url.port),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  const sslMode = url.searchParams.get('sslmode');
  const caPath = url.searchParams.get('sslrootcert');

  if (sslMode === 'verify-full') {
    if (caPath === null) {
      throw new ConnectionPolicyError('sslmode=verify-full needs sslrootcert=<CA file>');
    }
    // `pg` checks the server name against the certificate for a host name.
    return { ...base, ssl: { ca: readCa(caPath), rejectUnauthorized: true } };
  }
  if (sslMode !== null && sslMode !== 'disable') {
    throw new ConnectionPolicyError(`sslmode=${sslMode} is not allowed; use verify-full`);
  }
  if (caPath !== null) {
    throw new ConnectionPolicyError('sslrootcert needs sslmode=verify-full');
  }
  if (!isLoopbackHost(url)) {
    throw new ConnectionPolicyError(
      `${url.hostname} is not a loopback host; add sslmode=verify-full and sslrootcert=<CA file>`
    );
  }
  return { ...base, ssl: false };
}
