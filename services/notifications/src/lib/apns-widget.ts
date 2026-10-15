import { signApnsJwt, type ApnsCredentials } from './apns-live-activity';

/** WidgetKit pushes contain no product data: they only request an authenticated reload. */
export function buildWidgetApnsRequest(params: {
  token: string;
  credentials: ApnsCredentials;
  authorizationJwt: string;
}) {
  return {
    url: `https://api.push.apple.com/3/device/${params.token}`,
    headers: {
      authorization: `bearer ${params.authorizationJwt}`,
      'apns-topic': `${params.credentials.topic}.push-type.widgets`,
      'apns-push-type': 'widgets',
      'apns-priority': '5',
      'apns-expiration': '0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ aps: { 'content-changed': true } }),
  };
}

export async function sendWidgetApns(params: {
  credentials: ApnsCredentials;
  tokens: readonly string[];
  isCurrent?: () => Promise<boolean>;
  onGone: (token: string) => Promise<void>;
  fetchFn?: typeof fetch;
}): Promise<void> {
  if (params.tokens.length === 0) return;
  const authorizationJwt = await signApnsJwt(params.credentials, Math.floor(Date.now() / 1000));
  await Promise.all(
    params.tokens.map(async token => {
      if (params.isCurrent && !(await params.isCurrent())) return;
      const request = buildWidgetApnsRequest({
        token,
        credentials: params.credentials,
        authorizationJwt,
      });
      try {
        const response = await (params.fetchFn ?? fetch)(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 410) await params.onGone(token);
        if (!response.ok) console.warn('Widget APNs hint rejected', { status: response.status });
      } catch {
        // A lost hint must not prevent delivery to other surfaces; timelines remain the fallback.
        console.warn('Widget APNs hint failed');
      }
    })
  );
}
