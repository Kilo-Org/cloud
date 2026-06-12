import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { Buffer } from 'node:buffer';
import { z } from 'zod';

const LEGACY_CAPABILITY_PREFIX = 'kgh1.';
const BOUND_CAPABILITY_PREFIX = 'kgh2.';
const CAPABILITY_PURPOSE = 'github_scm_session';
const MAX_LEGACY_GITHUB_SCM_SESSION_CAPABILITY_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_BOUND_GITHUB_SCM_SESSION_CAPABILITY_LIFETIME_MS = 4 * 60 * 60 * 1000;

function getGitHubSessionCapabilityLifetimeMs(version: 1 | 2): number {
  return version === 1
    ? MAX_LEGACY_GITHUB_SCM_SESSION_CAPABILITY_LIFETIME_MS
    : MAX_BOUND_GITHUB_SCM_SESSION_CAPABILITY_LIFETIME_MS;
}

const GitHubPathPartSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/)
  .refine(value => value === value.toLowerCase());

const GitAuthorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1),
  })
  .strict();
const GitHubSessionIdentitySchema = z
  .object({
    installationId: z.string().min(1),
    accountLogin: z.string().min(1),
    appType: z.enum(['standard', 'lite']),
    gitAuthor: GitAuthorSchema,
    commitCoAuthor: GitAuthorSchema.optional(),
  })
  .strict();
const GitHubSessionCapabilityClaimsBaseSchema = z.object({
  purpose: z.literal(CAPABILITY_PURPOSE),
  userId: z.string().min(1),
  orgId: z.string().uuid().optional(),
  owner: GitHubPathPartSchema,
  repo: GitHubPathPartSchema,
  source: z.enum(['user', 'installation']),
  identity: GitHubSessionIdentitySchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});
const GitHubLegacySessionCapabilityClaimsSchema = GitHubSessionCapabilityClaimsBaseSchema.extend({
  version: z.literal(1),
}).strict();
const GitHubBoundSessionCapabilityClaimsSchema = GitHubSessionCapabilityClaimsBaseSchema.extend({
  version: z.literal(2),
  outboundContainerId: z.string().min(1),
}).strict();
const GitHubSessionCapabilityClaimsSchema = z
  .discriminatedUnion('version', [
    GitHubLegacySessionCapabilityClaimsSchema,
    GitHubBoundSessionCapabilityClaimsSchema,
  ])
  .refine(claims => claims.expiresAt > claims.issuedAt)
  .refine(
    claims =>
      claims.expiresAt - claims.issuedAt <= getGitHubSessionCapabilityLifetimeMs(claims.version)
  );

export type GitHubAuthSource = 'user' | 'installation';
export type GitHubSessionIdentity = z.infer<typeof GitHubSessionIdentitySchema>;
export type GitHubSessionCapabilitySubject = {
  userId: string;
  outboundContainerId?: string;
  orgId?: string;
  owner: string;
  repo: string;
  source: GitHubAuthSource;
  identity: GitHubSessionIdentity;
};
export type GitHubSessionCapabilityClaims = z.infer<typeof GitHubSessionCapabilityClaimsSchema>;
export type GitHubSessionCapabilityFailureReason =
  | 'invalid_capability'
  | 'expired_capability'
  | 'capability_configuration_error';

export class GitHubSessionCapabilityError extends Error {
  constructor(readonly reason: GitHubSessionCapabilityFailureReason) {
    super(reason);
    this.name = 'GitHubSessionCapabilityError';
  }
}

export function hasCanonicalEncryptedValueFormat(encrypted: string): boolean {
  const parts = encrypted.split(':');
  if (parts.length !== 3) return false;
  const [iv, authTag, ciphertext] = parts;
  if (!iv || !authTag || !ciphertext) return false;
  return [
    [iv, 16],
    [authTag, 16],
    [ciphertext, null],
  ].every(([encoded, expectedLength]) => {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) return false;
    return expectedLength === null || decoded.length === expectedLength;
  });
}

export function normalizeGitHubRepository(
  githubRepo: string
): { owner: string; repo: string } | null {
  const parts = githubRepo.split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0]?.trim().toLowerCase();
  const repo = parts[1]?.trim().toLowerCase();
  const parsed = z.object({ owner: GitHubPathPartSchema, repo: GitHubPathPartSchema }).safeParse({
    owner,
    repo,
  });
  return parsed.success ? parsed.data : null;
}

export class GitHubSessionCapabilityCodec {
  constructor(private readonly encryptionKey: string) {}

  issue(subject: GitHubSessionCapabilitySubject): string {
    const issuedAt = Date.now();
    const bound = subject.outboundContainerId !== undefined;
    const version = bound ? 2 : 1;
    const parsed = GitHubSessionCapabilityClaimsSchema.safeParse({
      purpose: CAPABILITY_PURPOSE,
      version,
      ...subject,
      issuedAt,
      expiresAt: issuedAt + getGitHubSessionCapabilityLifetimeMs(version),
    });
    if (!parsed.success) throw new GitHubSessionCapabilityError('invalid_capability');

    try {
      const prefix = bound ? BOUND_CAPABILITY_PREFIX : LEGACY_CAPABILITY_PREFIX;
      return `${prefix}${encryptWithSymmetricKey(JSON.stringify(parsed.data), this.encryptionKey)}`;
    } catch {
      throw new GitHubSessionCapabilityError('capability_configuration_error');
    }
  }

  decode(capability: string): GitHubSessionCapabilityClaims {
    const format = capability.startsWith(LEGACY_CAPABILITY_PREFIX)
      ? { prefix: LEGACY_CAPABILITY_PREFIX, version: 1 as const }
      : capability.startsWith(BOUND_CAPABILITY_PREFIX)
        ? { prefix: BOUND_CAPABILITY_PREFIX, version: 2 as const }
        : null;
    if (!format) throw new GitHubSessionCapabilityError('invalid_capability');

    const encrypted = capability.slice(format.prefix.length);
    if (!hasCanonicalEncryptedValueFormat(encrypted)) {
      throw new GitHubSessionCapabilityError('invalid_capability');
    }
    let serialized: string;
    try {
      serialized = decryptWithSymmetricKey(encrypted, this.encryptionKey);
    } catch {
      throw new GitHubSessionCapabilityError('invalid_capability');
    }

    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new GitHubSessionCapabilityError('invalid_capability');
    }
    const parsed = GitHubSessionCapabilityClaimsSchema.safeParse(value);
    if (!parsed.success || parsed.data.version !== format.version) {
      throw new GitHubSessionCapabilityError('invalid_capability');
    }
    if (parsed.data.expiresAt <= Date.now()) {
      throw new GitHubSessionCapabilityError('expired_capability');
    }
    return parsed.data;
  }
}
