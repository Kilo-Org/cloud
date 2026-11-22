import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';

/** The identity a BYOK data key is bound to, sent to the KMS service and used to key the data key cache. */
export type ByokKmsContext = {
  key_id: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  provider_id: string;
};

/** The identity the KMS service binds a data key to: the owner context plus the wrapped key. */
export type ByokDataKeyBinding = ByokKmsContext & {
  wrapped_dek: string;
  kms_key_id: string;
  kms_key_version: string;
};

/**
 * The binding `/decrypt` sends and the data-key cache hashes: the owner context plus the wrapped key
 * and the KMS key that wrapped it. Both read it from here so the two cannot drift.
 */
export function byokDataKeyBinding(
  envelope: BYOKApiKeyEnvelope,
  context: ByokKmsContext
): ByokDataKeyBinding {
  return {
    key_id: context.key_id,
    owner_type: context.owner_type,
    owner_id: context.owner_id,
    provider_id: context.provider_id,
    wrapped_dek: envelope.wrapped_dek,
    kms_key_id: envelope.kms_key_id,
    kms_key_version: envelope.kms_key_version,
  };
}
