import type { CodingPlanInventoryCredentialEnvelope } from '@kilocode/db/schema-types';

import { createByokEnvelope } from './byok';

// Mirrors apps/web/src/lib/coding-plans/inventory-credential-encryption.ts and
// packages/web-shared/src/lib/organizations/constants.ts; seeds cannot import them.
const KILO_ORGANIZATION_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
const INVENTORY_KMS_PROVIDER_ID = 'coding-plan-inventory';

export function inventoryKmsContext(inventoryId: string) {
  return {
    key_id: inventoryId.toLowerCase(),
    owner_type: 'organization',
    owner_id: KILO_ORGANIZATION_ID,
    provider_id: INVENTORY_KMS_PROVIDER_ID,
  } as const;
}

/**
 * The credential column of a Coding Plan inventory row, sealed through the local `byok-kms`
 * service and bound to `inventoryId`. Insert the row with that explicit id.
 */
export async function sealInventoryCredential(
  inventoryId: string,
  plaintext: string
): Promise<{ encrypted_api_key_envelope: CodingPlanInventoryCredentialEnvelope }> {
  return {
    encrypted_api_key_envelope: await createByokEnvelope(
      inventoryKmsContext(inventoryId),
      plaintext
    ),
  };
}
