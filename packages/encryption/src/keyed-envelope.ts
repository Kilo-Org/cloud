import {
  assertEncryptedEnvelope,
  decryptWithPrivateKey,
  encryptWithPublicKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
  type EncryptedEnvelope,
} from './encryption';

export const KEYED_ENVELOPE_VERSION = 1;

export type KeyedEnvelope<Scheme extends string = string> = {
  scheme: Scheme;
  version: typeof KEYED_ENVELOPE_VERSION;
  keyId: string;
  ciphertext: EncryptedEnvelope;
};

export type ActiveEnvelopePublicKey = {
  keyId: string;
  publicKeyPem: string | Buffer;
};

export type EnvelopePrivateKeySlot = {
  keyId: string;
  privateKeyPem?: string | Buffer;
};

export type EnvelopePrivateKeySlots = {
  active: EnvelopePrivateKeySlot;
  decrypt?: readonly EnvelopePrivateKeySlot[];
};

export function serializeKeyedEnvelope<Scheme extends string>(
  envelope: KeyedEnvelope<Scheme>
): string {
  return JSON.stringify(envelope);
}

export function parseKeyedEnvelope<Scheme extends string>(
  serialized: string,
  expectedScheme: Scheme
): KeyedEnvelope<Scheme> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new EncryptionFormatError('Invalid keyed envelope: expected serialized JSON', {
      cause: error,
    });
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new EncryptionFormatError('Invalid keyed envelope: must be an object');
  }

  if (!('scheme' in parsed) || parsed.scheme !== expectedScheme) {
    throw new EncryptionFormatError('Invalid keyed envelope: unsupported scheme');
  }

  if (!('version' in parsed) || parsed.version !== KEYED_ENVELOPE_VERSION) {
    throw new EncryptionFormatError('Invalid keyed envelope: unsupported version');
  }

  if (!('keyId' in parsed) || typeof parsed.keyId !== 'string' || parsed.keyId.length === 0) {
    throw new EncryptionFormatError('Invalid keyed envelope: missing keyId');
  }

  const ciphertext = 'ciphertext' in parsed ? parsed.ciphertext : undefined;
  assertEncryptedEnvelope(ciphertext);

  return {
    scheme: expectedScheme,
    version: KEYED_ENVELOPE_VERSION,
    keyId: parsed.keyId,
    ciphertext,
  };
}

export function encryptKeyedEnvelope<Scheme extends string>(
  value: string,
  scheme: Scheme,
  activeKey: ActiveEnvelopePublicKey,
  aad?: string
): string {
  if (!activeKey.keyId) {
    throw new EncryptionConfigurationError('Active key ID is required');
  }

  return serializeKeyedEnvelope({
    scheme,
    version: KEYED_ENVELOPE_VERSION,
    keyId: activeKey.keyId,
    ciphertext: encryptWithPublicKey(value, activeKey.publicKeyPem, aad),
  });
}

export function decryptKeyedEnvelope<Scheme extends string>(
  serialized: string,
  scheme: Scheme,
  keys: EnvelopePrivateKeySlots,
  aad?: string
): string {
  const envelope = parseKeyedEnvelope(serialized, scheme);
  const key = selectPrivateKey(envelope.keyId, keys);

  if (!key.privateKeyPem) {
    throw new EncryptionConfigurationError(
      `Private key is not configured for keyed envelope key ID: ${envelope.keyId}`
    );
  }

  return decryptWithPrivateKey(envelope.ciphertext, key.privateKeyPem, aad);
}

function selectPrivateKey(keyId: string, keys: EnvelopePrivateKeySlots): EnvelopePrivateKeySlot {
  const decryptSlot = keys.decrypt?.find(slot => slot.keyId === keyId);
  if (keys.active.keyId === keyId) {
    if (keys.active.privateKeyPem) return keys.active;
    return decryptSlot ?? keys.active;
  }
  if (decryptSlot) {
    return decryptSlot;
  }

  throw new EncryptionFormatError(`Unknown keyed envelope key ID: ${keyId}`);
}
