import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { z } from 'zod';
import { hasCanonicalEncryptedValueFormat } from './github-session-capability.js';
import { GitLabProjectPathSchema, normalizeGitLabInstanceUrl } from './gitlab-url.js';
export { parseGitLabCloneUrl } from './gitlab-url.js';
export type { GitLabCloneUrlFailureReason, GitLabCloneUrlResult } from './gitlab-url.js';

const LEGACY_CAPABILITY_PREFIX = 'kgl1.';
const BOUND_CAPABILITY_PREFIX = 'kgl2.';
const CAPABILITY_PURPOSE = 'gitlab_scm_session';
const MAX_LEGACY_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_BOUND_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS = 4 * 60 * 60 * 1000;

function getGitLabSessionCapabilityLifetimeMs(version: 1 | 2): number {
  return version === 1
    ? MAX_LEGACY_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS
    : MAX_BOUND_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS;
}

const GitLabSessionIdentitySchema = z
  .object({
    accountId: z.string().min(1).nullable(),
    accountLogin: z.string().min(1).nullable(),
  })
  .strict()
  .refine(identity => identity.accountId !== null || identity.accountLogin !== null);
const GitLabProjectTokenDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitLabCapabilityCredentialSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('integration') }).strict(),
  z
    .object({
      type: z.literal('project'),
      projectId: z.number().int().positive(),
      tokenDigest: GitLabProjectTokenDigestSchema,
    })
    .strict(),
]);
const GitLabSessionCapabilityClaimsBaseSchema = z.object({
  purpose: z.literal(CAPABILITY_PURPOSE),
  userId: z.string().min(1),
  orgId: z.string().uuid().optional(),
  integrationId: z.string().uuid(),
  instanceOrigin: z.string().url().refine(isCanonicalGitLabInstanceUrl),
  projectPath: GitLabProjectPathSchema,
  authType: z.enum(['oauth', 'pat']),
  identity: GitLabSessionIdentitySchema,
  source: GitLabCapabilityCredentialSourceSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});
const GitLabLegacySessionCapabilityClaimsSchema = GitLabSessionCapabilityClaimsBaseSchema.extend({
  version: z.literal(1),
}).strict();
const GitLabBoundSessionCapabilityClaimsSchema = GitLabSessionCapabilityClaimsBaseSchema.extend({
  version: z.literal(2),
  outboundContainerId: z.string().min(1),
}).strict();
const GitLabSessionCapabilityClaimsSchema = z
  .discriminatedUnion('version', [
    GitLabLegacySessionCapabilityClaimsSchema,
    GitLabBoundSessionCapabilityClaimsSchema,
  ])
  .refine(claims => claims.expiresAt > claims.issuedAt)
  .refine(
    claims =>
      claims.expiresAt - claims.issuedAt <= getGitLabSessionCapabilityLifetimeMs(claims.version)
  );

export type GitLabAuthType = 'oauth' | 'pat';
export type GitLabSessionIdentity = z.infer<typeof GitLabSessionIdentitySchema>;
export type GitLabCapabilityCredentialSource = z.infer<
  typeof GitLabCapabilityCredentialSourceSchema
>;
export type GitLabSessionCapabilitySubject = {
  userId: string;
  outboundContainerId?: string;
  orgId?: string;
  integrationId: string;
  instanceOrigin: string;
  projectPath: string;
  authType: GitLabAuthType;
  identity: GitLabSessionIdentity;
  source: GitLabCapabilityCredentialSource;
};
export type GitLabSessionCapabilityClaims = z.infer<typeof GitLabSessionCapabilityClaimsSchema>;
export type GitLabSessionCapabilityFailureReason =
  | 'invalid_capability'
  | 'expired_capability'
  | 'capability_configuration_error';
export class GitLabSessionCapabilityError extends Error {
  constructor(readonly reason: GitLabSessionCapabilityFailureReason) {
    super(reason);
    this.name = 'GitLabSessionCapabilityError';
  }
}

function isCanonicalGitLabInstanceUrl(instanceUrl: string): boolean {
  return normalizeGitLabInstanceUrl(instanceUrl) === instanceUrl;
}

export async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class GitLabSessionCapabilityCodec {
  constructor(private readonly encryptionKey: string) {}

  issue(subject: GitLabSessionCapabilitySubject): string {
    const issuedAt = Date.now();
    const bound = subject.outboundContainerId !== undefined;
    const version = bound ? 2 : 1;
    const parsed = GitLabSessionCapabilityClaimsSchema.safeParse({
      purpose: CAPABILITY_PURPOSE,
      version,
      ...subject,
      issuedAt,
      expiresAt: issuedAt + getGitLabSessionCapabilityLifetimeMs(version),
    });
    if (!parsed.success) throw new GitLabSessionCapabilityError('invalid_capability');
    try {
      const prefix = bound ? BOUND_CAPABILITY_PREFIX : LEGACY_CAPABILITY_PREFIX;
      return `${prefix}${encryptWithSymmetricKey(JSON.stringify(parsed.data), this.encryptionKey)}`;
    } catch {
      throw new GitLabSessionCapabilityError('capability_configuration_error');
    }
  }

  decode(capability: string): GitLabSessionCapabilityClaims {
    const format = capability.startsWith(LEGACY_CAPABILITY_PREFIX)
      ? { prefix: LEGACY_CAPABILITY_PREFIX, version: 1 as const }
      : capability.startsWith(BOUND_CAPABILITY_PREFIX)
        ? { prefix: BOUND_CAPABILITY_PREFIX, version: 2 as const }
        : null;
    if (!format) throw new GitLabSessionCapabilityError('invalid_capability');

    const encrypted = capability.slice(format.prefix.length);
    if (!hasCanonicalEncryptedValueFormat(encrypted)) {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }
    let serialized: string;
    try {
      serialized = decryptWithSymmetricKey(encrypted, this.encryptionKey);
    } catch {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }
    const parsed = GitLabSessionCapabilityClaimsSchema.safeParse(value);
    if (!parsed.success || parsed.data.version !== format.version) {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }
    if (parsed.data.expiresAt <= Date.now()) {
      throw new GitLabSessionCapabilityError('expired_capability');
    }
    return parsed.data;
  }
}
