import 'server-only';

import type { EncryptedData, OpenAiChatGptConnectionEnvelope } from '@kilocode/db/schema-types';
import {
  openDualWrittenCredential,
  sealDualWrittenCredential,
} from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import {
  createByokDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';

/** The `provider_id` ChatGPT connection data keys are bound to in the KMS encryption context. */
export const OPENAI_CHATGPT_KMS_PROVIDER_ID = 'openai-chatgpt-oauth';

/** Recorded by the KMS service as the actor of data keys a token refresh creates. */
export const OPENAI_CHATGPT_REFRESH_KMS_ACTOR = 'system:openai-chatgpt-refresh';

/** Recorded by the KMS service as the actor of data keys an eligibility refusal creates. */
export const OPENAI_CHATGPT_ELIGIBILITY_KMS_ACTOR = 'system:openai-chatgpt-eligibility';

/**
 * Whom a connection's data keys belong to: the organization for its shared-services row,
 * which no member owns, and otherwise the person whose delegated account the row holds.
 */
export type OpenAiChatGptKmsOwner = Pick<ByokKmsContext, 'owner_type' | 'owner_id'>;

/** The identity columns of a connection row, which decide its KMS owner. */
export type OpenAiChatGptConnectionOwnerColumns = {
  kilo_user_id: string | null;
  organization_id: string | null;
  is_shared_services: boolean;
};

/** The stored columns a connection payload is read from. */
export type OpenAiChatGptEncryptedConnectionColumns = OpenAiChatGptConnectionOwnerColumns & {
  encrypted_connection: EncryptedData;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope | null;
};

/**
 * The KMS owner of a stored row. Null for a member row whose person was deleted: no owner
 * reads it, so it is never decrypted or given an envelope.
 */
export function openAiChatGptKmsOwnerOfRow(
  row: OpenAiChatGptConnectionOwnerColumns
): OpenAiChatGptKmsOwner | null {
  if (row.is_shared_services) {
    return row.organization_id
      ? { owner_type: 'organization', owner_id: row.organization_id }
      : null;
  }
  return row.kilo_user_id ? { owner_type: 'user', owner_id: row.kilo_user_id } : null;
}

function openAiChatGptKmsContext(owner: OpenAiChatGptKmsOwner, keyId: string): ByokKmsContext {
  return { key_id: keyId, ...owner, provider_id: OPENAI_CHATGPT_KMS_PROVIDER_ID };
}

/** A data key for one connection write, created before the write's transaction. */
export type OpenAiChatGptSealingKey = {
  keyId: string;
  dataKey: ByokDataKey;
};

export async function createOpenAiChatGptSealingKey(
  owner: OpenAiChatGptKmsOwner,
  actorUserId: string
): Promise<OpenAiChatGptSealingKey> {
  const keyId = crypto.randomUUID();
  const dataKey = await createByokDataKey({
    context: openAiChatGptKmsContext(owner, keyId),
    actorUserId,
  });
  return { keyId, dataKey };
}

/** The payload columns of a connection write: the KMS envelope and its static-key copy. */
export function sealOpenAiChatGptConnection(
  connection: OpenAiChatGptConnection,
  sealingKey: OpenAiChatGptSealingKey
): {
  encrypted_connection: EncryptedData;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope;
} {
  const sealed = sealDualWrittenCredential(JSON.stringify(connection), sealingKey.dataKey);
  return {
    encrypted_connection: sealed.legacy,
    encrypted_connection_envelope: { ...sealed.envelope, key_id: sealingKey.keyId },
  };
}

/**
 * Decrypts and parses a stored payload, preferring its KMS envelope. A payload that does
 * not decrypt with the static key or does not parse returns null, so a corrupt row never
 * takes down a sign-in or a request. A KMS failure throws: the row exists, and reading it
 * as absent would tell the person they are disconnected.
 */
export async function openOpenAiChatGptConnection(
  row: OpenAiChatGptEncryptedConnectionColumns
): Promise<OpenAiChatGptConnection | null> {
  const owner = openAiChatGptKmsOwnerOfRow(row);
  if (!owner) return null;
  const plaintext = await openDualWrittenCredential(
    row.encrypted_connection,
    row.encrypted_connection_envelope,
    envelope => openAiChatGptKmsContext(owner, envelope.key_id)
  );
  if (plaintext === null) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext);
  } catch {
    return null;
  }
  return OpenAiChatGptConnectionSchema.safeParse(parsedJson).data ?? null;
}
