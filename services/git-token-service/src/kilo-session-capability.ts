import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { z } from 'zod';
import { hasCanonicalEncryptedValueFormat } from './github-session-capability.js';

const CAPABILITY_PREFIX = 'kka1.';
const CAPABILITY_PURPOSE = 'kilo_api_session';
const MAX_KILO_SESSION_CAPABILITY_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_KILO_SESSION_CAPABILITY_LENGTH = 64 * 1024;
// issue() and decode() can run on different isolates whose clocks are not
// perfectly aligned; allow a small future skew so a freshly issued capability is
// not spuriously rejected as forged on the first redemption.
const KILO_SESSION_CAPABILITY_CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

const KiloSessionCapabilityTargetsSchema = z
  .object({
    backendBaseUrl: z.string().url(),
    providerBaseUrl: z.string().url(),
    sessionIngestBaseUrl: z.string().url(),
  })
  .strict();

const KiloSessionCapabilityClaimsSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal(CAPABILITY_PURPOSE),
    userId: z.string().min(1),
    cloudAgentSessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    outboundContainerId: z.string().min(1),
    userToken: z.string().min(1),
    targets: KiloSessionCapabilityTargetsSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine(claims => claims.expiresAt > claims.issuedAt)
  .refine(claims => claims.expiresAt - claims.issuedAt <= MAX_KILO_SESSION_CAPABILITY_LIFETIME_MS);

export type KiloSessionCapabilityTargets = z.infer<typeof KiloSessionCapabilityTargetsSchema>;
export type KiloSessionCapabilitySubject = {
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  outboundContainerId: string;
  userToken: string;
  targets: KiloSessionCapabilityTargets;
};
export type KiloSessionCapabilityClaims = z.infer<typeof KiloSessionCapabilityClaimsSchema>;
export type KiloSessionCapabilityFailureReason =
  | 'invalid_capability'
  | 'expired_capability'
  | 'capability_configuration_error';

export class KiloSessionCapabilityError extends Error {
  constructor(readonly reason: KiloSessionCapabilityFailureReason) {
    super(reason);
    this.name = 'KiloSessionCapabilityError';
  }
}

export class KiloSessionCapabilityCodec {
  constructor(private readonly encryptionKey: string) {}

  issue(subject: KiloSessionCapabilitySubject): string {
    const issuedAt = Date.now();
    const parsed = KiloSessionCapabilityClaimsSchema.safeParse({
      version: 1,
      purpose: CAPABILITY_PURPOSE,
      ...subject,
      issuedAt,
      expiresAt: issuedAt + MAX_KILO_SESSION_CAPABILITY_LIFETIME_MS,
    });
    if (!parsed.success) throw new KiloSessionCapabilityError('invalid_capability');

    try {
      const capability = `${CAPABILITY_PREFIX}${encryptWithSymmetricKey(JSON.stringify(parsed.data), this.encryptionKey)}`;
      if (capability.length > MAX_KILO_SESSION_CAPABILITY_LENGTH) {
        throw new KiloSessionCapabilityError('invalid_capability');
      }
      return capability;
    } catch (error) {
      if (error instanceof KiloSessionCapabilityError) throw error;
      throw new KiloSessionCapabilityError('capability_configuration_error');
    }
  }

  decode(capability: string): KiloSessionCapabilityClaims {
    if (capability.length > MAX_KILO_SESSION_CAPABILITY_LENGTH) {
      throw new KiloSessionCapabilityError('invalid_capability');
    }
    if (!capability.startsWith(CAPABILITY_PREFIX)) {
      throw new KiloSessionCapabilityError('invalid_capability');
    }

    const encrypted = capability.slice(CAPABILITY_PREFIX.length);
    if (!hasCanonicalEncryptedValueFormat(encrypted)) {
      throw new KiloSessionCapabilityError('invalid_capability');
    }

    let serialized: string;
    try {
      serialized = decryptWithSymmetricKey(encrypted, this.encryptionKey);
    } catch {
      throw new KiloSessionCapabilityError('invalid_capability');
    }

    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new KiloSessionCapabilityError('invalid_capability');
    }

    const parsed = KiloSessionCapabilityClaimsSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.issuedAt > Date.now() + KILO_SESSION_CAPABILITY_CLOCK_SKEW_TOLERANCE_MS
    ) {
      throw new KiloSessionCapabilityError('invalid_capability');
    }
    if (parsed.data.expiresAt <= Date.now()) {
      throw new KiloSessionCapabilityError('expired_capability');
    }
    return parsed.data;
  }
}
