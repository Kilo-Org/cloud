import {
  CustomLlmCredentialsSchema,
  type CustomLlmCredentials,
  type CustomLlmCredentialsEnvelope,
} from '@kilocode/db/schema-types';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import {
  decryptByokEnvelope,
  encryptByokForStorage,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';

/** The `provider_id` custom LLM data keys are bound to in the KMS encryption context. */
export const CUSTOM_LLM_KMS_PROVIDER_ID = 'custom-llm';

/** Custom LLMs are Kilo's own upstream credentials, so their data keys belong to the Kilo org. */
function customLlmKmsContext(keyId: string): ByokKmsContext {
  return {
    key_id: keyId,
    owner_type: 'organization',
    owner_id: KILO_ORGANIZATION_ID,
    provider_id: CUSTOM_LLM_KMS_PROVIDER_ID,
  };
}

export async function encryptCustomLlmCredentials({
  credentials,
  actorUserId,
}: {
  credentials: CustomLlmCredentials;
  actorUserId: string;
}): Promise<CustomLlmCredentialsEnvelope> {
  const keyId = crypto.randomUUID();
  const envelope = await encryptByokForStorage({
    apiKey: JSON.stringify(credentials),
    context: customLlmKmsContext(keyId),
    actorUserId,
  });
  return { ...envelope, key_id: keyId };
}

/** Null when the decrypted payload is not valid credentials JSON; a KMS failure throws. */
export async function decryptCustomLlmCredentials(
  envelope: CustomLlmCredentialsEnvelope
): Promise<CustomLlmCredentials | null> {
  const decrypted = await decryptByokEnvelope(envelope, customLlmKmsContext(envelope.key_id));
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return null;
  }
  return CustomLlmCredentialsSchema.safeParse(parsedJson).data ?? null;
}
