import type {
  MintBinding,
  ServiceTokenError,
  ServiceTokenRequest,
  ServiceTokensExecutionContext,
} from '@kilocode/service-token-client';
import {
  readStsToken,
  senderAuth,
  type StsTokenUnavailableReason,
} from '@kilocode/worker-utils/sts-sender';

/**
 * The scopes this Worker presents to the web app's private routes. Audience `web`; STS grants
 * each only to the `cloud-agent-next` workload. Until a scope is in `STS_SCOPE_REGISTRY` and the
 * grant is in `services/sts/policy/cloud-agent-next.yaml`, STS refuses it and nothing is sent.
 *
 * - `GET /api/internal/byoc/connections` and the `GET` routes under
 *   `/api/internal/byoc/vercel-credentials/` read a BYOC connection or enrollment;
 * - `PATCH /api/internal/byoc/vercel-credentials/{credentialId}` projects a Vercel build status;
 * - `POST /api/internal/cloud-agent-next/hosted-workspace-pull-request/refresh` refreshes the
 *   pull request summary of a hosted workspace.
 */
export const WEB_BYOC_CREDENTIALS_READ = {
  audience: 'web',
  scope: 'web:byoc-credentials.read',
} as const;
export const WEB_BYOC_CREDENTIALS_WRITE = {
  audience: 'web',
  scope: 'web:byoc-credentials.write',
} as const;
export const WEB_HOSTED_WORKSPACE_PR_REFRESH = {
  audience: 'web',
  scope: 'web:hosted-workspace-pull-requests.refresh',
} as const;

/**
 * The web app's production origins: `app.kilo.ai` and the `api.kilo.ai` alias that
 * `KILOCODE_BACKEND_BASE_URL` names. This Worker binds only production STS, so its `web` tokens go
 * to these origins and nowhere else.
 */
export const WEB_PRODUCTION_ORIGINS: readonly string[] = [
  'https://app.kilo.ai',
  'https://api.kilo.ai',
];

export type WebInternalUnavailableReason =
  | 'invalid_auth'
  | 'internal_secret_missing'
  | 'origin_mismatch'
  | StsTokenUnavailableReason;

/** The headers of one request to a private web route, or why it is not sent. */
export type WebInternalCredential =
  | { kind: 'headers'; headers: Record<string, string> }
  | {
      kind: 'unavailable';
      reason: WebInternalUnavailableReason;
      deniedReason?: ServiceTokenError['deniedReason'];
    };

function isWebProductionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.username === '' &&
      parsed.password === '' &&
      WEB_PRODUCTION_ORIGINS.includes(parsed.origin)
    );
  } catch {
    return false;
  }
}

/**
 * The credential of one request to `url` under the edge's switch value `auth`
 * (`@kilocode/worker-utils/sts-sender`): an STS token for `token` when the URL is on a web
 * production origin, or the internal API secret that `legacySecret` resolves in
 * `x-internal-api-key`. A failed or empty legacy read is `internal_secret_missing`; nothing here
 * ever throws.
 */
export async function webInternalCredential(input: {
  auth: string | undefined;
  sts: MintBinding | undefined;
  url: string;
  token: ServiceTokenRequest;
  legacySecret: () => Promise<string | null | undefined>;
  ctx?: ServiceTokensExecutionContext;
}): Promise<WebInternalCredential> {
  const mode = senderAuth(input.auth);
  if (mode === null) return { kind: 'unavailable', reason: 'invalid_auth' };
  if (mode === 'legacy') {
    let secret: string | null | undefined;
    try {
      secret = await input.legacySecret();
    } catch {
      secret = undefined;
    }
    return secret
      ? { kind: 'headers', headers: { 'x-internal-api-key': secret } }
      : { kind: 'unavailable', reason: 'internal_secret_missing' };
  }
  if (!isWebProductionUrl(input.url)) return { kind: 'unavailable', reason: 'origin_mismatch' };
  const read = await readStsToken(input.sts, input.token, input.ctx);
  return read.kind === 'token'
    ? { kind: 'headers', headers: { authorization: `Bearer ${read.token}` } }
    : read;
}

/**
 * For a sequence of requests to `url` that needs several scopes: under `sts`, asks for every token
 * at once, so the token client sends them in one batched mint and each later request finds its
 * token held. Under any other switch value, or for a URL off the web production origins, it does
 * nothing. A failure is left to the request that needs the token, which reports it.
 */
export async function prefetchWebInternalTokens(input: {
  auth: string | undefined;
  sts: MintBinding | undefined;
  url: string;
  tokens: readonly ServiceTokenRequest[];
  ctx?: ServiceTokensExecutionContext;
}): Promise<void> {
  if (senderAuth(input.auth) !== 'sts' || input.sts === undefined) return;
  if (!isWebProductionUrl(input.url)) return;
  const { sts, ctx } = input;
  await Promise.all(input.tokens.map(token => readStsToken(sts, token, ctx)));
}
