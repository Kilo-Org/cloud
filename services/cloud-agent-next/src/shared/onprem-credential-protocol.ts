import { z } from 'zod';
import {
  decodeOnPremProviderRef,
  onPremProviderBindingSchema,
  onPremReportSchema,
} from './onprem-protocol.js';

export const ON_PREM_KILO_ROUTE_PREFIXES = {
  backendBaseUrl: '/_kilo/backend',
  providerBaseUrl: '/_kilo/provider',
  sessionIngestBaseUrl: '/_kilo/ingest',
} as const;

export const ON_PREM_CREDENTIAL_MAX_BODY_BYTES = 16 * 1024;

export function parseCanonicalOnPremUrl(value: string): URL | null {
  if (
    value.length > 8192 ||
    value.includes('\\') ||
    [...value].some(
      character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f
    )
  ) {
    return null;
  }
  const parts = /^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i.exec(value);
  if (!parts || parts[1].includes('@')) return null;
  const pathname = parts[2] ?? '/';
  if (
    pathname.includes('%') ||
    pathname.includes('//') ||
    pathname.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.username || url.password || url.hash || url.pathname !== pathname ? null : url;
  } catch {
    return null;
  }
}

const providerRefSchema = z
  .string()
  .max(128)
  .refine(value => decodeOnPremProviderRef(value) !== null);
const podUidSchema = onPremReportSchema.shape.pod.unwrap().shape.uid;

export const onPremCredentialRequestSchema = z
  .object({
    url: z
      .string()
      .max(8192)
      .refine(value => parseCanonicalOnPremUrl(value) !== null),
    method: z.enum(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']),
    authorization: z
      .string()
      .min(1)
      .max(1024)
      .refine(value =>
        [...value].every(character => {
          const code = character.charCodeAt(0);
          return code >= 0x20 && code < 0x7f;
        })
      )
      .optional(),
  })
  .strict();

export const onPremCredentialResolveRequestSchema = onPremCredentialRequestSchema.extend({
  providerRef: providerRefSchema,
  podUid: podUidSchema,
});

export const onPremCredentialRpcInputSchema = onPremCredentialResolveRequestSchema
  .extend({ binding: onPremProviderBindingSchema })
  .refine(
    input =>
      decodeOnPremProviderRef(input.providerRef)?.installationId === input.binding.installationId
  );

export const onPremCredentialResolutionSchema = z
  .object({
    headers: z.record(
      z
        .string()
        .refine(name => ['authorization', 'host', 'x-kilocode-organizationid'].includes(name)),
      z
        .string()
        .max(128 * 1024)
        .refine(value =>
          [...value].every(
            character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f
          )
        )
    ),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type OnPremCredentialRequest = z.infer<typeof onPremCredentialRequestSchema>;
export type OnPremCredentialResolveRequest = z.infer<typeof onPremCredentialResolveRequestSchema>;
export type OnPremCredentialRpcInput = z.infer<typeof onPremCredentialRpcInputSchema>;
export type OnPremCredentialResolution = z.infer<typeof onPremCredentialResolutionSchema>;
