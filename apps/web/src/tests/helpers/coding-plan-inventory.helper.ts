import type { EncryptedData } from '@kilocode/db/schema-types';
import { coding_plan_key_inventory } from '@kilocode/db/schema';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import type { ByokDataKey } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { TEST_BYOK_DATA_KEY } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { codingPlanCredentialFingerprint } from '@/lib/coding-plans/credential-fingerprint';
import {
  sealCodingPlanInventoryCredential,
  type CodingPlanInventoryCredentialColumns,
} from '@/lib/coding-plans/inventory-credential-encryption';

/** The data key the fake BYOK KMS service issues and returns. */
export const TEST_INVENTORY_DATA_KEY: ByokDataKey = {
  data_key: TEST_BYOK_DATA_KEY,
  wrapped_dek: 'wrapped',
  kms_key_id: 'alias/test',
  kms_key_version: '1',
};

/** A static-key ciphertext of the kind written before the KMS migration. Nothing reads it any more. */
export function staticKeyInventoryCredential(plaintext: string): EncryptedData {
  return encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);
}

/** The credential columns a writer stores for `plaintext`: the placeholder and a KMS envelope. */
export function sealedInventoryColumns(plaintext: string): CodingPlanInventoryCredentialColumns {
  return sealCodingPlanInventoryCredential(plaintext, TEST_INVENTORY_DATA_KEY);
}

/**
 * Columns whose envelope holds `plaintext` next to a real static-key ciphertext of
 * `staticKeyPlaintext`, which proves a reader used the envelope and not the static column.
 */
export function sealedInventoryColumnsWithStaticKeyCopy(
  plaintext: string,
  staticKeyPlaintext: string
): CodingPlanInventoryCredentialColumns {
  return {
    ...sealedInventoryColumns(plaintext),
    encrypted_api_key: staticKeyInventoryCredential(staticKeyPlaintext),
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
