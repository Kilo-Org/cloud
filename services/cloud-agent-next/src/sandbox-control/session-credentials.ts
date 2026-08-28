import { containedKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import { getSandboxProvider, type SessionMetadata } from '../persistence/session-metadata.js';
import { type getOutboundContainerId, isValidSandboxId } from '../sandbox-id.js';
import { buildSessionAttachPayload } from '../sandbox-session/attach-payload.js';
import {
  issueCloudAgentBitbucketSessionCapability,
  issueCloudAgentGitHubSessionCapability,
  issueCloudAgentGitLabSessionCapability,
  issueCloudAgentKiloSessionCapability,
  resolveGitHubTokenForRepo,
} from '../services/git-token-service-client.js';
import { readProfileBundle } from '../session-profile.js';
import type { SessionAttachPayload } from '../shared/sandbox-control-protocol.js';
import { parseCanonicalBitbucketCloneUrl, sessionIdSchema, type Env } from '../types.js';
import { createControlPlaneCredential, parseControlPlaneCredential } from './managed-credential.js';
import {
  buildKiloCredentialInjectionRules,
  buildVercelCredentialNetworkPolicy,
  findMatchingCredentialInjectionRule,
} from './vercel-network-policy.js';

const WORKTREE_LEASE_MS = 4 * 60 * 60 * 1000;
const CAPABILITY_CACHE_MS = 3 * 60 * 60 * 1000;
const timestampSchema = z.number().int().nonnegative();
const tokenSchema = z
  .string()
  .min(1)
  .max(64 * 1024)
  .regex(/^\S+$/)
  .refine(value => !hasControlCharacters(value));
const realTokenSchema = tokenSchema.refine(token => !/^(?:kcp|kka|kgh|kgl|kbb)\d+\./.test(token));
const scopeIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const organizationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const memberSchema = z
  .object({
    sessionId: sessionIdSchema.refine(id => id.startsWith('workspace_')),
    kiloSessionId: containedKiloSessionIdSchema,
  })
  .strict();
const targetsSchema = z
  .object({
    backendBaseUrl: z.string().url(),
    providerBaseUrl: z.string().url(),
    sessionIngestBaseUrl: z.string().url(),
  })
  .strict();
const capabilitySchema = z
  .object({
    credential: tokenSchema.regex(/^(?:kka1|kgh2|kgl2|kbb1)\./),
    outboundContainerId: z.string().min(1),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .refine(value => value.expiresAt > value.issuedAt)
  .refine(value => value.expiresAt - value.issuedAt <= CAPABILITY_CACHE_MS);
const repositorySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('github'),
      repo: z.string().min(1),
      authentication: z.enum(['managed', 'explicit']),
      expectedIntegrationId: z.string().uuid().optional(),
      allowUserAuthorization: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('gitlab'),
      url: z.string().url(),
      createdOnPlatform: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('bitbucket'),
      url: z.string().url(),
      workspaceUuid: z.string().uuid(),
      repositoryUuid: z.string().uuid(),
      expectedIntegrationId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('git'),
      url: z.string().url(),
      platform: z.enum(['github', 'gitlab']).optional(),
    })
    .strict(),
]);
const scmSchema = z
  .object({
    purpose: z.enum(['github', 'gitlab', 'bitbucket']),
    alias: tokenSchema,
    gitUrl: z.string().url(),
    capability: capabilitySchema.optional(),
    nativeToken: realTokenSchema.optional(),
    gitlab: z
      .object({
        instanceOrigin: z.string().url(),
        instanceHost: z.string().min(1),
        projectPath: z.string().min(1),
        integrationId: z.string().min(1),
        authType: z.enum(['oauth', 'pat']),
        identity: z
          .object({ accountId: z.string().nullable(), accountLogin: z.string().nullable() })
          .strict(),
        glabIsOAuth2: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sessionCredentialGrantSchema = z
  .object({
    version: z.literal(1),
    scopeId: scopeIdSchema,
    sandboxId: z
      .string()
      .refine(isValidSandboxId)
      .refine(id => !id.startsWith('dind-')),
    directory: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        directory =>
          directory.startsWith('/') &&
          !directory.includes('\\') &&
          !hasControlCharacters(directory) &&
          directory
            .split('/')
            .slice(1)
            .every(part => part !== '' && part !== '.' && part !== '..')
      ),
    userId: z.string().min(1),
    orgId: organizationIdSchema.optional(),
    provider: z.enum(['cloudflare', 'vercel']),
    outboundContainerId: z.string().min(1).optional(),
    members: z.array(memberSchema).min(1),
    repository: repositorySchema.optional(),
    kilo: z
      .object({
        alias: tokenSchema,
        token: realTokenSchema,
        targets: targetsSchema,
        capabilities: z.record(z.string(), capabilitySchema),
      })
      .strict(),
    scm: scmSchema.optional(),
    preparedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((grant, context) => {
    const reject = () => context.addIssue({ code: 'custom', message: 'Invalid credential grant' });
    if (
      grant.expiresAt <= grant.preparedAt ||
      grant.expiresAt - grant.preparedAt > WORKTREE_LEASE_MS ||
      new Set(grant.members.map(member => member.sessionId)).size !== grant.members.length ||
      new Set(grant.members.map(member => member.kiloSessionId)).size !== grant.members.length ||
      (grant.provider === 'cloudflare' && !grant.outboundContainerId)
    ) {
      reject();
    }
    const kiloAlias = parseControlPlaneCredential(grant.kilo.alias);
    if (kiloAlias?.sandboxId !== grant.sandboxId || kiloAlias.purpose !== 'kilo') reject();
    const targets = deriveKiloSandboxTargets(
      {
        KILOCODE_BACKEND_BASE_URL: grant.kilo.targets.backendBaseUrl,
        KILO_OPENROUTER_BASE: grant.kilo.targets.providerBaseUrl,
        KILO_SESSION_INGEST_URL: grant.kilo.targets.sessionIngestBaseUrl,
      },
      grant.kilo.token,
      { requireHttps: grant.provider === 'vercel' }
    );
    if (
      !targets.success ||
      JSON.stringify(targets.targets) !== JSON.stringify(grant.kilo.targets)
    ) {
      reject();
    }
    for (const [sessionId, capability] of Object.entries(grant.kilo.capabilities)) {
      if (
        !grant.members.some(member => member.sessionId === sessionId) ||
        !capability.credential.startsWith('kka1.') ||
        grant.provider !== 'cloudflare'
      ) {
        reject();
      }
    }
    if (grant.repository && grant.repository.type !== 'git') {
      if (grant.scm?.purpose !== grant.repository.type) reject();
    } else if (grant.scm) {
      reject();
    }
    if (!grant.scm) return;
    const alias = parseControlPlaneCredential(grant.scm.alias);
    if (alias?.sandboxId !== grant.sandboxId || alias.purpose !== grant.scm.purpose) reject();
    if (grant.provider === 'vercel') {
      if (
        grant.scm.purpose !== 'github' ||
        !grant.scm.nativeToken ||
        grant.scm.capability ||
        grant.scm.gitlab
      ) {
        reject();
      }
    } else {
      const prefixes = { github: 'kgh2.', gitlab: 'kgl2.', bitbucket: 'kbb1.' };
      if (
        grant.scm.nativeToken ||
        !grant.scm.capability?.credential.startsWith(prefixes[grant.scm.purpose]) ||
        (grant.scm.purpose === 'gitlab') !== (grant.scm.gitlab !== undefined)
      ) {
        reject();
      }
    }
  });

export type SessionCredentialGrant = z.infer<typeof sessionCredentialGrantSchema>;
type CredentialMember = z.infer<typeof memberSchema>;
type CredentialRepository = z.infer<typeof repositorySchema>;
type ScmGrant = z.infer<typeof scmSchema>;
type CachedCapability = z.infer<typeof capabilitySchema>;
type CredentialEnv = Parameters<typeof getOutboundContainerId>[0] &
  Partial<Pick<Env, 'GIT_TOKEN_SERVICE'>> &
  KiloTargetEnv;

type PreparedSessionAttachPayload = SessionAttachPayload & {
  kilo: NonNullable<SessionAttachPayload['kilo']>;
};

function invalidCredentials(): never {
  throw new Error('Invalid contained worktree credentials');
}

function validateGrant(value: unknown): SessionCredentialGrant {
  const parsed = sessionCredentialGrantSchema.safeParse(value);
  if (!parsed.success) invalidCredentials();
  return parsed.data;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function safeUrl(value: string): URL | null {
  if (value.includes('\\') || /\s/.test(value) || hasControlCharacters(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || /^\w+:\/\/[^/]*@/.test(value)) return null;
    return url;
  } catch {
    return null;
  }
}

function canonicalRepositoryUrl(value: string, managed = false): string {
  const url = safeUrl(value);
  if (!url || url.protocol !== 'https:' || url.search) invalidCredentials();
  if (managed) {
    const rawPath = /^https:\/\/[^/]+(\/.*)?$/i.exec(value)?.[1] ?? '/';
    if (/%|\/\.{1,2}(?:\/|$)|\/\//.test(rawPath)) invalidCredentials();
    const path = url.pathname.replace(/\.git$/, '').slice(1);
    if (
      path.split('/').length < 2 ||
      path.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
    ) {
      invalidCredentials();
    }
    url.pathname = `/${path}.git`;
  }
  return url.toString();
}

function isKnownScmCredential(token: string | undefined, scm: ScmGrant | undefined): boolean {
  return (
    token !== undefined &&
    scm !== undefined &&
    (token === scm.alias || token === scm.capability?.credential || token === scm.nativeToken)
  );
}

function repositoryFromMetadata(
  metadata: SessionMetadata,
  provider: SessionCredentialGrant['provider'],
  existing: SessionCredentialGrant | undefined
): CredentialRepository | undefined {
  const repository = metadata.repository;
  if (!repository) return undefined;
  if (repository.type === 'github') {
    if (
      repository.repo.split('/').length !== 2 ||
      repository.repo
        .split('/')
        .some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
    ) {
      invalidCredentials();
    }
    const explicit =
      Boolean(repository.token) && !isKnownScmCredential(repository.token, existing?.scm);
    if (provider === 'cloudflare' && explicit) invalidCredentials();
    return {
      type: 'github',
      repo: repository.repo,
      authentication:
        existing?.repository?.type === 'github' &&
        isKnownScmCredential(repository.token, existing.scm)
          ? existing.repository.authentication
          : explicit
            ? 'explicit'
            : 'managed',
      ...(repository.githubIntegrationId
        ? { expectedIntegrationId: repository.githubIntegrationId }
        : {}),
      allowUserAuthorization:
        metadata.identity.createdOnPlatform === 'cloud-agent-web' ||
        metadata.identity.createdOnPlatform === 'slack',
    };
  }
  const url = canonicalRepositoryUrl(repository.url, repository.type !== 'git');
  if (repository.type === 'git') {
    if (repository.token) invalidCredentials();
    return { type: 'git', url, ...(repository.platform ? { platform: repository.platform } : {}) };
  }
  if (provider === 'vercel') invalidCredentials();
  if (repository.type === 'gitlab') {
    if (
      repository.token &&
      repository.gitlabTokenManaged !== true &&
      !isKnownScmCredential(repository.token, existing?.scm)
    ) {
      invalidCredentials();
    }
    return {
      type: 'gitlab',
      url,
      ...(metadata.identity.createdOnPlatform
        ? { createdOnPlatform: metadata.identity.createdOnPlatform }
        : {}),
    };
  }
  if (!metadata.identity.orgId || !parseCanonicalBitbucketCloneUrl(url)) invalidCredentials();
  return {
    type: 'bitbucket',
    url,
    workspaceUuid: repository.workspaceUuid.toLowerCase(),
    repositoryUuid: repository.repositoryUuid.toLowerCase(),
    ...(repository.bitbucketIntegrationId
      ? { expectedIntegrationId: repository.bitbucketIntegrationId }
      : {}),
  };
}

function cachedCapability(
  credential: string,
  prefix: string,
  outboundContainerId: string,
  now: number
): CachedCapability {
  if (!tokenSchema.safeParse(credential).success || !credential.startsWith(prefix)) {
    invalidCredentials();
  }
  return { credential, outboundContainerId, issuedAt: now, expiresAt: now + CAPABILITY_CACHE_MS };
}

function isCapabilityCurrent(
  capability: CachedCapability | undefined,
  outboundContainerId: string,
  now: number
): capability is CachedCapability {
  return (
    capability !== undefined &&
    capability.outboundContainerId === outboundContainerId &&
    capability.issuedAt <= now &&
    now < capability.expiresAt
  );
}

async function refreshKiloCapability(
  env: CredentialEnv,
  grant: SessionCredentialGrant,
  member: CredentialMember,
  outboundContainerId: string,
  now: number
): Promise<SessionCredentialGrant> {
  if (isCapabilityCurrent(grant.kilo.capabilities[member.sessionId], outboundContainerId, now)) {
    return grant;
  }
  const issued = await issueCloudAgentKiloSessionCapability(env, {
    userId: grant.userId,
    cloudAgentSessionId: member.sessionId,
    kiloSessionId: member.kiloSessionId,
    outboundContainerId,
    userToken: grant.kilo.token,
    targets: grant.kilo.targets,
  });
  if (!issued.success) throw new Error('Kilo capability issuance is unavailable');
  return {
    ...grant,
    kilo: {
      ...grant.kilo,
      capabilities: {
        ...grant.kilo.capabilities,
        [member.sessionId]: cachedCapability(
          issued.value.capability,
          'kka1.',
          outboundContainerId,
          now
        ),
      },
    },
  };
}

async function refreshScmCapability(
  env: CredentialEnv,
  grant: SessionCredentialGrant,
  outboundContainerId: string,
  now: number
): Promise<SessionCredentialGrant> {
  const repository = grant.repository;
  if (!repository || repository.type === 'git') return grant;
  if (isCapabilityCurrent(grant.scm?.capability, outboundContainerId, now)) return grant;
  const common = {
    userId: grant.userId,
    ...(grant.orgId ? { orgId: grant.orgId } : {}),
    outboundContainerId,
  };
  const alias = grant.scm?.alias ?? createControlPlaneCredential(grant.sandboxId, repository.type);
  let scm: ScmGrant;
  if (repository.type === 'github') {
    const issued = await issueCloudAgentGitHubSessionCapability(env, {
      ...common,
      githubRepo: repository.repo,
      allowUserAuthorization: repository.allowUserAuthorization,
      ...(repository.expectedIntegrationId
        ? { expectedIntegrationId: repository.expectedIntegrationId }
        : {}),
    });
    if (!issued.success || !('capability' in issued.value)) {
      throw new Error('GitHub capability issuance is unavailable');
    }
    scm = {
      purpose: 'github',
      alias,
      gitUrl: `https://github.com/${repository.repo}.git`,
      capability: cachedCapability(issued.value.capability, 'kgh2.', outboundContainerId, now),
    };
  } else if (repository.type === 'gitlab') {
    const issued = await issueCloudAgentGitLabSessionCapability(env, {
      ...common,
      gitUrl: repository.url,
      ...(repository.createdOnPlatform ? { createdOnPlatform: repository.createdOnPlatform } : {}),
    });
    if (!issued.success) throw new Error('GitLab capability issuance is unavailable');
    const { capability, gitUrl, ...gitlab } = issued.value;
    if (
      canonicalRepositoryUrl(gitUrl, true) !== repository.url ||
      (grant.scm?.gitlab && JSON.stringify(grant.scm.gitlab) !== JSON.stringify(gitlab))
    ) {
      invalidCredentials();
    }
    scm = {
      purpose: 'gitlab',
      alias,
      gitUrl,
      gitlab,
      capability: cachedCapability(capability, 'kgl2.', outboundContainerId, now),
    };
  } else {
    if (!grant.orgId) invalidCredentials();
    const issued = await issueCloudAgentBitbucketSessionCapability(env, {
      ...common,
      orgId: grant.orgId,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
      repositoryUrl: repository.url,
      ...(repository.expectedIntegrationId
        ? { expectedIntegrationId: repository.expectedIntegrationId }
        : {}),
    });
    if (!issued.success) throw new Error('Bitbucket capability issuance is unavailable');
    const gitUrl = canonicalRepositoryUrl(issued.value.gitUrl, true);
    if (!parseCanonicalBitbucketCloneUrl(gitUrl)) invalidCredentials();
    scm = {
      purpose: 'bitbucket',
      alias,
      gitUrl,
      capability: cachedCapability(issued.value.capability, 'kbb1.', outboundContainerId, now),
    };
  }
  return { ...grant, scm };
}

function sanitizedPayload(
  metadata: SessionMetadata,
  payload: SessionAttachPayload,
  grant: SessionCredentialGrant,
  existing: SessionCredentialGrant | undefined
): PreparedSessionAttachPayload {
  const replacements: Array<[string, string]> = [[grant.kilo.token, grant.kilo.alias]];
  if (existing) replacements.push([existing.kilo.token, grant.kilo.alias]);
  for (const capability of Object.values(grant.kilo.capabilities)) {
    replacements.push([capability.credential, grant.kilo.alias]);
  }
  if (grant.scm) {
    const repositoryToken =
      metadata.repository && 'token' in metadata.repository ? metadata.repository.token : undefined;
    for (const token of [
      repositoryToken,
      grant.scm.nativeToken,
      grant.scm.capability?.credential,
      existing?.scm?.nativeToken,
      existing?.scm?.capability?.credential,
    ]) {
      if (token) replacements.push([token, grant.scm.alias]);
    }
  }
  const sanitize = (value: string) =>
    replacements.reduce((result, [token, alias]) => result.replaceAll(token, alias), value);
  const profile = readProfileBundle(metadata);
  const env = Object.fromEntries(
    Object.entries({ ...profile.envVars, ...payload.env }).map(([key, value]) => [
      key,
      key === 'GH_TOKEN' || key === 'GITHUB_TOKEN'
        ? (replacements.find(([token]) => token === value)?.[1] ?? value)
        : sanitize(value),
    ])
  );
  env.KILOCODE_TOKEN = grant.kilo.alias;
  if (grant.scm?.purpose === 'github') {
    if (env.GITHUB_TOKEN && env.GH_TOKEN === undefined) env.GH_TOKEN = env.GITHUB_TOKEN;
    env.GH_TOKEN ??= grant.scm.alias;
  } else if (grant.scm?.purpose === 'gitlab') {
    const gitlab = grant.scm.gitlab;
    if (!gitlab) invalidCredentials();
    env.GITLAB_TOKEN ??= grant.scm.alias;
    if (env.GITLAB_TOKEN === grant.scm.alias) {
      env.GLAB_IS_OAUTH2 = gitlab.glabIsOAuth2 ? 'true' : 'false';
      env.GITLAB_HOST = gitlab.instanceHost;
      env.GITLAB_SUBFOLDER = new URL(gitlab.instanceOrigin).pathname.replace(/^\/+|\/+$/g, '');
    }
  } else if (grant.scm?.purpose === 'bitbucket') {
    const repository = grant.repository;
    const canonical = parseCanonicalBitbucketCloneUrl(grant.scm.gitUrl);
    if (repository?.type !== 'bitbucket' || !canonical) invalidCredentials();
    env.BITBUCKET_TOKEN = grant.scm.alias;
    env.KILO_BITBUCKET_WORKSPACE_SLUG = canonical.workspaceSlug;
    env.KILO_BITBUCKET_REPOSITORY_SLUG = canonical.repositorySlug;
    env.KILO_BITBUCKET_WORKSPACE_UUID = `{${repository.workspaceUuid}}`;
    env.KILO_BITBUCKET_REPOSITORY_UUID = `{${repository.repositoryUuid}}`;
  }
  return {
    ...payload,
    directory: grant.directory,
    env,
    ...(grant.scm
      ? { git: { url: grant.scm.gitUrl, platform: grant.scm.purpose, token: grant.scm.alias } }
      : grant.repository?.type === 'git'
        ? {
            git: {
              url: grant.repository.url,
              ...(grant.repository.platform ? { platform: grant.repository.platform } : {}),
            },
          }
        : {}),
    ...(payload.setupCommands ? { setupCommands: payload.setupCommands.map(sanitize) } : {}),
    kilo: { scopeId: grant.scopeId, token: grant.kilo.alias, targets: grant.kilo.targets },
  };
}

export async function prepareSessionCredentials(input: {
  env: CredentialEnv;
  metadata: SessionMetadata;
  sandboxId: string;
  outboundContainerId?: string;
  existing?: SessionCredentialGrant;
  now?: number;
}): Promise<{ grant: SessionCredentialGrant; payload: PreparedSessionAttachPayload }> {
  const { env, metadata, sandboxId } = input;
  const now = input.now ?? Date.now();
  if (!timestampSchema.safeParse(now).success) invalidCredentials();
  if (
    metadata.workspace?.sandboxId !== sandboxId ||
    sandboxId.startsWith('dind-') ||
    metadata.workspace?.devcontainerRequested ||
    metadata.devcontainer
  ) {
    invalidCredentials();
  }
  const member = memberSchema.safeParse({
    sessionId: metadata.identity.sessionId,
    kiloSessionId: metadata.auth.kiloSessionId,
  });
  const token = realTokenSchema.safeParse(metadata.auth.kilocodeToken);
  if (!member.success || !token.success) invalidCredentials();
  const provider = getSandboxProvider(metadata);
  const targets = deriveKiloSandboxTargets(env, token.data, {
    requireHttps: provider === 'vercel',
  });
  if (!targets.success) invalidCredentials();
  const existing = input.existing === undefined ? undefined : validateGrant(input.existing);
  const payload = buildSessionAttachPayload(metadata);
  const scopeId = scopeIdSchema.safeParse(
    metadata.workspace?.worktreeId ?? metadata.identity.sessionId
  );
  if (!scopeId.success || !payload.directory) invalidCredentials();
  const repository = repositoryFromMetadata(metadata, provider, existing);
  if (
    existing &&
    (existing.scopeId !== scopeId.data ||
      existing.directory !== payload.directory ||
      existing.sandboxId !== sandboxId ||
      existing.userId !== metadata.identity.userId ||
      existing.orgId !== metadata.identity.orgId ||
      existing.provider !== provider ||
      existing.outboundContainerId !== input.outboundContainerId ||
      existing.preparedAt > now ||
      JSON.stringify(existing.kilo.targets) !== JSON.stringify(targets.targets) ||
      JSON.stringify(existing.repository) !== JSON.stringify(repository))
  ) {
    invalidCredentials();
  }
  const members = existing?.members ?? [];
  if (
    members.some(
      current =>
        (current.sessionId === member.data.sessionId &&
          current.kiloSessionId !== member.data.kiloSessionId) ||
        (current.kiloSessionId === member.data.kiloSessionId &&
          current.sessionId !== member.data.sessionId)
    )
  ) {
    invalidCredentials();
  }
  let grant: SessionCredentialGrant = {
    version: 1,
    scopeId: scopeId.data,
    directory: payload.directory,
    sandboxId,
    userId: metadata.identity.userId,
    ...(metadata.identity.orgId === undefined ? {} : { orgId: metadata.identity.orgId }),
    provider,
    ...(input.outboundContainerId ? { outboundContainerId: input.outboundContainerId } : {}),
    members: members.some(current => current.sessionId === member.data.sessionId)
      ? [...members]
      : [...members, member.data],
    ...(repository ? { repository } : {}),
    kilo: {
      alias: existing?.kilo.alias ?? createControlPlaneCredential(sandboxId, 'kilo'),
      token: token.data,
      targets: targets.targets,
      capabilities: existing?.kilo.token === token.data ? existing.kilo.capabilities : {},
    },
    ...(existing?.scm ? { scm: existing.scm } : {}),
    preparedAt: now,
    expiresAt: now + WORKTREE_LEASE_MS,
  };
  if (provider === 'cloudflare') {
    const outboundContainerId = input.outboundContainerId;
    if (!outboundContainerId) invalidCredentials();
    grant = await refreshKiloCapability(env, grant, member.data, outboundContainerId, now);
    grant = await refreshScmCapability(env, grant, outboundContainerId, now);
  } else if (repository?.type === 'github') {
    let nativeToken = payload.git?.token;
    if (repository.authentication === 'managed') {
      const resolved = await resolveGitHubTokenForRepo(env, {
        githubRepo: repository.repo,
        userId: grant.userId,
        ...(grant.orgId ? { orgId: grant.orgId } : {}),
        ...(repository.expectedIntegrationId
          ? { expectedIntegrationId: repository.expectedIntegrationId }
          : {}),
      });
      if (!resolved.success) throw new Error('GitHub credential is unavailable');
      nativeToken = resolved.value.token;
    }
    if (!nativeToken) invalidCredentials();
    grant = {
      ...grant,
      scm: {
        purpose: 'github',
        alias: existing?.scm?.alias ?? createControlPlaneCredential(sandboxId, 'github'),
        gitUrl: `https://github.com/${repository.repo}.git`,
        nativeToken,
      },
    };
  }
  grant = validateGrant(grant);
  if (provider === 'vercel') buildControlNetworkPolicy([grant]);
  else {
    buildKiloCredentialInjectionRules(
      {
        token: grant.kilo.token,
        placeholder: grant.kilo.alias,
        targets: grant.kilo.targets,
        rootSessionIds: grant.members.map(current => current.kiloSessionId),
        organizationId: grant.orgId,
      },
      { requireHttps: false }
    );
  }
  return { grant, payload: sanitizedPayload(metadata, payload, grant, existing) };
}

export function removeSessionCredentialMembership(
  grants: readonly SessionCredentialGrant[],
  sessionId: string
): SessionCredentialGrant[] {
  return grants.flatMap(grant => {
    const members = grant.members.filter(member => member.sessionId !== sessionId);
    if (members.length === grant.members.length) return [grant];
    if (members.length === 0) return [];
    return [
      {
        ...grant,
        members,
        kilo: {
          ...grant.kilo,
          capabilities: Object.fromEntries(
            Object.entries(grant.kilo.capabilities).filter(([id]) => id !== sessionId)
          ),
        },
      },
    ];
  });
}

export function buildControlNetworkPolicy(
  grants: readonly SessionCredentialGrant[]
): VercelSandboxNetworkPolicy {
  const policies = grants.map(value => {
    const grant = validateGrant(value);
    if (grant.provider !== 'vercel' || grant.sandboxId !== grants[0]?.sandboxId)
      invalidCredentials();
    return buildVercelCredentialNetworkPolicy({
      kilo: {
        token: grant.kilo.token,
        placeholder: grant.kilo.alias,
        targets: grant.kilo.targets,
        rootSessionIds: grant.members.map(member => member.kiloSessionId),
        organizationId: grant.orgId,
      },
      ...(grant.repository?.type === 'github' && grant.scm?.nativeToken
        ? {
            github: {
              token: grant.scm.nativeToken,
              placeholder: grant.scm.alias,
              repository: grant.repository.repo,
            },
          }
        : {}),
    });
  });
  const aliases = grants.flatMap(grant => [
    grant.kilo.alias,
    ...(grant.scm ? [grant.scm.alias] : []),
  ]);
  if (new Set(aliases).size !== aliases.length) invalidCredentials();
  const injectionRules = policies.flatMap(policy => policy.injectionRules);
  return {
    mode: 'custom',
    allowedDomains: [...new Set(injectionRules.map(rule => rule.domain)), '*'],
    injectionRules,
  };
}

export async function resolveSessionCredential(input: {
  env: CredentialEnv;
  grant: SessionCredentialGrant;
  credential: string;
  url: string;
  method: string;
  outboundContainerId: string;
  now?: number;
}): Promise<{ grant: SessionCredentialGrant; credential: string; organizationId?: string } | null> {
  const now = input.now ?? Date.now();
  const parsed = sessionCredentialGrantSchema.safeParse(input.grant);
  if (!parsed.success || !timestampSchema.safeParse(now).success) return null;
  let grant = parsed.data;
  const alias = parseControlPlaneCredential(input.credential);
  if (
    grant.provider !== 'cloudflare' ||
    now < grant.preparedAt ||
    now >= grant.expiresAt ||
    alias?.sandboxId !== grant.sandboxId ||
    input.outboundContainerId !== grant.outboundContainerId
  ) {
    return null;
  }
  const expected = alias.purpose === 'kilo' ? grant.kilo.alias : grant.scm?.alias;
  if (
    input.credential !== expected ||
    (alias.purpose !== 'kilo' && alias.purpose !== grant.scm?.purpose)
  ) {
    return null;
  }
  const url = safeUrl(input.url);
  if (!url) return null;
  try {
    if (alias.purpose !== 'kilo') {
      if (url.protocol !== 'https:') return null;
      grant = await refreshScmCapability(input.env, grant, input.outboundContainerId, now);
      return grant.scm?.capability ? { grant, credential: grant.scm.capability.credential } : null;
    }
    if (!Object.values(grant.kilo.targets).some(target => new URL(target).origin === url.origin)) {
      return null;
    }
    const rules = buildKiloCredentialInjectionRules(
      {
        token: grant.kilo.token,
        placeholder: grant.kilo.alias,
        targets: grant.kilo.targets,
        rootSessionIds: grant.members.map(member => member.kiloSessionId),
        organizationId: grant.orgId,
      },
      { requireHttps: false }
    );
    const rule = findMatchingCredentialInjectionRule(rules, {
      url,
      method: input.method,
      headers: new Headers({ authorization: `Bearer ${input.credential}` }),
    });
    if (
      rule?.headers.authorization !== `Bearer ${grant.kilo.token}` ||
      rule.headers.host !== url.host
    ) {
      return null;
    }
    const ingest = new URL(grant.kilo.targets.sessionIngestBaseUrl);
    const member =
      grant.members.find(
        current =>
          url.origin === ingest.origin &&
          (url.pathname ===
            `${ingest.pathname.replace(/\/+$/, '')}/api/session/${current.kiloSessionId}/export` ||
            url.pathname ===
              `${ingest.pathname.replace(/\/+$/, '')}/api/session/${current.kiloSessionId}/ingest`)
      ) ?? grant.members[0];
    if (!member) return null;
    grant = await refreshKiloCapability(input.env, grant, member, input.outboundContainerId, now);
    const capability = grant.kilo.capabilities[member.sessionId];
    return capability
      ? {
          grant,
          credential: capability.credential,
          ...(grant.orgId ? { organizationId: grant.orgId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
