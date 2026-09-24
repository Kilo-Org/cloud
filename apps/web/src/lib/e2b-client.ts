import 'server-only';

import type { OrganizationE2BComputeCredential } from '@kilocode/db/schema';
import { z } from 'zod';

const E2B_API_URL = 'https://api.e2b.app/v2/sandboxes?limit=1';
const OPERATION_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const ERROR_MESSAGES = {
  UNAUTHORIZED: 'The E2B API key is invalid or expired.',
  FORBIDDEN: 'The E2B API key cannot list sandboxes in this project.',
  TOO_MANY_REQUESTS: 'E2B is rate limiting requests. Try again later.',
  SERVICE_UNAVAILABLE: 'E2B is temporarily unavailable. Try again later.',
  BAD_GATEWAY: 'E2B returned an invalid response. Try again later.',
} as const;

export class E2BApiError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = 'E2BApiError';
  }
}

const SandboxesPageSchema = z
  .array(
    z.object({
      templateID: z.string().min(1),
      sandboxID: z.string().min(1),
      clientID: z.string(),
      startedAt: z.iso.datetime({ offset: true }),
      endAt: z.iso.datetime({ offset: true }),
      cpuCount: z.number().int().min(1),
      memoryMB: z.number().int().min(128),
      diskSizeMB: z.number().int().nonnegative(),
      state: z.enum(['running', 'paused']),
      envdVersion: z.string(),
    })
  )
  .max(1);

export const E2BComputeStatusSchema = z.object({
  credentialId: z.uuid(),
  organizationId: z.uuid(),
  consentVersion: z.literal('e2b-direct-v1'),
  consentedAt: z.iso.datetime(),
  validatedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export function toE2BComputeStatus(
  row: Omit<OrganizationE2BComputeCredential, 'api_key_encrypted'>
) {
  return E2BComputeStatusSchema.parse({
    credentialId: row.id,
    organizationId: row.organization_id,
    consentVersion: row.consent_version,
    consentedAt: new Date(row.consented_at).toISOString(),
    validatedAt: new Date(row.validated_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function responseError(status: number): E2BApiError {
  switch (status) {
    case 401:
      return new E2BApiError('UNAUTHORIZED');
    case 403:
      return new E2BApiError('FORBIDDEN');
    case 429:
      return new E2BApiError('TOO_MANY_REQUESTS');
    default:
      return new E2BApiError(
        status >= 500 || status === 408 ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY'
      );
  }
}

async function consumeValidationPage(response: Response, signal: AbortSignal): Promise<void> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
  ) {
    throw new E2BApiError('BAD_GATEWAY');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) throw new E2BApiError('BAD_GATEWAY');
      chunks.push(value);
    }
    signal.throwIfAborted();
    const body: unknown = JSON.parse(Buffer.concat(chunks, bytesRead).toString('utf8'));
    if (!SandboxesPageSchema.safeParse(body).success) throw new E2BApiError('BAD_GATEWAY');
  } catch {
    throw new E2BApiError(signal.aborted ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY');
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function validateE2BApiKey(apiKey: string): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(E2B_API_URL, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new E2BApiError('SERVICE_UNAVAILABLE');
    }
    if (response.redirected) throw new E2BApiError('BAD_GATEWAY');
    if (response.status !== 200) throw responseError(response.status);
    await consumeValidationPage(response, controller.signal);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}
