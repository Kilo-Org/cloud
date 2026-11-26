import type { EncryptedData } from '@kilocode/db/schema-types';
import { coding_plan_key_inventory } from '@kilocode/db/schema';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { legacyCiphertextDigest } from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import {
  encryptByokWithDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { TEST_BYOK_DATA_KEY } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { codingPlanCredentialFingerprint } from '@/lib/coding-plans/credential-fingerprint';
import type { CodingPlanInventoryCredentialColumns } from '@/lib/coding-plans/inventory-credential-encryption';

/** The data key the fake BYOK KMS service issues and returns. */
export const TEST_INVENTORY_DATA_KEY: ByokDataKey = {
  data_key: TEST_BYOK_DATA_KEY,
  wrapped_dek: 'wrapped',
  kms_key_id: 'alias/test',
  kms_key_version: '1',
};

export function legacyInventoryCredential(plaintext: string): EncryptedData {
  return encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);
}

/** An envelope of `plaintext` recording `legacyDigest`, which need not match the row. */
export function inventoryEnvelope(
  plaintext: string,
  legacyDigest: string
): CodingPlanInventoryCredentialColumns['encrypted_api_key_envelope'] {
  return {
    ...encryptByokWithDataKey(plaintext, TEST_INVENTORY_DATA_KEY),
    legacy_digest: legacyDigest,
  };
}

/**
 * Both stored forms of an inventory credential. `envelopePlaintext` differs from
 * `legacyPlaintext` to prove which form a reader used; the envelope is current for the
 * static-key copy it is stored with.
 */
export function dualWrittenInventoryColumns(
  legacyPlaintext: string,
  envelopePlaintext = legacyPlaintext
): CodingPlanInventoryCredentialColumns {
  const legacy = legacyInventoryCredential(legacyPlaintext);
  return {
    encrypted_api_key: legacy,
    encrypted_api_key_envelope: inventoryEnvelope(
      envelopePlaintext,
      legacyCiphertextDigest(legacy)
    ),
  };
}

export async function insertInventoryRow(
  overrides: Partial<typeof coding_plan_key_inventory.$inferInsert> = {}
) {
  const [row] = await db
    .insert(coding_plan_key_inventory)
    .values({
      plan_id: 'byteplus-coding-plan-team-lite',
      provider_id: 'byteplus-coding',
      upstream_plan_id: `upstream-plan-${crypto.randomUUID()}`,
      upstream_usage_id: `seat-${crypto.randomUUID()}`,
      credential_fingerprint: codingPlanCredentialFingerprint(crypto.randomUUID()),
      status: 'available',
      ...overrides,
    })
    .returning();
  return row;
}
