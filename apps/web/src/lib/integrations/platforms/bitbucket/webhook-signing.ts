import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const EncodedSigningKeySchema = z.string().min(1).max(128);
const SigningKeyringSchema = z
  .object({
    active: EncodedSigningKeySchema,
    previous: EncodedSigningKeySchema.optional(),
  })
  .strict();

const CanonicalUuidSchema = z
  .string()
  .uuid()
  .refine(value => value === value.toLowerCase());
const DerivationInputSchema = z
  .object({
    integrationId: CanonicalUuidSchema,
    workspaceUuid: CanonicalUuidSchema,
  })
  .strict();

export type BitbucketWebhookIdentity = z.infer<typeof DerivationInputSchema>;
export type BitbucketWebhookSigningKeyring = {
  active: Uint8Array;
  previous?: Uint8Array;
};

function decodeSigningKey(value: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength < 32 || decoded.byteLength > 64 || decoded.toString('base64') !== value) {
    return null;
  }
  return decoded;
}

export function parseBitbucketWebhookSigningKeyring(
  serializedKeyring: string | undefined
): BitbucketWebhookSigningKeyring {
  try {
    if (!serializedKeyring) throw new Error('missing_keyring');
    const parsed = SigningKeyringSchema.parse(JSON.parse(serializedKeyring));
    const active = decodeSigningKey(parsed.active);
    const previous = parsed.previous ? decodeSigningKey(parsed.previous) : undefined;
    if (!active || (parsed.previous && !previous)) throw new Error('invalid_key');
    if (previous) {
      const activeDigest = createHash('sha256').update(active).digest();
      const previousDigest = createHash('sha256').update(previous).digest();
      if (timingSafeEqual(activeDigest, previousDigest)) throw new Error('duplicate_key');
    }
    return { active, ...(previous ? { previous } : {}) };
  } catch {
    throw new Error('Invalid Bitbucket webhook signing keyring');
  }
}

export function deriveBitbucketWebhookSecret(
  signingKey: Uint8Array,
  input: BitbucketWebhookIdentity
): string {
  const parsed = DerivationInputSchema.parse(input);
  const message = `kilo-bitbucket-code-review-webhook:v1:${parsed.integrationId}:${parsed.workspaceUuid}`;
  return createHmac('sha256', signingKey).update(message, 'utf8').digest('hex');
}

export function verifyBitbucketWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  keyring: BitbucketWebhookSigningKeyring,
  input: BitbucketWebhookIdentity
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!match) return false;

  const supplied = Buffer.from(match[1], 'hex');
  const signingKeys = keyring.previous ? [keyring.active, keyring.previous] : [keyring.active];
  let verified = false;
  for (const signingKey of signingKeys) {
    const secret = deriveBitbucketWebhookSecret(signingKey, input);
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    verified = timingSafeEqual(supplied, expected) || verified;
  }
  return verified;
}
