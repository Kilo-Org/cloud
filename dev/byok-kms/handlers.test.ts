import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { CompactEncrypt } from 'jose';

import { handleRequest, type HandlerDeps } from './handlers';
import type { KmsApi, KmsContext } from './kms';

const TOKEN = 'test-token';
const transportKey = randomBytes(32);
const dek = randomBytes(32);

function fakeKms(): KmsApi {
  const wrap = (context: KmsContext) => Buffer.from(JSON.stringify(context)).toString('base64');
  return {
    async generateDataKey({ context }) {
      return { plaintext: Buffer.from(dek), ciphertextBlob: wrap(context), keyId: 'arn:test' };
    },
    async decrypt({ ciphertextBlob, context }) {
      if (ciphertextBlob !== wrap(context)) throw new Error('context mismatch');
      return Buffer.from(dek);
    },
  };
}

const deps: HandlerDeps = {
  kms: fakeKms(),
  kmsKeyId: 'alias/test',
  serviceToken: TOKEN,
  transportKey,
};

const context = { owner_type: 'user', owner_id: 'u1', provider_id: 'openai' } as const;

function makeJwe(apiKey: string, header: Record<string, unknown> = { v: 1, ...context }) {
  return new CompactEncrypt(new TextEncoder().encode(apiKey))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', ...header })
    .encrypt(transportKey);
}

const call = (path: string, body: unknown, authorization: string | undefined = `Bearer ${TOKEN}`) =>
  handleRequest(deps, { method: 'POST', path, authorization, body });

test('encrypt returns an envelope that decrypts with the unwrapped DEK', async () => {
  const encrypted = await call('/encrypt', { jwe: await makeJwe('sk-secret') });
  assert.equal(encrypted.status, 200);
  const envelope = encrypted.body as {
    encrypted_data: { iv: string; data: string; authTag: string };
    wrapped_dek: string;
    kms_key_id: string;
  };

  const decrypted = await call('/decrypt', {
    wrapped_dek: envelope.wrapped_dek,
    kms_key_id: envelope.kms_key_id,
    kms_key_version: '1',
    context,
  });
  assert.equal(decrypted.status, 200);
  const key = Buffer.from((decrypted.body as { dek: string }).dek, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.encrypted_data.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.encrypted_data.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.encrypted_data.data, 'base64')),
    decipher.final(),
  ]).toString();
  assert.equal(plaintext, 'sk-secret');
});

test('decrypt fails when the context differs from encryption time', async () => {
  const encrypted = await call('/encrypt', { jwe: await makeJwe('sk-secret') });
  const envelope = encrypted.body as { wrapped_dek: string; kms_key_id: string };
  const result = await call('/decrypt', {
    wrapped_dek: envelope.wrapped_dek,
    kms_key_id: envelope.kms_key_id,
    kms_key_version: '1',
    context: { ...context, owner_id: 'u2' },
  });
  assert.equal(result.status, 502);
});

test('rejects missing or wrong bearer token', async () => {
  assert.equal((await call('/encrypt', {}, '')).status, 401);
  assert.equal((await call('/decrypt', {}, 'Bearer nope')).status, 401);
});

test('rejects a JWE under a different transport key', async () => {
  const jwe = await new CompactEncrypt(new TextEncoder().encode('x'))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', v: 1, ...context })
    .encrypt(randomBytes(32));
  assert.equal((await call('/encrypt', { jwe })).status, 400);
});

test('rejects unknown envelope version and missing header fields', async () => {
  assert.equal(
    (await call('/encrypt', { jwe: await makeJwe('x', { v: 2, ...context }) })).status,
    400
  );
  assert.equal((await call('/encrypt', { jwe: await makeJwe('x', { v: 1 }) })).status, 400);
});

test('rejects unknown routes and methods', async () => {
  assert.equal((await call('/other', {})).status, 404);
  const get = await handleRequest(deps, {
    method: 'GET',
    path: '/encrypt',
    authorization: `Bearer ${TOKEN}`,
    body: undefined,
  });
  assert.equal(get.status, 405);
});
