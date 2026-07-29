import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { z } from 'zod';
import { hasCanonicalEncryptedValueFormat } from './github-session-capability.js';

// Bitbucket session capabilities are always container-bound (there is no legacy
// unbound form to carry forward), so a single versioned, prefixed format is
// enough. The opaque capability replaces the raw workspace access token inside
// the sandbox; the outbound interceptor redeems it for the real credential.
const BITBUCKET_CAPABILITY_PREFIX = 'kbb1.';
const CAPABILITY_PURPOSE = 'bitbucket_scm_session';
const MAX_BITBUCKET_SCM_SESSION_CAPABILITY_LIFETIME_MS = 4 * 60 * 60 * 1000;

const WorkspaceSlugSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);
const RepositoryFullNameSchema = z
  .string()
  .min(3)
  .max(511)
  .refine(name => /^[^/\s]+\/[^/\s]+$/.test(name));
const TokenDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const BitbucketSessionCapabilityClaimsSchema = z
  .object({
    purpose: z.literal(CAPABILITY_PURPOSE),
    version: z.literal(1),
    userId: z.string().min(1),
    orgId: z.uuid(),
    integrationId: z.uuid(),
    workspaceUuid: z.uuid(),
    workspaceSlug: WorkspaceSlugSchema,
    repositoryUuid: z.uuid(),
    repositoryFullName: RepositoryFullNameSchema,
    // A digest of the resolved token at issue time. The redeem path re-resolves
    // the current token and compares digests, so a rotated token invalidates the
    // capability regardless of which Bitbucket auth source backs it.
    tokenDigest: TokenDigestSchema,
    outboundContainerId: z.string().min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine(claims => claims.expiresAt > claims.issuedAt)
  .refine(
    claims => claims.expiresAt - claims.issuedAt <= MAX_BITBUCKET_SCM_SESSION_CAPABILITY_LIFETIME_MS
  );

export type BitbucketSessionCapabilityClaims = z.infer<
  typeof BitbucketSessionCapabilityClaimsSchema
>;
export type BitbucketSessionCapabilitySubject = Omit<
  BitbucketSessionCapabilityClaims,
  'purpose' | 'version' | 'issuedAt' | 'expiresAt'
>;

export type BitbucketSessionCapabilityFailureReason =
  | 'invalid_capability'
  | 'expired_capability'
  | 'capability_configuration_error';

export class BitbucketSessionCapabilityError extends Error {
  constructor(readonly reason: BitbucketSessionCapabilityFailureReason) {
    super(reason);
    this.name = 'BitbucketSessionCapabilityError';
  }
}

export function isBitbucketSessionCapability(value: string): boolean {
  return value.startsWith(BITBUCKET_CAPABILITY_PREFIX);
}

export async function bitbucketTokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class BitbucketSessionCapabilityCodec {
  constructor(private readonly encryptionKey: string) {}

  issue(subject: BitbucketSessionCapabilitySubject): string {
    const issuedAt = Date.now();
    const parsed = BitbucketSessionCapabilityClaimsSchema.safeParse({
      purpose: CAPABILITY_PURPOSE,
      version: 1,
      ...subject,
      issuedAt,
      expiresAt: issuedAt + MAX_BITBUCKET_SCM_SESSION_CAPABILITY_LIFETIME_MS,
    });
    if (!parsed.success) throw new BitbucketSessionCapabilityError('invalid_capability');
    try {
      return `${BITBUCKET_CAPABILITY_PREFIX}${encryptWithSymmetricKey(
        JSON.stringify(parsed.data),
        this.encryptionKey
      )}`;
    } catch {
      throw new BitbucketSessionCapabilityError('capability_configuration_error');
    }
  }

  decode(capability: string): BitbucketSessionCapabilityClaims {
    if (!capability.startsWith(BITBUCKET_CAPABILITY_PREFIX)) {
      throw new BitbucketSessionCapabilityError('invalid_capability');
    }
    const encrypted = capability.slice(BITBUCKET_CAPABILITY_PREFIX.length);
    if (!hasCanonicalEncryptedValueFormat(encrypted)) {
      throw new BitbucketSessionCapabilityError('invalid_capability');
    }
    let serialized: string;
    try {
      serialized = decryptWithSymmetricKey(encrypted, this.encryptionKey);
    } catch {
      throw new BitbucketSessionCapabilityError('invalid_capability');
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new BitbucketSessionCapabilityError('invalid_capability');
    }
    const parsed = BitbucketSessionCapabilityClaimsSchema.safeParse(value);
    if (!parsed.success) {
      throw new BitbucketSessionCapabilityError('invalid_capability');
    }
    if (parsed.data.expiresAt <= Date.now()) {
      throw new BitbucketSessionCapabilityError('expired_capability');
    }
    return parsed.data;
  }
}
