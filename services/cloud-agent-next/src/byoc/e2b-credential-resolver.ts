import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { z } from 'zod';
import type { Env } from '../types.js';
import { E2BProviderError } from './e2b-errors.js';

export const E2B_DIRECT_TOKEN_CONSENT_VERSION = 'e2b-direct-v1';
const ENVELOPE_SCHEME = 'byoc-e2b-credential-rsa-aes-256-gcm';
const ENVELOPE_KEY_ID = 'agent-env-vars-v1';
const RESPONSE_LIMIT_BYTES = 32 * 1024;
/** The bounded HTTP request that retrieves the credential. Exported so the
 * reconciliation lead (`e2b-runtime.ts`) is the sum of the two budgets. */
export const E2B_CREDENTIAL_REQUEST_TIMEOUT_MS = 10_000;

const IdentitySchema = z.object({ organizationId: z.uuid(), credentialId: z.uuid() });
const StatusSchema = IdentitySchema.extend({
  consentVersion: z.literal(E2B_DIRECT_TOKEN_CONSENT_VERSION),
  consentedAt: z.iso.datetime(),
  validatedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
const EnvelopeSchema = z.object({
  scheme: z.literal(ENVELOPE_SCHEME),
  version: z.literal(1),
  keyId: z.literal(ENVELOPE_KEY_ID),
  ciphertext: z.object({
    encryptedData: z.string().min(1),
    encryptedDEK: z.string().min(1),
    algorithm: z.literal('rsa-aes-256-gcm'),
    version: z.literal(1),
  }),
});
const CredentialSchema = StatusSchema.extend({ apiKeyEncrypted: EnvelopeSchema });

export type ByocE2BIdentity = z.infer<typeof IdentitySchema>;
export type ByocE2BStatus = z.infer<typeof StatusSchema>;

async function fetchCredentialData(env: Env, path: string): Promise<unknown> {
  try {
    const backend = env.KILOCODE_BACKEND_BASE_URL?.trim().replace(/\/+$/, '');
    const secret = await env.INTERNAL_API_SECRET_PROD.get();
    if (!backend || !secret) throw new E2BProviderError('byoc_e2b_unavailable');
    const response = await fetch(`${backend}/api/internal/byoc/e2b-credentials/${path}`, {
      method: 'GET',
      headers: { 'x-internal-api-key': secret },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(E2B_CREDENTIAL_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new E2BProviderError('byoc_e2b_credential_missing');
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new E2BProviderError('byoc_e2b_unavailable');
    }
    const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new E2BProviderError('byoc_e2b_unavailable');
        bytes += value.byteLength;
        if (bytes > RESPONSE_LIMIT_BYTES) {
          await reader.cancel();
          throw new E2BProviderError('byoc_e2b_unavailable');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof E2BProviderError) throw error;
    throw new E2BProviderError('byoc_e2b_unavailable');
  }
}

function validateConsent(value: unknown): void {
  const consent = StatusSchema.pick({ consentVersion: true, consentedAt: true }).safeParse(value);
  if (!consent.success) throw new E2BProviderError('byoc_e2b_consent_missing');
}

export async function fetchByocE2BEnrollment(
  env: Env,
  organizationId: string
): Promise<ByocE2BStatus> {
  if (!z.uuid().safeParse(organizationId).success) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
  const data = await fetchCredentialData(env, `organization/${encodeURIComponent(organizationId)}`);
  validateConsent(data);
  const parsed = StatusSchema.safeParse(data);
  if (!parsed.success || parsed.data.organizationId !== organizationId) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
  return parsed.data;
}

export async function fetchByocE2BCredential(
  env: Env,
  identity: ByocE2BIdentity
): Promise<z.infer<typeof CredentialSchema>> {
  if (!IdentitySchema.safeParse(identity).success) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
  const data = await fetchCredentialData(
    env,
    `${encodeURIComponent(identity.credentialId)}?organizationId=${encodeURIComponent(identity.organizationId)}`
  );
  validateConsent(data);
  const parsed = CredentialSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.organizationId !== identity.organizationId ||
    parsed.data.credentialId !== identity.credentialId
  ) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
  return parsed.data;
}

export async function resolveByocE2BApiKey(env: Env, identity: ByocE2BIdentity): Promise<string> {
  const credential = await fetchByocE2BCredential(env, identity);
  try {
    if (!env.AGENT_ENV_VARS_PRIVATE_KEY) {
      throw new E2BProviderError('byoc_e2b_credential_invalid');
    }
    const apiKey = decryptKeyedEnvelope(
      JSON.stringify(credential.apiKeyEncrypted),
      ENVELOPE_SCHEME,
      { active: { keyId: ENVELOPE_KEY_ID, privateKeyPem: env.AGENT_ENV_VARS_PRIVATE_KEY } },
      `byoc-e2b-credential:v1:${identity.organizationId}:${identity.credentialId}`
    ).trim();
    if (!apiKey) throw new E2BProviderError('byoc_e2b_credential_invalid');
    return apiKey;
  } catch {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
}
