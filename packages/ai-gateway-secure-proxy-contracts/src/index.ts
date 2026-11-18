import * as z from 'zod';

/** Request body key the AI gateway adds and apps/ai-gateway-secure-proxy reads and removes. */
export const SECURE_PROXY_BODY_KEY = 'kilo_secure_proxy';

export const SecureProxyUpstreamUrlSchema = z.url({ protocol: /^https$/ });

/** `url` is the full upstream URL and `headers` are all upstream request headers. */
export const SecureProxyForwardSchema = z.object({
  url: SecureProxyUpstreamUrlSchema,
  headers: z.record(z.string(), z.string()),
});

export type SecureProxyForward = z.infer<typeof SecureProxyForwardSchema>;

export const SecureProxyRequestBodySchema = z.looseObject({
  [SECURE_PROXY_BODY_KEY]: SecureProxyForwardSchema,
});
