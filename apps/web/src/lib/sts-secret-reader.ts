import 'server-only';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  installInternalApiSecretRead,
  type InternalApiSecretRead,
} from '@kilocode/web-shared/lib/internal-api-secret';
import type { StsSecretReader } from '@/lib/sts-secret-transport';

/**
 * `SECRETS_SOURCE` selects where this web deployment reads `INTERNAL_API_SECRET` (design 4.4):
 * `env`, the default, reads its environment variable; `sts` reads the web workload's STS bundle and
 * never falls back to the environment. Any other value refuses every read.
 *
 * This module stays light: it imports no STS, OIDC or Runtime Cache code. The transport
 * (`sts-secret-transport.ts`) is loaded on the first read under `sts` only.
 */
export type InternalApiSecretSource = 'env' | 'sts';

export function internalApiSecretSource(value: string | undefined): InternalApiSecretSource {
  const source = value ?? 'env';
  if (source === 'env' || source === 'sts') return source;
  throw new Error('SECRETS_SOURCE must be either "env" or "sts"');
}

/**
 * Whether this process reads the internal API secret from STS: only a web process whose read
 * `instrumentation.ts` installed. A script or test that installed nothing keeps its environment.
 */
export function internalApiSecretFromSts(): boolean {
  return (
    globalThis.__kilocodeInternalApiSecretRead !== undefined &&
    internalApiSecretSource(process.env.SECRETS_SOURCE) === 'sts'
  );
}

/** Longest wait for the transport module to load on the first STS read. */
export const STS_TRANSPORT_LOAD_TIMEOUT_MS = 10_000;

/**
 * An STS reader whose transport loads on the first read. Concurrent first reads share one load; a
 * load that fails or takes longer than `timeoutMs` fails those reads and is forgotten, so the next
 * read starts a new one. Nothing falls back to the environment.
 */
export function lazyStsSecretReader(
  load: () => Promise<StsSecretReader>,
  timeoutMs: number
): StsSecretReader {
  let loading: Promise<StsSecretReader> | null = null;
  return async name => {
    loading ??= withinTimeout(load(), timeoutMs).catch((error: unknown) => {
      loading = null;
      throw error;
    });
    const read = await loading;
    return read(name);
  };
}

async function withinTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const late = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => late.reject(new Error('The STS secret transport did not load in time')),
    timeoutMs
  );
  try {
    return await Promise.race([promise, late.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** The web app's complete read: the selected source on every call, failures included. */
export function createWebInternalApiSecretRead(options: {
  source: () => string | undefined;
  env: () => string;
  readSts: StsSecretReader;
}): InternalApiSecretRead {
  return async () =>
    internalApiSecretSource(options.source()) === 'sts'
      ? options.readSts('INTERNAL_API_SECRET')
      : options.env();
}

/**
 * Installs the web app's read for `readInternalApiSecret` in `@kilocode/web-shared`; called once
 * from `instrumentation.ts`, which Next.js awaits before any route handler. Installing builds and
 * loads nothing.
 */
export function installWebInternalApiSecretRead(): void {
  installInternalApiSecretRead(
    createWebInternalApiSecretRead({
      source: () => process.env.SECRETS_SOURCE,
      env: () => INTERNAL_API_SECRET,
      readSts: lazyStsSecretReader(async () => {
        // Loaded on the first STS read only, so a deployment on `env` never loads the transport.
        const { createWebStsSecretReader } = await import('@/lib/sts-secret-transport');
        return createWebStsSecretReader();
      }, STS_TRANSPORT_LOAD_TIMEOUT_MS),
    })
  );
}
