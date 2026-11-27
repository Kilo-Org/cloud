import 'server-only';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  installInternalApiSecretRead,
  type InternalApiSecretRead,
} from '@kilocode/web-shared/lib/internal-api-secret';
import {
  markStsTransportLoadFailure,
  reportStsSecretReadFailure,
  stsSecretReadFailureReason,
} from '@kilocode/web-shared/lib/sts-secret-read-failure';
import type { StsSecretReader } from '@kilocode/web-shared/lib/sts-secret-transport';

/**
 * `SECRETS_SOURCE` selects where a Vercel deployment of the web app or the AI gateway reads
 * `INTERNAL_API_SECRET` (design 4.4): `env`, the default, reads its environment variable; `sts`
 * reads the STS bundle of the workload its Vercel identity maps to (`web` or `ai-gateway`) and
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
 * Whether this process reads the internal API secret from STS: only an app process whose read
 * `instrumentation.ts` installed. A script or test that installed nothing keeps its environment.
 */
export function internalApiSecretFromSts(): boolean {
  return (
    globalThis.__kilocodeInternalApiSecretRead !== undefined &&
    internalApiSecretSource(process.env.SECRETS_SOURCE) === 'sts'
  );
}

/**
 * Longest wait for the transport module to load on the first STS read. This guards the module
 * load only; the secrets client's own first-load wait (design 4.4) applies to the bundle request.
 */
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
      markStsTransportLoadFailure(error);
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

/**
 * The complete read: the selected source on every call, failures included. Only a read that is
 * not on `env` can report: a failed selector or STS read emits the bounded failure signal
 * (`sts-secret-read-failure.ts`) and rethrows the same error, so each caller keeps its answer.
 */
export function createSelectedInternalApiSecretRead(options: {
  source: () => string | undefined;
  env: () => string;
  readSts: StsSecretReader;
}): InternalApiSecretRead {
  return async () => {
    let source: InternalApiSecretSource;
    try {
      source = internalApiSecretSource(options.source());
    } catch (error) {
      reportStsSecretReadFailure('config');
      throw error;
    }
    if (source === 'env') return options.env();
    try {
      return await options.readSts('INTERNAL_API_SECRET');
    } catch (error) {
      reportStsSecretReadFailure(stsSecretReadFailureReason(error));
      throw error;
    }
  };
}

/**
 * Installs the selected read for `readInternalApiSecret`; called once from the `instrumentation.ts`
 * of `apps/web` and `apps/ai-gateway`, which Next.js awaits before any route handler. Installing
 * builds and loads nothing.
 */
export function installSelectedInternalApiSecretRead(): void {
  installInternalApiSecretRead(
    createSelectedInternalApiSecretRead({
      source: () => process.env.SECRETS_SOURCE,
      env: () => INTERNAL_API_SECRET,
      readSts: lazyStsSecretReader(async () => {
        // Loaded on the first STS read only, so a deployment on `env` never loads the transport.
        const { createVercelStsSecretReader } =
          await import('@kilocode/web-shared/lib/sts-secret-transport');
        return createVercelStsSecretReader();
      }, STS_TRANSPORT_LOAD_TIMEOUT_MS),
    })
  );
}
