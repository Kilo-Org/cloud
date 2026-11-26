import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { jsonb, pgTable } from 'drizzle-orm/pg-core';
import type { DualWrittenCredentialEnvelope, EncryptedData } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import type { ByokDataKey } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import {
  TEST_BYOK_DATA_KEY,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import {
  isEnvelopeCurrent,
  legacyCiphertextDigest,
  legacyCiphertextDigestSql,
  openDualWrittenCredential,
  sealDualWrittenCredential,
} from './dual-write';

const kms = useFakeByokKms();

const dataKey: ByokDataKey = {
  data_key: TEST_BYOK_DATA_KEY,
  wrapped_dek: 'wrapped',
  kms_key_id: 'alias/test',
  kms_key_version: '1',
};

const context: ByokKmsContext = {
  key_id: 'key-1',
  owner_type: 'user',
  owner_id: 'user-1',
  provider_id: 'test-provider',
};
const contextFor = () => context;

function digestOf(legacy: EncryptedData): string {
  return createHash('sha256').update(`${legacy.iv}.${legacy.data}.${legacy.authTag}`).digest('hex');
}

/** A sealed credential whose static-key copy was replaced, so its envelope no longer matches. */
function sealedThenRewritten(sealedPlaintext: string, rewrittenPlaintext: string) {
  const sealed = sealDualWrittenCredential(sealedPlaintext, dataKey);
  return {
    legacy: encryptApiKey(rewrittenPlaintext, BYOK_ENCRYPTION_KEY),
    envelope: sealed.envelope,
  };
}

describe('sealDualWrittenCredential', () => {
  it('seals the plaintext in both forms, each decrypting with its own key', () => {
    const { legacy, envelope } = sealDualWrittenCredential('sk-secret', dataKey);

    expect(decryptApiKey(legacy, BYOK_ENCRYPTION_KEY)).toBe('sk-secret');
    expect(decryptApiKey(envelope.encrypted_data, TEST_BYOK_DATA_KEY)).toBe('sk-secret');
    expect(JSON.stringify({ legacy, envelope })).not.toContain('sk-secret');
    expect(envelope).toMatchObject({
      wrapped_dek: 'wrapped',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    });
  });

  it('records the digest of the static-key ciphertext it wrote with the envelope', () => {
    const { legacy, envelope } = sealDualWrittenCredential('sk-secret', dataKey);

    expect(envelope.legacy_digest).toBe(digestOf(legacy));
  });

  it('does not contact the KMS service, since the data key is already in hand', () => {
    sealDualWrittenCredential('sk-secret', dataKey);

    expect(kms.requests).toEqual([]);
  });
});

describe('legacyCiphertextDigest', () => {
  const legacy: EncryptedData = { iv: 'aXY=', data: 'ZGF0YQ==', authTag: 'dGFn' };

  it('is the SHA-256 of iv.data.authTag, so it is deterministic', () => {
    expect(legacyCiphertextDigest(legacy)).toBe(digestOf(legacy));
    expect(legacyCiphertextDigest({ ...legacy })).toBe(legacyCiphertextDigest(legacy));
  });

  it.each(['iv', 'data', 'authTag'] as const)('changes when the %s changes', field => {
    expect(legacyCiphertextDigest({ ...legacy, [field]: 'changed' })).not.toBe(
      legacyCiphertextDigest(legacy)
    );
  });

  it('differs between two encryptions of the same plaintext', () => {
    const first = encryptApiKey('same', BYOK_ENCRYPTION_KEY);
    const second = encryptApiKey('same', BYOK_ENCRYPTION_KEY);

    expect(legacyCiphertextDigest(first)).not.toBe(legacyCiphertextDigest(second));
  });
});

describe('legacyCiphertextDigestSql (real database)', () => {
  const probe = pgTable('digest_probe', { ciphertext: jsonb('ciphertext').$type<EncryptedData>() });

  async function digestFromPostgres(legacy: EncryptedData): Promise<string> {
    const result = await db.execute<{ digest: string }>(
      sql`select ${legacyCiphertextDigestSql(probe.ciphertext)} as digest
          from (select ${JSON.stringify(legacy)}::jsonb as ciphertext) as digest_probe`
    );
    return result.rows[0].digest;
  }

  it('equals the digest computed in TypeScript', async () => {
    const { legacy } = sealDualWrittenCredential('sk-secret', dataKey);

    await expect(digestFromPostgres(legacy)).resolves.toBe(legacyCiphertextDigest(legacy));
  });

  it('equals it for ciphertext with every base64 character class and padding', async () => {
    const legacy: EncryptedData = { iv: 'a+b/cd==', data: 'Zm9v+/9=', authTag: 'A_-z0Q==' };

    await expect(digestFromPostgres(legacy)).resolves.toBe(legacyCiphertextDigest(legacy));
  });
});

describe('isEnvelopeCurrent', () => {
  it('is true for the envelope written with the static-key ciphertext', () => {
    const { legacy, envelope } = sealDualWrittenCredential('sk-secret', dataKey);

    expect(isEnvelopeCurrent(legacy, envelope)).toBe(true);
  });

  it('is false for an absent envelope and for a rewritten static-key ciphertext', () => {
    const { legacy, envelope } = sealDualWrittenCredential('sk-secret', dataKey);

    expect(isEnvelopeCurrent(legacy, null)).toBe(false);
    expect(isEnvelopeCurrent(encryptApiKey('sk-secret', BYOK_ENCRYPTION_KEY), envelope)).toBe(
      false
    );
  });
});

describe('openDualWrittenCredential', () => {
  it('reads null when the static-key column is cleared, whatever the envelope holds', async () => {
    const { envelope } = sealDualWrittenCredential('sk-secret', dataKey);

    await expect(openDualWrittenCredential(null, envelope, contextFor)).resolves.toBeNull();
    expect(kms.requests).toEqual([]);
  });

  it('reads the current envelope through the KMS service, binding the context it is given', async () => {
    const { legacy, envelope } = sealDualWrittenCredential('sk-secret', dataKey);

    await expect(openDualWrittenCredential(legacy, envelope, contextFor)).resolves.toBe(
      'sk-secret'
    );

    expect(kms.requests.map(request => request.path)).toEqual(['/decrypt']);
    expect(kms.requests[0].body).toMatchObject({
      ...context,
      wrapped_dek: 'wrapped',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
    });
  });

  it('prefers a current envelope over the static-key copy', async () => {
    const sealed = sealDualWrittenCredential('from-envelope', dataKey);
    // The static-key copy decrypts to another value but is the one the digest names.
    const legacy = encryptApiKey('from-static-copy', BYOK_ENCRYPTION_KEY);
    const envelope: DualWrittenCredentialEnvelope = {
      ...sealed.envelope,
      legacy_digest: legacyCiphertextDigest(legacy),
    };

    await expect(openDualWrittenCredential(legacy, envelope, contextFor)).resolves.toBe(
      'from-envelope'
    );
  });

  it('passes the stored envelope, with its extra fields, to the context builder', async () => {
    const sealed = sealDualWrittenCredential('sk-secret', dataKey);
    const envelope = { ...sealed.envelope, key_id: 'stored-key-id' };
    const seen: string[] = [];

    await openDualWrittenCredential(sealed.legacy, envelope, stored => {
      seen.push(stored.key_id);
      return { ...context, key_id: stored.key_id };
    });

    expect(seen).toEqual(['stored-key-id']);
    expect(kms.requests[0].body).toMatchObject({ key_id: 'stored-key-id' });
  });

  it('ignores a stale envelope and reads the static-key copy without the KMS service', async () => {
    const { legacy, envelope } = sealedThenRewritten('old-secret', 'rewritten-secret');

    await expect(openDualWrittenCredential(legacy, envelope, contextFor)).resolves.toBe(
      'rewritten-secret'
    );
    expect(kms.requests).toEqual([]);
  });

  it('reads the static-key copy when there is no envelope yet', async () => {
    const legacy = encryptApiKey('legacy-only', BYOK_ENCRYPTION_KEY);

    await expect(openDualWrittenCredential(legacy, null, contextFor)).resolves.toBe('legacy-only');
    expect(kms.requests).toEqual([]);
  });

  it('throws when the KMS service refuses the decrypt, and does not fall back to the static-key copy', async () => {
    const { legacy, envelope } = sealDualWrittenCredential('sk-secret', dataKey);
    kms.fail('/decrypt');
    // A binding no earlier test decrypted, so no cached data key answers in place of KMS.
    const uncachedContext = { ...context, key_id: crypto.randomUUID() };

    await expect(
      openDualWrittenCredential(legacy, envelope, () => uncachedContext)
    ).rejects.toThrow('/decrypt');
  });

  it('reads a static-key copy that does not decrypt as null', async () => {
    const corrupt: EncryptedData = { iv: 'not-base64!!!', data: 'also-not', authTag: 'nope' };
    const encryptedWithOtherKey = encryptApiKey('secret', TEST_BYOK_DATA_KEY);

    await expect(openDualWrittenCredential(corrupt, null, contextFor)).resolves.toBeNull();
    await expect(
      openDualWrittenCredential(encryptedWithOtherKey, null, contextFor)
    ).resolves.toBeNull();
  });

  it('reads a corrupt static-key copy next to a stale envelope as null', async () => {
    const { envelope } = sealDualWrittenCredential('sk-secret', dataKey);
    const corrupt: EncryptedData = { iv: 'not-base64!!!', data: 'also-not', authTag: 'nope' };

    await expect(openDualWrittenCredential(corrupt, envelope, contextFor)).resolves.toBeNull();
  });
});
