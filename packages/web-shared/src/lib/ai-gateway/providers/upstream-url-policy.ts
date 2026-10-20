/**
 * Turns upstream URL verdicts into gateway responses.
 *
 * The rules themselves, and the connection they bind, live in
 * `@kilocode/upstream-url-policy` so the secure-proxy relay can apply the same
 * rules without pulling this package in.
 */
import { captureMessage } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { checkUpstreamUrl, type UpstreamUrlViolation } from '@kilocode/upstream-url-policy';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { withRequestId } from '@kilocode/web-shared/lib/ai-gateway/request-id';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

type UpstreamUrlRejection = UpstreamUrlViolation | 'redirect';

const REJECTION_MESSAGES = {
  invalid_url: 'The upstream provider URL is not a valid URL.',
  non_https: 'The upstream provider URL is not allowed because it does not use HTTPS.',
  non_public_host: 'The upstream provider URL is not allowed because its host is not public.',
  non_public_address:
    'The upstream provider URL is not allowed because its host resolves to a non-public address.',
  dns_lookup_failed:
    'The gateway could not resolve the upstream provider host. This may be temporary; try again shortly.',
  redirect: 'The upstream provider responded with a redirect, which the gateway does not follow.',
} as const satisfies Record<UpstreamUrlRejection, string>;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid_url';
  }
}

function rejectionResponse({
  rejection,
  host,
  providerId,
  vercelRequestId,
}: {
  rejection: UpstreamUrlRejection;
  host: string;
  providerId: string;
  vercelRequestId: string | null | undefined;
}): NextResponse {
  const transient = rejection === 'dns_lookup_failed';
  const metadata = {
    providerId,
    targetHost: host,
    violation: rejection,
    ...(vercelRequestId && { vercelRequestId }),
  };
  errorExceptInTest('AI gateway upstream URL rejected', metadata);
  captureMessage('AI gateway upstream URL rejected', {
    level: transient ? 'warning' : 'error',
    tags: {
      source: 'ai-gateway-upstream-url-policy',
      provider: providerId,
      violation: rejection,
    },
    extra: metadata,
  });

  const error = withRequestId(REJECTION_MESSAGES[rejection], vercelRequestId);
  return NextResponse.json(
    {
      error,
      error_type: transient
        ? ProxyErrorType.temporarily_unavailable
        : ProxyErrorType.upstream_error,
      message: error,
      ...(vercelRequestId && { vercel_request_id: vercelRequestId }),
    },
    { status: transient ? 503 : 502 }
  );
}

/**
 * Returns the error response for the first URL that violates the policy, or
 * null. An allowed call also approves the addresses behind each host, which is
 * what lets the fetch connect to them (see `upstreamDispatcher`). Rejects with
 * the abort reason when `signal` aborts, exactly like the upstream fetch
 * would, so the caller's fetch-failure handling applies.
 */
export async function rejectDisallowedUpstreamUrls({
  urls,
  providerId,
  vercelRequestId,
  signal,
}: {
  urls: string[];
  providerId: string;
  vercelRequestId: string | null | undefined;
  signal: AbortSignal;
}): Promise<NextResponse | null> {
  const verdicts = await Promise.all(urls.map(url => checkUpstreamUrl(url, { signal })));
  const index = verdicts.findIndex(verdict => !verdict.allowed);
  const verdict = verdicts[index];
  if (!verdict || verdict.allowed) return null;
  return rejectionResponse({
    rejection: verdict.violation,
    host: hostOf(urls[index]),
    providerId,
    vercelRequestId,
  });
}

/**
 * Upstream fetches use `redirect: 'manual'`: the gateway answers a 3xx with an
 * error rather than following it, so a request only reaches the URL the check
 * approved.
 */
export async function rejectUpstreamRedirect({
  response,
  url,
  providerId,
  vercelRequestId,
}: {
  response: Response;
  url: string;
  providerId: string;
  vercelRequestId: string | null | undefined;
}): Promise<NextResponse | null> {
  if (response.status < 300 || response.status >= 400) return null;
  await response.body?.cancel().catch(() => undefined);
  return rejectionResponse({
    rejection: 'redirect',
    host: hostOf(url),
    providerId,
    vercelRequestId,
  });
}
