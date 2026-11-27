import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_USAGE_RECORD } from '@kilocode/sts-contracts';
import { logSafely } from './diagnostics';
import { writerTokensFor, type StsEnv } from './sts';

/**
 * `USAGE_WRITER_AUTH`, this sender's switch and its rollback. Each write carries exactly one
 * credential:
 * - absent or `legacy`: `USAGE_WRITER_SECRET`, exactly as before this switch existed;
 * - `sts`: an `STS_USAGE_RECORD` service token minted over the `STS` binding, never the secret.
 *   Without a token the write is not sent and the delivery retries.
 * Any other value sends nothing and retries.
 */
export type WriterAuthMode = 'legacy' | 'sts';

export type WriterAuthEnv = StsEnv & { USAGE_WRITER_AUTH?: string; USAGE_WRITER_SECRET?: string };

export function writerAuthMode(value: string | undefined): WriterAuthMode | null {
  if (value === undefined || value === 'legacy') return 'legacy';
  return value === 'sts' ? 'sts' : null;
}

/** The credential of one write, or why there is none. */
export type WriterCredential =
  | { secret: string | undefined }
  | { serviceToken: string }
  | { unavailable: 'writer_auth_misconfigured' | 'writer_token_unavailable' };

/**
 * One per queue batch: resolves each write's credential. A warm token read adds no I/O; a read
 * with no token held waits for one binding attempt. Why no token was had is logged once per batch;
 * each delivery's `usage_ingest_processing` line carries the refusal reason.
 */
export function createWriterCredentials(
  env: WriterAuthEnv,
  ctx: ExecutionContext | undefined
): () => Promise<WriterCredential> {
  const mode = writerAuthMode(env.USAGE_WRITER_AUTH);
  let logged = false;
  const logOnce = (fields: object) => {
    if (logged) return;
    logged = true;
    logSafely('warn', () => ({ event: 'usage_ingest_writer_credential_unavailable', ...fields }));
  };
  return async () => {
    if (mode === 'legacy') return { secret: env.USAGE_WRITER_SECRET };
    if (mode === null) {
      logOnce({ reason: 'writer_auth_misconfigured' });
      return { unavailable: 'writer_auth_misconfigured' };
    }
    if (env.STS === undefined) {
      logOnce({ reason: 'sts_binding_missing' });
      return { unavailable: 'writer_token_unavailable' };
    }
    try {
      return { serviceToken: await writerTokensFor(env.STS).get(STS_USAGE_RECORD, ctx) };
    } catch (error) {
      logOnce(
        error instanceof ServiceTokenError
          ? {
              reason: error.reason,
              ...(error.deniedReason === undefined ? {} : { denied_reason: error.deniedReason }),
            }
          : { reason: 'unexpected_error' }
      );
      return { unavailable: 'writer_token_unavailable' };
    }
  };
}
