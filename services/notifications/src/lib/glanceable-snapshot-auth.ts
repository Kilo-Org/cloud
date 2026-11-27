import {
  createWorkerServiceTokens,
  ServiceTokenError,
  type MintBinding,
  type ServiceTokens,
} from '@kilocode/service-token-client';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { z } from 'zod';
import { readNotificationsSecret, type NotificationsSecretsEnv } from '../secrets';

/**
 * The token this Worker presents to the web app's glanceable snapshot route
 * (`apps/web/src/app/api/internal/glanceable-agents-snapshot/route.ts`). STS grants it only to the
 * `notifications` workload; until the scope is in `STS_SCOPE_REGISTRY` and the grant is in
 * `services/sts/policy/notifications.yaml`, STS refuses it and nothing is sent.
 */
export const GLANCEABLE_SNAPSHOT_READ = {
  audience: 'web',
  scope: 'web:glanceable-snapshot.read',
} as const;

/**
 * The web app's production origin. This Worker binds only production STS, so its `web` token goes
 * to this origin and nowhere else.
 */
export const WEB_PRODUCTION_ORIGIN = 'https://app.kilo.ai';

/**
 * `GLANCEABLE_SNAPSHOT_SENDER_AUTH`, the credential switch of the snapshot request and its rollback:
 * - unset, empty or `legacy`: the internal API secret in `X-Internal-Secret`, exactly as before this
 *   switch;
 * - `sts`: only a `web:glanceable-snapshot.read` STS service token in `Authorization: Bearer`,
 *   minted over the `STS` binding, and only to `WEB_PRODUCTION_ORIGIN`; never the internal secret,
 *   and no return to it when there is no token.
 * Any other value sends nothing. The web route must accept STS before a deployment sets `sts`;
 * rollback is unsetting the switch.
 */
const SenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).default('legacy')
);

export type GlanceableSnapshotAuthEnv = NotificationsSecretsEnv & {
  GLANCEABLE_SNAPSHOT_SENDER_AUTH?: string;
  STS?: MintBinding;
};

export type GlanceableSnapshotAuthFailure =
  | 'invalid_auth'
  | 'internal_secret_missing'
  | 'origin_mismatch'
  | 'sts_binding_missing'
  | 'token_unavailable'
  | 'token_denied';

/** The headers of one snapshot request, or why it is not sent. */
export type GlanceableSnapshotAuth =
  | { kind: 'headers'; headers: Record<string, string> }
  | {
      kind: 'unavailable';
      reason: GlanceableSnapshotAuthFailure;
      deniedReason?: ServiceTokenError['deniedReason'];
    };

/** One token client per binding, so the isolate shares its held token across requests. */
let tokens: { binding: MintBinding; client: ServiceTokens } | null = null;

function tokensFor(binding: MintBinding): ServiceTokens {
  if (tokens?.binding !== binding) tokens = { binding, client: createWorkerServiceTokens(binding) };
  return tokens.client;
}

function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * The credential of one snapshot request to `baseUrl`. `ctx` is the invocation (the user Durable
 * Object): a token renewal or a bundle revalidation runs under its `waitUntil`.
 */
export async function glanceableSnapshotAuth(
  env: GlanceableSnapshotAuthEnv,
  baseUrl: string,
  ctx: SecretsExecutionContext
): Promise<GlanceableSnapshotAuth> {
  const mode = SenderAuthSchema.safeParse(env.GLANCEABLE_SNAPSHOT_SENDER_AUTH);
  if (!mode.success) return { kind: 'unavailable', reason: 'invalid_auth' };

  if (mode.data === 'legacy') {
    let secret: string;
    try {
      secret = await readNotificationsSecret(env, 'INTERNAL_API_SECRET', ctx);
    } catch {
      return { kind: 'unavailable', reason: 'internal_secret_missing' };
    }
    return secret
      ? { kind: 'headers', headers: { 'x-internal-secret': secret } }
      : { kind: 'unavailable', reason: 'internal_secret_missing' };
  }

  if (originOf(baseUrl) !== WEB_PRODUCTION_ORIGIN) {
    return { kind: 'unavailable', reason: 'origin_mismatch' };
  }
  if (env.STS === undefined) return { kind: 'unavailable', reason: 'sts_binding_missing' };
  try {
    const token = await tokensFor(env.STS).get(GLANCEABLE_SNAPSHOT_READ, ctx);
    return { kind: 'headers', headers: { authorization: `Bearer ${token}` } };
  } catch (error) {
    if (error instanceof ServiceTokenError && error.reason === 'denied') {
      return { kind: 'unavailable', reason: 'token_denied', deniedReason: error.deniedReason };
    }
    return { kind: 'unavailable', reason: 'token_unavailable' };
  }
}
