import type { ServiceTokenRequest } from '@kilocode/service-token-client';
import { z } from 'zod';
import type { ServiceSenderToken } from './service-sender-sts';

/**
 * The credential switch of a web sender to a Kilo service whose receiver has no staging STS
 * deployment (D59: sender STS by default, rollback is the switch back to `legacy`). Exact
 * lowercase values:
 * - `legacy`: the edge's shared credential, exactly as before the switch existed;
 * - `sts`: only an STS service token in `Authorization: Bearer`, never the shared credential and no
 *   return to it when the mint or the request fails.
 * Unset or empty is `sts` on Vercel production and `legacy` everywhere else: the staging custom
 * environment and previews keep the shared credential, since no receiver verifies staging STS
 * tokens. Explicit `sts` is refused there. A process outside Vercel (local development) may set
 * `sts` and then mints from development STS. Any other value is refused.
 *
 * This module imports no STS code, so a `legacy` deployment never loads the token client or the
 * Vercel OIDC exchange; `service-sender-sts.ts` holds them and is imported only for an STS send.
 */
const ServiceSenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).optional()
);

/** The deployment's runtime variables; `process.env` itself in production. */
export type VercelRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

export type ServiceSenderStsEnvironment = 'production' | 'development';

/**
 * The STS environment a sender mints from: Vercel production is production, and a process outside
 * Vercel (local development) is development. Every other deployment has none.
 */
function stsEnvironmentOf(runtime: VercelRuntime): ServiceSenderStsEnvironment | null {
  const { VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === undefined && target === undefined) return 'development';
  return null;
}

export type ServiceSenderRefusal = 'invalid_auth' | 'sts_production_only' | 'insecure_url';

export type ServiceSenderAuth =
  | { kind: 'legacy' }
  | { kind: 'sts'; environment: ServiceSenderStsEnvironment }
  | { kind: 'refused'; reason: ServiceSenderRefusal };

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether an STS token of `environment` may go to `url`: a production token only over HTTPS, a
 * development token only to a loopback address, so neither leaves for a plaintext or remote host
 * by a configuration slip. The token's single audience keeps any other service from accepting it.
 */
function urlCarriesToken(url: string, environment: ServiceSenderStsEnvironment): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return environment === 'production'
    ? protocol === 'https:'
    : (protocol === 'http:' || protocol === 'https:') && LOOPBACK_HOSTS.includes(hostname);
}

/** Resolves one sender's switch once, from its configured value, its receiver URL and the runtime. */
export function resolveServiceSenderAuth(config: {
  auth: string | undefined;
  url: string;
  runtime: VercelRuntime;
}): ServiceSenderAuth {
  const auth = ServiceSenderAuthSchema.safeParse(config.auth);
  if (!auth.success) return { kind: 'refused', reason: 'invalid_auth' };
  const environment = stsEnvironmentOf(config.runtime);
  const mode = auth.data ?? (environment === 'production' ? 'sts' : 'legacy');
  if (mode === 'legacy') return { kind: 'legacy' };
  if (environment === null) return { kind: 'refused', reason: 'sts_production_only' };
  if (!urlCarriesToken(config.url, environment)) return { kind: 'refused', reason: 'insecure_url' };
  return { kind: 'sts', environment };
}

/** The message an operator sees for a refused switch; names the variable, never a credential. */
export function serviceSenderRefusalMessage(variable: string, reason: ServiceSenderRefusal): string {
  switch (reason) {
    case 'invalid_auth':
      return `${variable} must be legacy or sts`;
    case 'sts_production_only':
      return `${variable}=sts is for Vercel production and local development only`;
    case 'insecure_url':
      return `${variable}=sts needs an https receiver URL (loopback in local development)`;
  }
}

/**
 * The credential headers of one request: the edge's legacy headers, or `Authorization: Bearer` with
 * a token for `request`. It throws rather than send a request without its credential: a refused
 * switch, or no token (the token client's closed reasons are logged under `label`, never a token or
 * an error message).
 */
export async function serviceSenderHeaders(config: {
  sender: ServiceSenderAuth;
  variable: string;
  label: string;
  request: ServiceTokenRequest;
  legacyHeaders: () => Promise<Record<string, string>>;
}): Promise<Record<string, string>> {
  const { sender } = config;
  switch (sender.kind) {
    case 'legacy':
      return config.legacyHeaders();
    case 'refused':
      console.error(`${config.label}: invalid sender configuration; request refused`, {
        reason: sender.reason,
      });
      throw new Error(serviceSenderRefusalMessage(config.variable, sender.reason));
    case 'sts': {
      // A dynamic import on purpose (as in o11y-client.ts): a `legacy` deployment never evaluates
      // the token client or the Vercel OIDC exchange, which a static import would load.
      const read = await import('./service-sender-sts').then(
        ({ serviceSenderToken }) => serviceSenderToken(sender.environment, config.request),
        (error: unknown): ServiceSenderToken => ({
          kind: 'failed',
          failure: { errorName: error instanceof Error ? error.name : typeof error },
        })
      );
      if (read.kind === 'failed') {
        console.error(`${config.label}: no STS token; request refused`, read.failure);
        throw new Error(`No STS service token for ${config.request.scope}; try again`);
      }
      return { Authorization: `Bearer ${read.token}` };
    }
  }
}
