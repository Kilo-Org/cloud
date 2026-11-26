import 'server-only';

import type { EncryptedData, OpenAiChatGptConnectionEnvelope } from '@kilocode/db/schema-types';
import {
  assertSealable,
  CredentialKmsError,
  openDualWrittenCredential,
  openStaticKeyCopy,
  sealDualWrittenCredential,
} from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import {
  createByokDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';

/** The prefix of the `provider_id` ChatGPT connection data keys are bound to; see `openAiChatGptKmsOwnerFor`. */
export const OPENAI_CHATGPT_KMS_PROVIDER_ID = 'openai-chatgpt-oauth';

/** Recorded by the KMS service as the actor of data keys a token refresh creates. */
export const OPENAI_CHATGPT_REFRESH_KMS_ACTOR = 'system:openai-chatgpt-refresh';

/** Recorded by the KMS service as the actor of data keys an eligibility refusal creates. */
export const OPENAI_CHATGPT_ELIGIBILITY_KMS_ACTOR = 'system:openai-chatgpt-eligibility';

/**
 * Whom a connection's data keys belong to and which of the owner's connections they seal:
 * the organization for its shared-services row, which no member owns, and otherwise the
 * person whose delegated account the row holds. One person can hold a personal row and a
 * row per organization, so `provider_id` names the account the row is scoped to, and an
 * envelope copied to another of the person's rows does not decrypt.
 */
export type OpenAiChatGptKmsOwner = Pick<ByokKmsContext, 'owner_type' | 'owner_id' | 'provider_id'>;

/** The KMS owner of a connection, from the account it is scoped to. */
export function openAiChatGptKmsOwnerFor(
  scope:
    | { kind: 'shared_services'; organizationId: string }
    | { kind: 'member'; kiloUserId: string; organizationId: string | null }
): OpenAiChatGptKmsOwner {
  // Organization ids are UUIDs that callers may spell in either case, while PostgreSQL
  // returns them lowercase; the binding uses the form a later read derives from the row.
  if (scope.kind === 'shared_services') {
    return {
      owner_type: 'organization',
      owner_id: scope.organizationId.toLowerCase(),
      provider_id: `${OPENAI_CHATGPT_KMS_PROVIDER_ID}:shared-services`,
    };
  }
  return {
    owner_type: 'user',
    owner_id: scope.kiloUserId,
    provider_id:
      scope.organizationId === null
        ? `${OPENAI_CHATGPT_KMS_PROVIDER_ID}:personal`
        : `${OPENAI_CHATGPT_KMS_PROVIDER_ID}:organization:${scope.organizationId.toLowerCase()}`,
  };
}

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
      ? openAiChatGptKmsOwnerFor({ kind: 'shared_services', organizationId: row.organization_id })
      : null;
  }
  return row.kilo_user_id
    ? openAiChatGptKmsOwnerFor({
        kind: 'member',
        kiloUserId: row.kilo_user_id,
        organizationId: row.organization_id,
      })
    : null;
}

function openAiChatGptKmsContext(owner: OpenAiChatGptKmsOwner, keyId: string): ByokKmsContext {
  return { key_id: keyId, ...owner };
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
  // A refresh sends the rotating refresh token only after this returns, so a key that
  // cannot seal must fail here rather than after OpenAI has spent the old token.
  assertSealable(dataKey);
  return { keyId, dataKey };
}

/** The payload columns of a connection write: the KMS envelope and its static-key copy. */
export function sealOpenAiChatGptConnection(
  connection: OpenAiChatGptConnection,
  sealingKey: OpenAiChatGptSealingKey
): {
  encrypted_connection: EncryptedData;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope;
};
/**
 * Without a data key only the static-key copy is written and the envelope is cleared, so
 * readers use that copy until the backfill adds an envelope. Only for a payload without
 * usable tokens, such as a refusal recorded while the KMS service is unavailable.
 */
export function sealOpenAiChatGptConnection(
  connection: OpenAiChatGptConnection,
  sealingKey: OpenAiChatGptSealingKey | null
): {
  encrypted_connection: EncryptedData;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope | null;
};
export function sealOpenAiChatGptConnection(
  connection: OpenAiChatGptConnection,
  sealingKey: OpenAiChatGptSealingKey | null
): {
  encrypted_connection: EncryptedData;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope | null;
} {
  if (sealingKey === null) {
    return {
      encrypted_connection: encryptApiKey(JSON.stringify(connection), BYOK_ENCRYPTION_KEY),
      encrypted_connection_envelope: null,
    };
  }
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
  return parseOpenAiChatGptConnection(plaintext);
}

function parseOpenAiChatGptConnection(plaintext: string | null): OpenAiChatGptConnection | null {
  if (plaintext === null) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext);
  } catch {
    return null;
  }
  return OpenAiChatGptConnectionSchema.safeParse(parsedJson).data ?? null;
}

/**
 * The stored payload for deciding whether a report still belongs to the row, such as a
 * refusal or a usage limit naming the access token that produced it. While the KMS service
 * cannot open the envelope, the static-key copy written with it answers instead: the
 * decision only compares the token a caller already holds and never serves it, and a
 * refused account must still be disabled during a KMS outage.
 */
export async function openOpenAiChatGptConnectionForComparison(
  row: OpenAiChatGptEncryptedConnectionColumns
): Promise<OpenAiChatGptConnection | null> {
  try {
    return await openOpenAiChatGptConnection(row);
  } catch (error) {
    if (!(error instanceof CredentialKmsError)) throw error;
    console.warn(
      '[openai-chatgpt] KMS could not open the stored payload; comparing against the static-key copy: %s',
      error.causeName
    );
    return openAiChatGptKmsOwnerOfRow(row)
      ? parseOpenAiChatGptConnection(openStaticKeyCopy(row.encrypted_connection))
      : null;
  }
}
