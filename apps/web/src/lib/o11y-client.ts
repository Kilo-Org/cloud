import { z } from 'zod';
import {
  O11Y_ALERTING_SENDER_AUTH,
  O11Y_KILO_GATEWAY_CLIENT_SECRET,
  O11Y_SERVICE_URL,
} from '@kilocode/web-shared/lib/config.server';
import {
  O11Y_STS_ORIGINS,
  o11yStsEnvironmentOf,
  type O11yStsEnvironment,
  type VercelRuntime,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics-sender';
import type { O11yAlertingMethod, O11yAlertingToken } from './o11y-alerting-sts';

/** The client of o11y's `/alerting/*` admin routes, for the admin alerts router. */

export class O11yRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * `O11Y_ALERTING_SENDER_AUTH`, the credential switch of this client, set on `kilocode-app`:
 * - unset, empty or `legacy`: `O11Y_KILO_GATEWAY_CLIENT_SECRET` in `X-O11Y-ADMIN-TOKEN`, as before;
 * - `sts`, Vercel production only: only an STS service token in `Authorization: Bearer`, scoped to
 *   the method (`o11y-alerting-sts.ts`), only to o11y's production origin; never the secret. A
 *   process outside Vercel (local development) uses development STS and o11y's local origin.
 * Any other value, `sts` on staging or a preview (o11y has none), or an `O11Y_SERVICE_URL` that is
 * not o11y's origin under `sts` refuses every request with an error the admin page shows. o11y must
 * accept STS before this moves to `sts`; rollback is this switch back to `legacy`.
 */
const O11yAlertingSenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).default('legacy')
);

type O11yAlertingRefusal = 'invalid_auth' | 'sts_production_only' | 'origin_mismatch';

export type O11yAlertingSender =
  | { kind: 'legacy'; secret: string }
  | { kind: 'sts'; environment: O11yStsEnvironment }
  | { kind: 'refused'; reason: O11yAlertingRefusal };

export function resolveO11yAlertingSender(config: {
  auth: string | undefined;
  serviceUrl: string;
  secret: string | undefined;
  runtime: VercelRuntime;
}): O11yAlertingSender {
  const auth = O11yAlertingSenderAuthSchema.safeParse(config.auth);
  if (!auth.success) return { kind: 'refused', reason: 'invalid_auth' };
  if (auth.data === 'legacy') return { kind: 'legacy', secret: config.secret || '' };
  const environment = o11yStsEnvironmentOf(config.runtime);
  if (environment === null) return { kind: 'refused', reason: 'sts_production_only' };
  const origin = URL.canParse(config.serviceUrl) ? new URL(config.serviceUrl).origin : null;
  if (origin !== O11Y_STS_ORIGINS[environment]) {
    return { kind: 'refused', reason: 'origin_mismatch' };
  }
  return { kind: 'sts', environment };
}

const REFUSAL_MESSAGES: Readonly<Record<O11yAlertingRefusal, string>> = {
  invalid_auth: 'O11Y_ALERTING_SENDER_AUTH must be legacy or sts',
  sts_production_only: 'O11Y_ALERTING_SENDER_AUTH=sts is for Vercel production only',
  origin_mismatch: "O11Y_SERVICE_URL is not o11y's origin for STS",
};

const sender = resolveO11yAlertingSender({
  auth: O11Y_ALERTING_SENDER_AUTH,
  serviceUrl: O11Y_SERVICE_URL,
  secret: O11Y_KILO_GATEWAY_CLIENT_SECRET,
  runtime: process.env,
});

/** The credential header of one request; throws `O11yRequestError` rather than send without one. */
async function credentialHeaders(method: O11yAlertingMethod): Promise<Record<string, string>> {
  switch (sender.kind) {
    case 'legacy':
      return { 'X-O11Y-ADMIN-TOKEN': sender.secret };
    case 'refused':
      console.error('o11y alerting: invalid sender configuration; request refused', {
        reason: sender.reason,
      });
      throw new O11yRequestError(REFUSAL_MESSAGES[sender.reason], 500);
    case 'sts': {
      let read: O11yAlertingToken;
      try {
        // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client or
        // the Vercel OIDC exchange.
        const { o11yAlertingToken } = await import('./o11y-alerting-sts');
        read = await o11yAlertingToken(sender.environment, method);
      } catch (error) {
        read = {
          kind: 'failed',
          failure: { errorName: error instanceof Error ? error.name : typeof error },
        };
      }
      if (read.kind === 'failed') {
        console.error('o11y alerting: no STS token; request refused', read.failure);
        throw new O11yRequestError('No STS service token for o11y alerting; try again', 503);
      }
      return { Authorization: `Bearer ${read.token}` };
    }
  }
}

function getO11yUrl(pathname: string, searchParams?: URLSearchParams): string {
  if (!O11Y_SERVICE_URL) {
    throw new Error('O11Y_SERVICE_URL is not configured');
  }
  const url = new URL(pathname, O11Y_SERVICE_URL);
  if (searchParams) {
    url.search = searchParams.toString();
  }
  return url.toString();
}

type FetchO11yJsonParams<T> = {
  path: string;
  schema: z.ZodSchema<T>;
  method?: O11yAlertingMethod;
  body?: unknown;
  searchParams?: URLSearchParams;
  errorMessage: string;
  parseErrorMessage: string;
};

export async function fetchO11yJson<T>({
  path,
  schema,
  method = 'GET',
  body,
  searchParams,
  errorMessage,
  parseErrorMessage,
}: FetchO11yJsonParams<T>): Promise<T> {
  const url = getO11yUrl(path, searchParams);
  const response = await fetch(url, {
    method,
    headers: {
      ...(await credentialHeaders(method)),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // The credential is for this origin only; a redirect never carries it elsewhere.
    redirect: 'error',
  });

  if (!response.ok) {
    let message = errorMessage;
    try {
      const data: unknown = JSON.parse(await response.text());
      if (typeof data === 'object' && data !== null && 'error' in data) {
        message = String((data as { error?: string }).error || errorMessage);
      }
    } catch {
      // non-JSON error body (e.g. HTML 5xx) — fall through with default message
    }
    throw new O11yRequestError(message, response.status);
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new O11yRequestError(parseErrorMessage, 502);
  }

  return parsed.data;
}
