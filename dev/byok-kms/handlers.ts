import { createCipheriv, timingSafeEqual } from 'node:crypto';
import { compactDecrypt } from 'jose';
import { z } from 'zod';

import type { KmsApi } from './kms';

const contextSchema = z.object({
  owner_type: z.enum(['user', 'organization']),
  owner_id: z.string().min(1),
  provider_id: z.string().min(1),
});

const encryptRequestSchema = z.object({ jwe: z.string().min(1) });

const decryptRequestSchema = z.object({
  wrapped_dek: z.string().min(1),
  kms_key_id: z.string().min(1),
  kms_key_version: z.string().min(1),
  context: contextSchema,
});

const protectedHeaderSchema = contextSchema.extend({ v: z.literal(1) });

export type HandlerDeps = {
  kms: KmsApi;
  kmsKeyId: string;
  serviceToken: string;
  transportKey: Uint8Array;
};

export type HandlerResult = { status: number; body: unknown };

const fail = (status: number, error: string): HandlerResult => ({ status, body: { error } });

function isAuthorized(authorization: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authorization ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function encrypt(deps: HandlerDeps, body: unknown): Promise<HandlerResult> {
  const parsed = encryptRequestSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid request');

  let plaintext: Uint8Array;
  let header: unknown;
  try {
    const result = await compactDecrypt(parsed.data.jwe, deps.transportKey, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    plaintext = result.plaintext;
    header = result.protectedHeader;
  } catch {
    return fail(400, 'invalid jwe');
  }

  const context = protectedHeaderSchema.safeParse(header);
  if (!context.success) return fail(400, 'invalid jwe header');
  const { v: _version, ...kmsContext } = context.data;

  const dataKey = await deps.kms.generateDataKey({ keyId: deps.kmsKeyId, context: kmsContext });
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      status: 200,
      body: {
        encrypted_data: {
          iv: Buffer.from(iv).toString('base64'),
          data: data.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
        },
        wrapped_dek: dataKey.ciphertextBlob,
        kms_key_id: dataKey.keyId,
        kms_key_version: '1',
        algorithm: 'aes-256-gcm',
        envelope_version: 1,
      },
    };
  } finally {
    dataKey.plaintext.fill(0);
  }
}

async function decrypt(deps: HandlerDeps, body: unknown): Promise<HandlerResult> {
  const parsed = decryptRequestSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid request');

  const dek = await deps.kms.decrypt({
    ciphertextBlob: parsed.data.wrapped_dek,
    keyId: parsed.data.kms_key_id,
    context: parsed.data.context,
  });
  try {
    return { status: 200, body: { dek: dek.toString('base64') } };
  } finally {
    dek.fill(0);
  }
}

export async function handleRequest(
  deps: HandlerDeps,
  request: { method: string; path: string; authorization: string | undefined; body: unknown }
): Promise<HandlerResult> {
  if (request.method !== 'POST') return fail(405, 'method not allowed');
  if (request.path !== '/encrypt' && request.path !== '/decrypt') return fail(404, 'not found');
  if (!isAuthorized(request.authorization, deps.serviceToken)) return fail(401, 'unauthorized');
  try {
    return request.path === '/encrypt'
      ? await encrypt(deps, request.body)
      : await decrypt(deps, request.body);
  } catch {
    return fail(502, 'kms request failed');
  }
}
