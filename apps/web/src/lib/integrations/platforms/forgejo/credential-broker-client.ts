import 'server-only';

import { z } from 'zod';
import { FORGEJO_CREDENTIAL_BROKER_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { GIT_TOKEN_SERVICE_API_URL } from '@kilocode/web-shared/lib/config.server';
import { generateBoundedInternalServiceToken, TOKEN_EXPIRY } from '@kilocode/web-shared/lib/tokens';

const FORGEJO_CREDENTIAL_RESPONSE_MAX_BYTES = 16_384;
const FORGEJO_CREDENTIAL_REQUEST_TIMEOUT_MS = 30_000;

export const ForgejoCredentialSelectorSchema = z.discriminatedUnion('credential', [
  z
    .object({
      credential: z.literal('integration'),
      integrationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      credential: z.literal('project-exact'),
      integrationId: z.uuid(),
      projectId: z.string().min(1),
    })
    .strict(),
]);

export const ForgejoCredentialBrokerResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      token: z.string().min(1).max(10_000),
      instanceUrl: z.string().max(2048),
    })
    .strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
]);

export type ForgejoOAuthCredentialActor = {
  userId: string;
  organizationId?: string;
};
export type ForgejoCredentialSelector = z.infer<typeof ForgejoCredentialSelectorSchema>;
export type ForgejoCredentialBrokerResult = z.infer<typeof ForgejoCredentialBrokerResultSchema>;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('invalid_response');
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) ||
      Number(contentLength) > FORGEJO_CREDENTIAL_RESPONSE_MAX_BYTES)
  ) {
    throw new Error('invalid_response');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid_response');
      totalBytes += chunk.value.byteLength;
      if (totalBytes > FORGEJO_CREDENTIAL_RESPONSE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response remains rejected when cancellation itself fails.
        }
        throw new Error('invalid_response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return json;
}

export async function fetchForgejoCredential(
  actor: ForgejoOAuthCredentialActor,
  selector: ForgejoCredentialSelector
): Promise<ForgejoCredentialBrokerResult> {
  const token = await generateBoundedInternalServiceToken(
    actor.userId,
    {
      audience: FORGEJO_CREDENTIAL_BROKER_AUDIENCE,
      expiresIn: TOKEN_EXPIRY.oneHour,
      organizationId: actor.organizationId,
    }
  );

  const apiUrl = new URL(`${GIT_TOKEN_SERVICE_API_URL}/forgejo-credential`);
  apiUrl.searchParams.set('credential', selector.credential);
  if (selector.credential === 'integration') {
    apiUrl.searchParams.set('integrationId', selector.integrationId);
  } else {
    apiUrl.searchParams.set('integrationId', selector.integrationId);
    apiUrl.searchParams.set('projectId', selector.projectId);
  }

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(FORGEJO_CREDENTIAL_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return { status: 'not_connected' as const };
    }
    if (response.status === 409) {
      return { status: 'reconnect_required' as const };
    }
    if (response.status === 503) {
      return { status: 'temporarily_unavailable' as const };
    }
    throw new Error(`Forgejo credential broker request failed: ${response.status}`);
  }

  const data = await readBoundedJson(response);
  const parsed = ForgejoCredentialBrokerResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Forgejo credential broker returned invalid response');
  }

  return parsed.data;
}
