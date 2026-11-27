import { describe, expect, it } from '@jest/globals';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import {
  encryptByokWithDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import {
  TEST_BYOK_DATA_KEY,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { assertSealable, CredentialKmsError, openKmsCredential } from './kms-credential';

const kms = useFakeByokKms();

const dataKey: ByokDataKey = {
  data_key: TEST_BYOK_DATA_KEY,
  wrapped_dek: 'wrapped-dek-1',
  kms_key_id: 'alias/test',
  kms_key_version: '1',
};

const context: ByokKmsContext = {
  key_id: 'key-1',
  owner_type: 'user',
  owner_id: 'user-1',
  provider_id: 'provider-1',
};

describe('encryptByokWithDataKey and openKmsCredential', () => {
  it('round-trips a credential through the envelope, binding the decrypt to the context', async () => {
    const envelope = encryptByokWithDataKey('secret-value', dataKey);

    await expect(openKmsCredential(envelope, () => context)).resolves.toBe('secret-value');

    expect(kms.requests).toEqual([
      {
        path: '/decrypt',
        body: {
          ...context,
          wrapped_dek: 'wrapped-dek-1',
          kms_key_id: 'alias/test',
          kms_key_version: '1',
        },
      },
    ]);
  });

  it('keeps the plaintext out of the envelope and records the data key that wraps it', () => {
    const envelope = encryptByokWithDataKey('secret-value', dataKey);

    expect(JSON.stringify(envelope)).not.toContain('secret-value');
    expect(envelope).toMatchObject({
      wrapped_dek: 'wrapped-dek-1',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    });
  });

  it('gives each seal its own ciphertext', () => {
    expect(encryptByokWithDataKey('secret-value', dataKey).encrypted_data).not.toEqual(
      encryptByokWithDataKey('secret-value', dataKey).encrypted_data
    );
  });

  it('passes the envelope it opens to the context callback', async () => {
    const envelope = encryptByokWithDataKey('secret-value', dataKey);
    const seen: BYOKApiKeyEnvelope[] = [];

    await openKmsCredential(envelope, opened => {
      seen.push(opened);
      return context;
    });

    expect(seen).toEqual([envelope]);
  });

  it('reads no credential for a missing envelope, without contacting the KMS service or building a context', async () => {
    const contextFor = jest.fn(() => context);

    await expect(openKmsCredential(null, contextFor)).resolves.toBeNull();

    expect(contextFor).not.toHaveBeenCalled();
    expect(kms.requests).toEqual([]);
  });
});

describe('openKmsCredential when the KMS service fails', () => {
  it('throws a CredentialKmsError that names the cause and keeps the plaintext out of it', async () => {
    const envelope = encryptByokWithDataKey('secret-value', dataKey);
    kms.fail('/decrypt', 403);
    // A binding no earlier test decrypted, so no cached data key answers in place of KMS.
    const uncachedContext = { ...context, key_id: crypto.randomUUID() };

    const error = await openKmsCredential(envelope, () => uncachedContext).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CredentialKmsError);
    const kmsError = error as CredentialKmsError;
    expect(kmsError.name).toBe('CredentialKmsError');
    expect(kmsError.causeName).toBe('Error');
    expect(kmsError.cause).toBeInstanceOf(Error);
    expect(kmsError.message).not.toContain('secret-value');
    expect(kmsError.causeName).not.toContain('secret-value');
  });

  it('throws a CredentialKmsError when the data key does not open the ciphertext', async () => {
    const envelope = encryptByokWithDataKey('secret-value', dataKey);
    const wrongKeyEnvelope = encryptByokWithDataKey('secret-value', {
      ...dataKey,
      data_key: Buffer.alloc(32, 9).toString('base64'),
    });

    await expect(openKmsCredential(wrongKeyEnvelope, () => context)).rejects.toBeInstanceOf(
      CredentialKmsError
    );
    await expect(openKmsCredential(envelope, () => context)).resolves.toBe('secret-value');
  });

  it('names an unknown cause when the failure is not an Error', () => {
    expect(new CredentialKmsError('refused').causeName).toBe('UnknownError');
  });
});

describe('assertSealable', () => {
  it('accepts a 32-byte data key', () => {
    expect(() => assertSealable(dataKey)).not.toThrow();
  });

  it('throws for a data key that cannot encrypt', () => {
    expect(() =>
      assertSealable({ ...dataKey, data_key: Buffer.alloc(8, 1).toString('base64') })
    ).toThrow();
  });
});
