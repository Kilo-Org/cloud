import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { z } from 'zod';
import { hasCanonicalEncryptedValueFormat } from './github-session-capability.js';

const CAPABILITY_PREFIX = 'kgl1.';
const CAPABILITY_PURPOSE = 'gitlab_scm_session';
const CAPABILITY_VERSION = 1;
const MAX_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS = 60 * 60 * 1000;
const GitLabProjectPathSchema = z
  .string()
  .min(3)
  .refine(path => path.split('/').length >= 2)
  .refine(path => path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part)))
  .refine(path => path.split('/').every(part => part !== '.' && part !== '..'));
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
const GitLabSessionCapabilityClaimsSchema = z
  .object({
    purpose: z.literal(CAPABILITY_PURPOSE),
    version: z.literal(CAPABILITY_VERSION),
    userId: z.string().min(1),
    orgId: z.string().uuid().optional(),
    integrationId: z.string().uuid(),
    instanceOrigin: z.string().url().refine(isCanonicalGitLabInstanceOrigin),
    projectPath: GitLabProjectPathSchema,
    authType: z.enum(['oauth', 'pat']),
    identity: GitLabSessionIdentitySchema,
    source: GitLabCapabilityCredentialSourceSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine(claims => claims.expiresAt > claims.issuedAt)
  .refine(
    claims => claims.expiresAt - claims.issuedAt <= MAX_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS
  );

export type GitLabAuthType = 'oauth' | 'pat';
export type GitLabSessionIdentity = z.infer<typeof GitLabSessionIdentitySchema>;
export type GitLabCapabilityCredentialSource = z.infer<
  typeof GitLabCapabilityCredentialSourceSchema
>;
export type GitLabSessionCapabilitySubject = {
  userId: string;
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
export type GitLabCloneUrlFailureReason = 'invalid_gitlab_url' | 'unsupported_gitlab_instance';
export type GitLabCloneUrlResult =
  | {
      success: true;
      instanceOrigin: string;
      instanceHost: string;
      projectPath: string;
    }
  | { success: false; reason: GitLabCloneUrlFailureReason };

export class GitLabSessionCapabilityError extends Error {
  constructor(readonly reason: GitLabSessionCapabilityFailureReason) {
    super(reason);
    this.name = 'GitLabSessionCapabilityError';
  }
}

export function normalizeGitLabInstanceOrigin(instanceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    return null;
  }
  return url.origin;
}

function isCanonicalGitLabInstanceOrigin(instanceOrigin: string): boolean {
  return normalizeGitLabInstanceOrigin(instanceOrigin) === instanceOrigin;
}

function normalizeProjectPath(pathname: string): string | null {
  if (/%2f|%5c/i.test(pathname)) return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes('\\')) return null;
  const rawParts = decodedPath.split('/');
  if (rawParts[0] !== '' || rawParts.some((part, index) => index > 0 && part === '')) return null;
  const parts = rawParts.slice(1);
  if (parts.length < 2) return null;
  const terminal = parts.at(-1);
  if (!terminal) return null;
  if (terminal.endsWith('.git')) parts[parts.length - 1] = terminal.slice(0, -4);
  const projectPath = parts.join('/');
  return GitLabProjectPathSchema.safeParse(projectPath).success ? projectPath : null;
}

export function parseGitLabCloneUrl(gitUrl: string, instanceUrl?: string): GitLabCloneUrlResult {
  if (/\/(?:(?:\.|%2e){1,2})(?:\/|$)/i.test(gitUrl)) {
    return { success: false, reason: 'invalid_gitlab_url' };
  }
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    return { success: false, reason: 'invalid_gitlab_url' };
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return { success: false, reason: 'invalid_gitlab_url' };
  }
  const instanceOrigin = normalizeGitLabInstanceOrigin(instanceUrl ?? 'https://gitlab.com');
  if (!instanceOrigin || instanceOrigin !== url.origin) {
    return { success: false, reason: 'unsupported_gitlab_instance' };
  }
  const projectPath = normalizeProjectPath(url.pathname);
  if (!projectPath) return { success: false, reason: 'invalid_gitlab_url' };
  return {
    success: true,
    instanceOrigin,
    instanceHost: url.hostname,
    projectPath,
  };
}

export async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class GitLabSessionCapabilityCodec {
  constructor(private readonly encryptionKey: string) {}

  issue(subject: GitLabSessionCapabilitySubject): string {
    const issuedAt = Date.now();
    const parsed = GitLabSessionCapabilityClaimsSchema.safeParse({
      purpose: CAPABILITY_PURPOSE,
      version: CAPABILITY_VERSION,
      ...subject,
      issuedAt,
      expiresAt: issuedAt + MAX_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS,
    });
    if (!parsed.success) throw new GitLabSessionCapabilityError('invalid_capability');
    try {
      return `${CAPABILITY_PREFIX}${encryptWithSymmetricKey(
        JSON.stringify(parsed.data),
        this.encryptionKey
      )}`;
    } catch {
      throw new GitLabSessionCapabilityError('capability_configuration_error');
    }
  }

  decode(capability: string): GitLabSessionCapabilityClaims {
    if (!capability.startsWith(CAPABILITY_PREFIX)) {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }
    const encrypted = capability.slice(CAPABILITY_PREFIX.length);
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
    if (!parsed.success) throw new GitLabSessionCapabilityError('invalid_capability');
    if (parsed.data.expiresAt <= Date.now()) {
      throw new GitLabSessionCapabilityError('expired_capability');
    }
    return parsed.data;
  }
}
