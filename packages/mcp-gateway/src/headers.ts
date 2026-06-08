import { z } from 'zod';

const allowedTransientHeaders = new Set([
  'accept',
  'content-type',
  'origin',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'mcp-method',
  'mcp-name',
]);

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const headerNamePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const blockedExactHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]);

export function isAllowedTransientHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return allowedTransientHeaders.has(normalized) || normalized.startsWith('mcp-param-');
}

export function isCredentialLikeHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    blockedExactHeaders.has(normalized) ||
    normalized.startsWith('x-auth-') ||
    normalized.startsWith('x-token-')
  );
}

const headerValueSchema = z
  .string()
  .min(1)
  .refine(value => !value.includes('\r') && !value.includes('\n'), 'Invalid header value');

const staticHeadersSchema = z.record(z.string(), headerValueSchema).superRefine((headers, ctx) => {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (!headerNamePattern.test(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid static header name',
        path: [name],
      });
    }
    if (hopByHopHeaders.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Static header cannot be hop-by-hop',
        path: [name],
      });
    }
  }
});

const auxiliaryHeadersSchema = z
  .record(z.string(), headerValueSchema)
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (!headerNamePattern.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid auxiliary header name',
          path: [name],
        });
      }
      if (hopByHopHeaders.has(normalized) || isCredentialLikeHeader(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Auxiliary header cannot be transport or credential-like',
          path: [name],
        });
      }
    }
  });

export function parseStaticHeaders(value: unknown): Record<string, string> {
  return staticHeadersSchema.parse(value);
}

export function parseAuxiliaryHeaders(value: unknown): Record<string, string> {
  return auxiliaryHeadersSchema.parse(value);
}

export function buildUpstreamHeaders(params: {
  source: Headers;
  auxiliaryHeaders?: Iterable<[string, string]>;
  staticCredentialHeaders?: Iterable<[string, string]>;
  providerAuthorization?: string;
}): Headers {
  const headers = new Headers();
  const blockedStaticNames = new Set<string>();

  if (params.staticCredentialHeaders) {
    for (const [name] of params.staticCredentialHeaders) {
      blockedStaticNames.add(name.toLowerCase());
    }
  }

  for (const [name, value] of params.source) {
    const normalized = name.toLowerCase();
    if (!isAllowedTransientHeader(normalized)) continue;
    if (hopByHopHeaders.has(normalized) || isCredentialLikeHeader(normalized)) continue;
    if (blockedStaticNames.has(normalized)) continue;
    headers.set(name, value);
  }

  if (params.auxiliaryHeaders) {
    for (const [name, value] of params.auxiliaryHeaders) {
      const normalized = name.toLowerCase();
      if (
        hopByHopHeaders.has(normalized) ||
        isCredentialLikeHeader(normalized) ||
        blockedStaticNames.has(normalized)
      )
        continue;
      headers.set(name, value);
    }
  }

  if (params.staticCredentialHeaders) {
    for (const [name, value] of params.staticCredentialHeaders) {
      headers.set(name, value);
    }
  }

  if (params.providerAuthorization) {
    headers.set('Authorization', params.providerAuthorization);
  }

  return headers;
}
