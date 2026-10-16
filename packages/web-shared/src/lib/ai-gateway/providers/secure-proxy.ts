import {
  SECURE_PROXY_BODY_KEY,
  type SecureProxyForward,
} from '@kilocode/ai-gateway-secure-proxy-contracts';

export function buildSecureProxyRequest({
  proxyUrl,
  secret,
  upstreamUrl,
  upstreamHeaders,
  body,
}: {
  proxyUrl: string;
  secret: string;
  upstreamUrl: string;
  upstreamHeaders: Headers;
  body: object;
}) {
  return {
    url: proxyUrl,
    headers: new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
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
