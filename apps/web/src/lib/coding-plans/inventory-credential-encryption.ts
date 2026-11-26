import 'server-only';

import type {
  CodingPlanInventoryCredentialEnvelope,
  EncryptedData,
} from '@kilocode/db/schema-types';
import {
  openDualWrittenCredential,
  sealDualWrittenCredential,
} from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import {
  createByokDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';

/** The `provider_id` Coding Plan inventory data keys are bound to in the KMS encryption context. */
export const CODING_PLAN_INVENTORY_KMS_PROVIDER_ID = 'coding-plan-inventory';

/**
 * Inventory credentials are Kilo's pooled upstream credentials, so their data keys belong to
 * the Kilo organization whoever the row is assigned to. Each data key is bound to its
 * inventory row id, so an envelope copied onto another row does not decrypt.
 */
export function codingPlanInventoryKmsContext(inventoryId: string): ByokKmsContext {
  return {
    // Admin input may spell the UUID in uppercase while PostgreSQL returns it lowercase; the
    // binding uses the form a later read derives from the row.
    key_id: inventoryId.toLowerCase(),
    owner_type: 'organization',
    owner_id: KILO_ORGANIZATION_ID,
    provider_id: CODING_PLAN_INVENTORY_KMS_PROVIDER_ID,
  };
}

/**
 * Creates the data key one write of an inventory row's credential uses. It carries no
 * plaintext, so callers create it before their transaction.
 */
export async function createCodingPlanInventoryDataKey(
  inventoryId: string,
  actorUserId: string
): Promise<ByokDataKey> {
  return await createByokDataKey({
    context: codingPlanInventoryKmsContext(inventoryId),
    actorUserId,
  });
}

export type CodingPlanInventoryCredentialColumns = {
  encrypted_api_key: EncryptedData;
  encrypted_api_key_envelope: CodingPlanInventoryCredentialEnvelope;
};

/** The credential columns a write of an inventory row sets: both stored forms together. */
export function sealCodingPlanInventoryCredential(
  apiKey: string,
  dataKey: ByokDataKey
): CodingPlanInventoryCredentialColumns {
  const sealed = sealDualWrittenCredential(apiKey, dataKey);
  return { encrypted_api_key: sealed.legacy, encrypted_api_key_envelope: sealed.envelope };
}

/**
 * The credential columns every revocation, termination and deletion path sets, so the
 * encrypted credential material is removed in both stored forms.
 */
export const CLEARED_CODING_PLAN_INVENTORY_CREDENTIAL = {
  encrypted_api_key: null,
  encrypted_api_key_envelope: null,
} as const;

/**
 * Reads an inventory row's credential, preferring its KMS envelope. Null when the
 * credential was removed or its static-key copy does not decrypt; a KMS failure throws.
 */
export async function openCodingPlanInventoryCredential(row: {
  id: string;
  encrypted_api_key: EncryptedData | null;
  encrypted_api_key_envelope: CodingPlanInventoryCredentialEnvelope | null;
}): Promise<string | null> {
  return await openDualWrittenCredential(
    row.encrypted_api_key,
    row.encrypted_api_key_envelope,
    () => codingPlanInventoryKmsContext(row.id)
  );
}
