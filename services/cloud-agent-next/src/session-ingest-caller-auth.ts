import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readCloudAgentNextStoreSecret, type CloudAgentNextSecretsEnv } from './secrets.js';
import { z } from 'zod';

/**
 * `SESSION_INGEST_CALLER_AUTH`, the credential of this Worker's calls to Session Ingest over the
 * `SESSION_INGEST` service binding (the scoped session proxy and the history export), and its
 * rollback (D59):
 * - absent, empty or `legacy`: the internal API secret in `X-Internal-Secret`, exactly as before;
 * - `binding`: no credential header. The binding declares `props.caller` (this Worker's deployed
 *   name), and Session Ingest's `SessionIngestRPC` entrypoint authorizes on it (design 6.4: a
 *   Worker-to-Worker call inside the account needs no bearer token). The secret is never read.
 * Any other value fails every call. Session Ingest must accept the binding caller before this
 * moves to `binding`; rollback is this switch back to `legacy`.
 *
 * Read through `Reflect.get` like `RUNTIME_TOKEN_AUDIENCE_MODE`: the generated Env types do not
 * list it.
 */
const SessionIngestCallerAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'binding']).default('legacy')
);

export type SessionIngestCallerAuth = z.infer<typeof SessionIngestCallerAuthSchema>;

export const SESSION_INGEST_CALLER_AUTH_ENV = 'SESSION_INGEST_CALLER_AUTH';

/** The switch's mode; throws on any value but `legacy` and `binding`, so nothing is sent. */
export function sessionIngestCallerAuth(env: object): SessionIngestCallerAuth {
  const mode = SessionIngestCallerAuthSchema.safeParse(
    Reflect.get(env, SESSION_INGEST_CALLER_AUTH_ENV)
  );
  if (!mode.success) throw new Error('SESSION_INGEST_CALLER_AUTH must be legacy or binding');
  return mode.data;
}

/**
 * The credential of the history export call (`hydrateSessionHistory`): nothing under `binding`, and
 * under `legacy` the internal secret, empty when unreadable, as before the switch existed. An
 * unknown switch value throws before the secret is read, so the hydration fails and sends nothing.
 */
export async function sessionIngestExportCredential(
  env: Pick<Cloudflare.Env, 'INTERNAL_API_SECRET_PROD'> & CloudAgentNextSecretsEnv,
  ctx?: SecretsExecutionContext
): Promise<Record<string, string>> {
  if (sessionIngestCallerAuth(env) === 'binding') return {};
  const secret = await readCloudAgentNextStoreSecret(env, 'INTERNAL_API_SECRET', ctx).catch(
    () => ''
  );
  return { 'X-Internal-Secret': secret ?? '' };
}
