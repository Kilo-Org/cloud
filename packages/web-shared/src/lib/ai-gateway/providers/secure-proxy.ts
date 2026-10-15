import {
  SECURE_PROXY_BODY_KEY,
  type SecureProxyForward,
} from '@kilocode/ai-gateway-secure-proxy-contracts';
import type { SecureProxyRoute } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export function buildSecureProxyRequest({
  secureProxy,
  upstreamUrl,
  upstreamHeaders,
  body,
}: {
  secureProxy: SecureProxyRoute;
  upstreamUrl: string;
  upstreamHeaders: Headers;
  body: object;
}) {
  return {
    url: secureProxy.url,
    headers: new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secureProxy.secret}`,
    }),
    body: JSON.stringify({
      ...body,
      [SECURE_PROXY_BODY_KEY]: {
        url: upstreamUrl,
        headers: Object.fromEntries(upstreamHeaders),
      } satisfies SecureProxyForward,
    }),
  };
}
