import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { z } from 'zod';
import { hasCanonicalEncryptedValueFormat } from './github-session-capability.js';
import { GitLabProjectPathSchema, normalizeGitLabInstanceUrl } from './gitlab-url.js';
import { CURRENT_CAPABILITY_PREFIX } from '@kilocode/worker-utils/scm-capability-contract';
export { parseGitLabCloneUrl } from './gitlab-url.js';
export type { GitLabCloneUrlFailureReason, GitLabCloneUrlResult } from './gitlab-url.js';

const BOUND_CAPABILITY_PREFIX = CURRENT_CAPABILITY_PREFIX.gitlab;
const CAPABILITY_PURPOSE = 'gitlab_scm_session';
const MAX_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS = 4 * 60 * 60 * 1000;

/**
 * Operation policy for the first segment under a matching project. A listed
 * family answers the methods its policy allows; an unlisted family keeps every
 * method, so project-local CLI work keeps its project-wide breadth.
 */
const GITLAB_PROJECT_FAMILY_POLICY: Record<string, 'read-only' | 'refused'> = {
  access_tokens: 'refused',
  deploy_keys: 'refused',
  deploy_tokens: 'refused',
  job_token_scope: 'refused',
  secure_files: 'refused',
  triggers: 'refused',
  variables: 'refused',
  access_requests: 'read-only',
  approval_rules: 'read-only',
  approval_settings: 'read-only',
  custom_attributes: 'read-only',
  hooks: 'read-only',
  integrations: 'read-only',
  invitations: 'read-only',
  members: 'read-only',
  protected_branches: 'read-only',
  protected_environments: 'read-only',
  protected_tags: 'read-only',
  push_rule: 'read-only',
  remote_mirrors: 'read-only',
  runners: 'read-only',
  services: 'read-only',
  share: 'read-only',
  archive: 'read-only',
  export: 'read-only',
  fork: 'read-only',
  housekeeping: 'read-only',
  restore: 'read-only',
  transfer: 'read-only',
  unarchive: 'read-only',
};

const GITLAB_PROJECT_READ_METHODS: readonly string[] = ['GET', 'HEAD'];

const GitLabSessionIdentitySchema = z
  .object({
    accountId: z.string().min(1).nullable(),
    accountLogin: z.string().min(1).nullable(),
  })
  .strict()
  .refine(identity => identity.accountId !== null || identity.accountLogin !== null);
const GitLabProjectTokenDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitLabCredentialIdSchema = z.object({ credentialId: z.uuid() });
const GitLabCredentialFenceSchema = GitLabCredentialIdSchema.extend({
  credentialVersion: z.number().int().positive(),
});
const GitLabCapabilityCredentialSourceSchema = z.union([
  z.object({ type: z.literal('integration') }).strict(),
  GitLabCredentialIdSchema.extend({ type: z.literal('integration') }).strict(),
  GitLabCredentialFenceSchema.extend({ type: z.literal('integration') }).strict(),
  z
    .object({
      type: z.literal('project'),
      projectId: z.number().int().positive(),
      tokenDigest: GitLabProjectTokenDigestSchema,
    })
    .strict(),
  GitLabCredentialFenceSchema.extend({
    type: z.literal('project'),
    projectId: z.number().int().positive(),
  }).strict(),
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
const GitLabSessionCapabilityClaimsSchema = GitLabSessionCapabilityClaimsBaseSchema.extend({
  version: z.literal(2),
  outboundContainerId: z.string().min(1),
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
  outboundContainerId: string;
  orgId?: string;
  integrationId: string;
  instanceOrigin: string;
  projectPath: string;
  authType: GitLabAuthType;
  identity: GitLabSessionIdentity;
  source: GitLabCapabilityCredentialSource;
};
export type GitLabSessionCapabilityClaims = z.infer<typeof GitLabSessionCapabilityClaimsSchema>;

export function validateGitLabSessionCapabilityPath(
  requestMethod: string,
  pathname: string,
  session: Pick<GitLabSessionCapabilitySubject, 'projectPath' | 'source'>,
  basePath: string
): {
  failure: 'invalid_upstream_url' | 'invalid_upstream_request' | 'repository_mismatch' | null;
  authSurface: 'git' | 'api';
} {
  const method = requestMethod.toUpperCase();
  const repositoryPath = `${basePath}/${session.projectPath}.git`;
  const gitEndpoint =
    /^(?:info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/(?:objects\/batch|locks(?:\/verify|\/[^/]+\/unlock)?))$/;
  if (
    pathname.startsWith(`${repositoryPath}/`) &&
    gitEndpoint.test(pathname.slice(repositoryPath.length + 1))
  ) {
    return { failure: null, authSurface: 'git' };
  }
  if (
    /\.git\/(?:info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/(?:objects\/batch|locks(?:\/verify|\/[^/]+\/unlock)?))$/.test(
      pathname
    )
  ) {
    return { failure: 'repository_mismatch', authSurface: 'git' };
  }

  const projectApiPrefix = `${basePath}/api/v4/projects/`;
  if (pathname.startsWith(projectApiPrefix)) {
    const [projectSelector, ...remainingSegments] = pathname
      .slice(projectApiPrefix.length)
      .split('/');
    if (!projectSelector) return { failure: 'invalid_upstream_url', authSurface: 'api' };
    let decodedProjectSelector: string;
    let family: string;
    try {
      decodedProjectSelector = decodeURIComponent(projectSelector);
      // Keep only the first component of the family segment, without a format
      // suffix, which the upstream router strips before it selects a resource.
      const familySegment = decodeURIComponent(remainingSegments[0] ?? '');
      const familyComponent = familySegment.split(/[/\\]/)[0] ?? '';
      family = (familyComponent.split('.')[0] ?? '').toLowerCase();
    } catch {
      return { failure: 'invalid_upstream_url', authSurface: 'api' };
    }
    const selectorMatches =
      decodedProjectSelector === session.projectPath ||
      (session.source.type === 'project' &&
        decodedProjectSelector === String(session.source.projectId));
    if (!selectorMatches) return { failure: 'repository_mismatch', authSurface: 'api' };
    // The project root answers reads only.
    const policy =
      family === ''
        ? 'read-only'
        : Object.hasOwn(GITLAB_PROJECT_FAMILY_POLICY, family)
          ? GITLAB_PROJECT_FAMILY_POLICY[family]
          : undefined;
    return {
      failure:
        policy === 'refused' ||
        (policy === 'read-only' && !GITLAB_PROJECT_READ_METHODS.includes(method))
          ? 'invalid_upstream_request'
          : null,
      authSurface: 'api',
    };
  }
  const apiPrefix = `${basePath}/api/v4`;
  return {
    failure: 'invalid_upstream_request',
    authSurface:
      pathname === apiPrefix ||
      pathname.startsWith(`${apiPrefix}/`) ||
      pathname === `${basePath}/api/graphql`
        ? 'api'
        : 'git',
  };
}
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
    if (subject.outboundContainerId.length === 0) {
      throw new GitLabSessionCapabilityError('capability_configuration_error');
    }
    const issuedAt = Date.now();
    const parsed = GitLabSessionCapabilityClaimsSchema.safeParse({
      purpose: CAPABILITY_PURPOSE,
      version: 2,
      ...subject,
      issuedAt,
      expiresAt: issuedAt + MAX_GITLAB_SCM_SESSION_CAPABILITY_LIFETIME_MS,
    });
    if (!parsed.success) throw new GitLabSessionCapabilityError('invalid_capability');
    try {
      return `${BOUND_CAPABILITY_PREFIX}${encryptWithSymmetricKey(JSON.stringify(parsed.data), this.encryptionKey)}`;
    } catch {
      throw new GitLabSessionCapabilityError('capability_configuration_error');
    }
  }

  decode(capability: string): GitLabSessionCapabilityClaims {
    if (!capability.startsWith(BOUND_CAPABILITY_PREFIX)) {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }

    const encrypted = capability.slice(BOUND_CAPABILITY_PREFIX.length);
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
    if (!parsed.success) {
      throw new GitLabSessionCapabilityError('invalid_capability');
    }
    if (parsed.data.expiresAt <= Date.now()) {
      throw new GitLabSessionCapabilityError('expired_capability');
    }
    return parsed.data;
  }
}
