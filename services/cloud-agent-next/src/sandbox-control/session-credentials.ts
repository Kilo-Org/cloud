import { containedKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { kiloTokenPayload } from '@kilocode/worker-utils/kilo-token';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { resolveSecret } from '../auth.js';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import {
  getSandboxProvider,
  requiresContainmentSandbox,
  type SessionMetadata,
} from '../persistence/session-metadata.js';
import { providerUsesOutboundCredentialProxy } from '../agent-sandbox/capabilities.js';
import { type getOutboundContainerId, isValidSandboxId } from '../sandbox-id.js';
import { buildSessionAttachPayload } from '../sandbox-session/attach-payload.js';
import {
  issueCloudAgentBitbucketSessionCapability,
  issueCloudAgentGitHubSessionCapability,
  issueCloudAgentGitLabSessionCapability,
  issueCloudAgentKiloSessionCapability,
  authorizeCloudAgentGitHubRepo,
  resolveCloudAgentGitHubAuthForRepo,
  resolveManagedGitLabToken,
  resolveManagedBitbucketToken,
} from '../services/git-token-service-client.js';
import { readProfileBundle } from '../session-profile.js';
import { runtimeCredentialProxyFacadeBaseUrl } from '../runtime-credential-proxy.js';
import type {
  ControlPlaneCredentialRepository,
  ControlPlaneCredentialSource,
} from '../shared/control-plane-protocol.js';
import type { SessionAttachPayload } from '../shared/sandbox-control-protocol.js';
import { gitAuthorSchema } from '../shared/sandbox-control-protocol.js';
import {
  agentSandboxProviderSchema,
  parseCanonicalBitbucketCloneUrl,
  sessionIdSchema,
  type AgentSandboxProvider,
  type Env,
} from '../types.js';
import { createControlPlaneCredential, parseControlPlaneCredential } from './managed-credential.js';
import {
  buildKiloCredentialInjectionRules,
  buildVercelCredentialNetworkPolicy,
  findMatchingCredentialInjectionRule,
} from './vercel-network-policy.js';

const WORKTREE_LEASE_MS = 4 * 60 * 60 * 1000;
const CAPABILITY_CACHE_MS = 3 * 60 * 60 * 1000;
const timestampSchema = z.number().int().nonnegative();
const KILO_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const cloudAgentTokenSchema = kiloTokenPayload
  .pick({ version: true, kiloUserId: true, env: true })
  .extend({
    apiTokenPepper: z.string().nullable(),
    tokenSource: z.literal('cloud-agent'),
    iat: timestampSchema,
    exp: timestampSchema,
  })
  .strict();
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
const runtimeProxySchema = z
  .object({
    targets: targetsSchema,
    /** Exact root capabilities substituted only by the Vercel policy. */
    members: z
      .array(
        memberSchema.extend({
          handle: tokenSchema.max(4096),
        })
      )
      .default([]),
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
      accessPurpose: z.enum(['workflow', 'agent']).optional(),
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
    alias: tokenSchema.optional(),
    gitUrl: z.string().url(),
    author: gitAuthorSchema.optional(),
    capability: capabilitySchema.optional(),
    nativeToken: realTokenSchema.optional(),
    gitlab: z
      .object({
        instanceOrigin: z.string().url(),
        instanceHost: z.string().min(1),
        projectPath: z.string().min(1).optional(),
        integrationId: z.string().min(1).optional(),
        authType: z.enum(['oauth', 'pat']).optional(),
        identity: z
          .object({ accountId: z.string().nullable(), accountLogin: z.string().nullable() })
          .strict()
          .optional(),
        glabIsOAuth2: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sessionCredentialGrantSchema = z
  .object({
    version: z.literal(1),
    containmentEnabled: z.boolean().optional(),
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
    provider: agentSandboxProviderSchema,
    outboundContainerId: z.string().min(1).optional(),
    members: z.array(memberSchema).min(1),
    repository: repositorySchema.optional(),
    kilo: z
      .object({
        alias: tokenSchema.optional(),
        token: realTokenSchema,
        tokenSelectedAt: timestampSchema.optional(),
        targets: targetsSchema,
        runtimeProxy: runtimeProxySchema.optional(),
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
      (grant.kilo.tokenSelectedAt !== undefined && grant.kilo.tokenSelectedAt > grant.preparedAt) ||
      new Set(grant.members.map(member => member.sessionId)).size !== grant.members.length ||
      new Set(grant.members.map(member => member.kiloSessionId)).size !== grant.members.length ||
      (grant.containmentEnabled !== false &&
        providerUsesOutboundCredentialProxy(grant.provider) &&
        !grant.outboundContainerId)
    ) {
      reject();
    }
    if (grant.containmentEnabled === false) {
      if (
        grant.kilo.alias !== undefined ||
        grant.kilo.runtimeProxy !== undefined ||
        Object.keys(grant.kilo.capabilities).length > 0
      )
        reject();
    } else {
      const kiloAlias = grant.kilo.alias && parseControlPlaneCredential(grant.kilo.alias);
      if (!kiloAlias || kiloAlias.sandboxId !== grant.sandboxId || kiloAlias.purpose !== 'kilo') {
        reject();
      }
    }
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
        !providerUsesOutboundCredentialProxy(grant.provider)
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
    if (grant.scm.author && grant.scm.purpose !== 'github') reject();
    if (grant.containmentEnabled === false) {
      if (
        grant.scm.alias !== undefined ||
        grant.scm.capability !== undefined ||
        !grant.scm.nativeToken ||
        (grant.scm.purpose === 'gitlab') !== (grant.scm.gitlab !== undefined)
      ) {
        reject();
      }
      return;
    }
    const alias = grant.scm.alias && parseControlPlaneCredential(grant.scm.alias);
    if (!alias || alias.sandboxId !== grant.sandboxId || alias.purpose !== grant.scm.purpose) {
      reject();
    }
    if (grant.provider === 'vercel') {
      if (
        grant.scm.purpose !== 'github' ||
        !grant.scm.nativeToken ||
        grant.scm.capability ||
        grant.scm.gitlab
      ) {
        reject();
      }
      if (grant.kilo.runtimeProxy) {
        const targets = deriveRuntimeProxyTargets(grant.kilo.runtimeProxy.targets);
        const members = grant.kilo.runtimeProxy.members;
        if (
          !targets ||
          new Set(members.map(member => member.sessionId)).size !== members.length ||
          new Set(members.map(member => member.kiloSessionId)).size !== members.length ||
          members.some(
            member =>
              !grant.members.some(
                expected =>
                  expected.sessionId === member.sessionId &&
                  expected.kiloSessionId === member.kiloSessionId
              )
          )
        ) {
          reject();
        }
      }
    } else {
      const prefixes = { github: 'kgh2.', gitlab: 'kgl2.', bitbucket: 'kbb1.' };
      if (
        grant.scm.nativeToken ||
        !grant.scm.capability?.credential.startsWith(prefixes[grant.scm.purpose]) ||
        (grant.scm.purpose === 'gitlab') !== (grant.scm.gitlab !== undefined) ||
        (grant.scm.gitlab !== undefined &&
          (!grant.scm.gitlab.projectPath ||
            !grant.scm.gitlab.integrationId ||
            !grant.scm.gitlab.authType ||
            !grant.scm.gitlab.identity))
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
type ContainedSessionCredentialGrant = SessionCredentialGrant & {
  kilo: SessionCredentialGrant['kilo'] & { alias: string };
  scm?: ScmGrant & { alias: string };
};

export function isContainedSessionCredentialGrant(
  grant: SessionCredentialGrant
): grant is ContainedSessionCredentialGrant {
  return grant.containmentEnabled !== false;
}

type CredentialEnv = Parameters<typeof getOutboundContainerId>[0] &
  Partial<
    Pick<
      Env,
      | 'GIT_TOKEN_SERVICE'
      | 'NEXTAUTH_SECRET'
      | 'WORKER_URL'
      | 'GITHUB_APP_SLUG'
      | 'GITHUB_LITE_APP_SLUG'
      | 'GITHUB_APP_BOT_USER_ID'
      | 'GITHUB_LITE_APP_BOT_USER_ID'
      | 'AGENT_ENV_VARS_PRIVATE_KEY'
    >
  > &
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

function deriveRuntimeProxyTargets(targets: z.infer<typeof targetsSchema>): { facade: URL } | null {
  const parsed = [
    targets.backendBaseUrl,
    targets.providerBaseUrl,
    targets.sessionIngestBaseUrl,
  ].map(safeUrl);
  const [backend, provider, ingest] = parsed;
  if (
    !backend ||
    !provider ||
    !ingest ||
    backend.protocol !== 'https:' ||
    backend.port !== '' ||
    provider.protocol !== 'https:' ||
    provider.port !== '' ||
    ingest.protocol !== 'https:' ||
    ingest.port !== '' ||
    backend.toString().replace(/\/+$/, '') !== provider.toString().replace(/\/+$/, '') ||
    backend.toString().replace(/\/+$/, '') !== ingest.toString().replace(/\/+$/, '') ||
    backend.search ||
    provider.search ||
    ingest.search ||
    runtimeCredentialProxyFacadeBaseUrl(backend.toString()) !==
      backend.toString().replace(/\/+$/, '')
  ) {
    return null;
  }
  return { facade: backend };
}

function runtimeProxyTargets(env: CredentialEnv): z.infer<typeof targetsSchema> | null {
  if (!env.WORKER_URL) return null;
  const base = runtimeCredentialProxyFacadeBaseUrl(env.WORKER_URL);
  if (!base) return null;
  const targets = {
    backendBaseUrl: base,
    providerBaseUrl: base,
    sessionIngestBaseUrl: base,
  };
  return deriveRuntimeProxyTargets(targets) ? targets : null;
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

function repositoryFromSource(
  repository: ControlPlaneCredentialRepository | undefined,
  provider: SessionCredentialGrant['provider'],
  existing: SessionCredentialGrant | undefined,
  context: { containmentEnabled: boolean; orgId?: string; createdOnPlatform?: string }
): CredentialRepository | undefined {
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
    if (context.containmentEnabled && providerUsesOutboundCredentialProxy(provider) && explicit) {
      invalidCredentials();
    }
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
      ...(repository.githubAccessPurpose ? { accessPurpose: repository.githubAccessPurpose } : {}),
      allowUserAuthorization:
        context.createdOnPlatform === 'cloud-agent-web' || context.createdOnPlatform === 'slack',
    };
  }
  const url = canonicalRepositoryUrl(repository.url, repository.type !== 'git');
  if (repository.type === 'git') {
    if (repository.token) invalidCredentials();
    return { type: 'git', url, ...(repository.platform ? { platform: repository.platform } : {}) };
  }
  if (context.containmentEnabled && provider === 'vercel') invalidCredentials();
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
      ...(context.createdOnPlatform ? { createdOnPlatform: context.createdOnPlatform } : {}),
    };
  }
  if (!context.orgId || !parseCanonicalBitbucketCloneUrl(url)) invalidCredentials();
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
  if (repository.type === 'github' && repository.expectedIntegrationId) {
    // Cached capabilities still require current association authorization; older brokers fail closed.
    const authorized = await authorizeCloudAgentGitHubRepo(env, {
      githubRepo: repository.repo,
      userId: grant.userId,
      orgId: grant.orgId,
      expectedIntegrationId: repository.expectedIntegrationId,
      accessPurpose: repository.accessPurpose ?? 'workflow',
    });
    if (!authorized.success) throw new Error('GitHub credential is unavailable');
  }
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
      accessPurpose: repository.accessPurpose ?? 'workflow',
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
      author: issued.value.gitAuthor,
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

async function selectDirectKiloToken(
  env: CredentialEnv,
  token: string,
  existing: SessionCredentialGrant | undefined,
  now: number
): Promise<string> {
  const decoded = jwt.decode(token);
  if (decoded !== null && typeof decoded === 'object') {
    if ('runtimeAdmission' in decoded) invalidCredentials();
    if ('runtimeAuthorization' in decoded) invalidCredentials();
    if ('aud' in decoded || 'tokenPurpose' in decoded || 'credentialExchange' in decoded) {
      invalidCredentials();
    }
  }
  if (
    !existing ||
    existing.kilo.token === token ||
    existing.expiresAt <= now ||
    now >= (existing.kilo.tokenSelectedAt ?? existing.preparedAt) + WORKTREE_LEASE_MS
  ) {
    return token;
  }
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) return token;
  try {
    const options: jwt.VerifyOptions = { algorithms: ['HS256'], clockTimestamp: now / 1000 };
    const current = cloudAgentTokenSchema.parse(jwt.verify(existing.kilo.token, secret, options));
    const incoming = cloudAgentTokenSchema.parse(jwt.verify(token, secret, options));
    if (
      current.kiloUserId !== existing.userId ||
      current.iat * 1000 > now ||
      incoming.iat * 1000 > now ||
      current.exp <= current.iat ||
      incoming.exp <= incoming.iat ||
      current.exp * 1000 <= now + KILO_TOKEN_REFRESH_MARGIN_MS
    ) {
      return token;
    }
    const authorization = cloudAgentTokenSchema.omit({ iat: true, exp: true }).strip();
    return JSON.stringify(authorization.parse(current)) ===
      JSON.stringify(authorization.parse(incoming))
      ? existing.kilo.token
      : token;
  } catch {
    return token;
  }
}

function preparedPayload(input: {
  payload: SessionAttachPayload;
  grant: SessionCredentialGrant;
  existing: SessionCredentialGrant | undefined;
  nativeKiloToken: string;
  nativeRepositoryToken: string | undefined;
  profileEnv: Record<string, string> | undefined;
}): PreparedSessionAttachPayload {
  const { payload, grant, existing } = input;
  // Never let a `git` from the input payload pass through: it may carry a raw
  // token. The emitted `git` comes only from the issued grant below (B3 review 2, N3).
  const { git: _inputGit, ...payloadWithoutGit } = payload;
  const contained = isContainedSessionCredentialGrant(grant);
  const kiloToken = contained ? grant.kilo.alias : grant.kilo.token;
  const scmToken = contained ? grant.scm?.alias : grant.scm?.nativeToken;
  const replacements: Array<[string, string]> = [[grant.kilo.token, kiloToken]];
  replacements.push([input.nativeKiloToken, kiloToken]);
  if (existing) replacements.push([existing.kilo.token, kiloToken]);
  for (const capability of Object.values(grant.kilo.capabilities)) {
    replacements.push([capability.credential, kiloToken]);
  }
  if (grant.scm) {
    if (!scmToken) invalidCredentials();
    const repositoryToken = input.nativeRepositoryToken;
    for (const token of [
      repositoryToken,
      grant.scm.nativeToken,
      grant.scm.capability?.credential,
      existing?.scm?.nativeToken,
      existing?.scm?.capability?.credential,
    ]) {
      if (token) replacements.push([token, scmToken]);
    }
  }
  const sanitize = (value: string) =>
    replacements.reduce((result, [token, alias]) => result.replaceAll(token, alias), value);
  const profile = { envVars: input.profileEnv };
  const env = Object.fromEntries(
    Object.entries({ ...profile.envVars, ...payload.env }).map(([key, value]) => [
      key,
      key === 'GH_TOKEN' || key === 'GITHUB_TOKEN'
        ? (replacements.find(([token]) => token === value)?.[1] ?? value)
        : sanitize(value),
    ])
  );
  env.KILOCODE_TOKEN = kiloToken;
  if (!contained) {
    delete env.KILOCODE_ORGANIZATION_ID;
    if (grant.orgId) env.KILOCODE_ORGANIZATION_ID = grant.orgId;
  }
  if (grant.scm?.purpose === 'github' && scmToken) {
    if (env.GITHUB_TOKEN && env.GH_TOKEN === undefined) env.GH_TOKEN = env.GITHUB_TOKEN;
    env.GH_TOKEN ??= scmToken;
  } else if (grant.scm?.purpose === 'gitlab' && scmToken) {
    const gitlab = grant.scm.gitlab;
    if (!gitlab) invalidCredentials();
    env.GITLAB_TOKEN ??= scmToken;
    if (env.GITLAB_TOKEN === scmToken) {
      env.GLAB_IS_OAUTH2 = gitlab.glabIsOAuth2 ? 'true' : 'false';
      env.GITLAB_HOST = gitlab.instanceHost;
      env.GITLAB_SUBFOLDER = new URL(gitlab.instanceOrigin).pathname.replace(/^\/+|\/+$/g, '');
    }
  } else if (grant.scm?.purpose === 'bitbucket' && scmToken) {
    const repository = grant.repository;
    const canonical = parseCanonicalBitbucketCloneUrl(grant.scm.gitUrl);
    if (repository?.type !== 'bitbucket' || !canonical) invalidCredentials();
    env.BITBUCKET_TOKEN = scmToken;
    env.KILO_BITBUCKET_WORKSPACE_SLUG = canonical.workspaceSlug;
    env.KILO_BITBUCKET_REPOSITORY_SLUG = canonical.repositorySlug;
    env.KILO_BITBUCKET_WORKSPACE_UUID = `{${repository.workspaceUuid}}`;
    env.KILO_BITBUCKET_REPOSITORY_UUID = `{${repository.repositoryUuid}}`;
  }
  return {
    ...payloadWithoutGit,
    directory: grant.directory,
    env,
    ...(grant.scm
      ? {
          git: {
            url: grant.scm.gitUrl,
            platform: grant.scm.purpose,
            token: scmToken,
            ...(grant.scm.author ? { author: grant.scm.author } : {}),
          },
        }
      : grant.repository?.type === 'git'
        ? {
            git: {
              url: grant.repository.url,
              ...(grant.repository.platform ? { platform: grant.repository.platform } : {}),
            },
          }
        : {}),
    ...(payload.setupCommands ? { setupCommands: payload.setupCommands.map(sanitize) } : {}),
    kilo: {
      scopeId: grant.scopeId,
      token: kiloToken,
      targets: grant.kilo.targets,
      ...(!contained ? { containmentEnabled: false } : {}),
      ...(!contained && grant.orgId ? { organizationId: grant.orgId } : {}),
    },
  };
}

async function resolveDirectScmCredentials(
  env: CredentialEnv,
  grant: SessionCredentialGrant,
  repositoryToken: string | undefined
): Promise<SessionCredentialGrant> {
  const repository = grant.repository;
  if (!repository || repository.type === 'git') return grant;
  const common = { userId: grant.userId, ...(grant.orgId ? { orgId: grant.orgId } : {}) };
  if (repository.type === 'github') {
    let nativeToken = repositoryToken;
    let author: { name: string; email: string } | undefined;
    if (repository.authentication === 'managed') {
      const resolved = await resolveCloudAgentGitHubAuthForRepo(env, {
        ...common,
        githubRepo: repository.repo,
        accessPurpose: repository.accessPurpose ?? 'workflow',
        allowUserAuthorization: repository.allowUserAuthorization,
        ...(repository.expectedIntegrationId
          ? { expectedIntegrationId: repository.expectedIntegrationId }
          : {}),
      });
      if (!resolved.success) throw new Error('GitHub credential is unavailable');
      nativeToken = resolved.value.githubToken;
      author = resolved.value.gitAuthor;
    }
    if (!nativeToken) invalidCredentials();
    return {
      ...grant,
      scm: {
        purpose: 'github',
        gitUrl: `https://github.com/${repository.repo}.git`,
        nativeToken,
        ...(author ? { author } : {}),
      },
    };
  }
  if (repository.type === 'gitlab') {
    const resolved = await resolveManagedGitLabToken(env, {
      ...common,
      repositoryUrl: repository.url,
      ...(repository.createdOnPlatform ? { createdOnPlatform: repository.createdOnPlatform } : {}),
    });
    if (!resolved.success) throw new Error('GitLab credential is unavailable');
    const instance = safeUrl(resolved.instanceUrl);
    const repositoryUrl = new URL(repository.url);
    if (
      !instance ||
      instance.protocol !== 'https:' ||
      instance.search ||
      instance.origin !== repositoryUrl.origin ||
      !repositoryUrl.pathname.startsWith(`${instance.pathname.replace(/\/+$/, '')}/`)
    ) {
      invalidCredentials();
    }
    return {
      ...grant,
      scm: {
        purpose: 'gitlab',
        gitUrl: repository.url,
        nativeToken: resolved.token,
        gitlab: {
          instanceOrigin: instance.toString().replace(/\/+$/, ''),
          instanceHost: instance.host,
          glabIsOAuth2: resolved.glabIsOAuth2,
        },
      },
    };
  }
  if (!grant.orgId) invalidCredentials();
  const resolved = await resolveManagedBitbucketToken(env, {
    ...common,
    orgId: grant.orgId,
    repositoryUrl: repository.url,
    workspaceUuid: repository.workspaceUuid,
    repositoryUuid: repository.repositoryUuid,
    ...(repository.expectedIntegrationId
      ? { expectedIntegrationId: repository.expectedIntegrationId }
      : {}),
  });
  if (!resolved.success) throw new Error('Bitbucket credential is unavailable');
  return {
    ...grant,
    scm: { purpose: 'bitbucket', gitUrl: repository.url, nativeToken: resolved.token },
  };
}

function repositoryTokenOf(
  repository: ControlPlaneCredentialRepository | undefined
): string | undefined {
  return repository !== undefined && 'token' in repository ? repository.token : undefined;
}

/**
 * B3 credentials: `hasModernRuntimeAuthorization` reads only the native Kilo
 * token, so the V2 Sandbox DO derives the same flag from the credential source
 * without needing session metadata.
 */
function kiloTokenHasRuntimeAuthorization(token: string): boolean {
  const decoded = jwt.decode(token);
  return (
    typeof decoded === 'object' &&
    decoded !== null &&
    'runtimeAuthorization' in decoded &&
    typeof decoded.runtimeAuthorization === 'object' &&
    decoded.runtimeAuthorization !== null
  );
}

/**
 * The metadata-free grant core. Both the legacy `prepareSessionCredentials`
 * (below) and the V2 Sandbox DO feed it the same minimal inputs, so issuance,
 * renewal, containment and every ownership/authorization check stay in one
 * place.
 */
export type CredentialGrantPreparation = {
  env: CredentialEnv;
  source: ControlPlaneCredentialSource;
  sessionId: string;
  sandboxId: string;
  provider: AgentSandboxProvider;
  containmentEnabled: boolean;
  directory: string;
  scopeId: string;
  payload: SessionAttachPayload;
  profileEnv?: Record<string, string> | undefined;
  outboundContainerId?: string;
  /** Grant duration; V2 passes the named `credentialGrantMs` timer. */
  leaseMs?: number;
  /**
   * Runtime-proxy members to carry into a re-issued grant. Re-issue rotates the
   * aliases, so the caller passes the prior grant's bound handles explicitly.
   */
  runtimeProxyMembers?: ReadonlyArray<{ sessionId: string; kiloSessionId: string; handle: string }>;
  existing?: SessionCredentialGrant;
  now?: number;
};

export async function prepareCredentialGrant(
  input: CredentialGrantPreparation
): Promise<{ grant: SessionCredentialGrant; payload: PreparedSessionAttachPayload }> {
  const { env, source, sandboxId } = input;
  const now = input.now ?? Date.now();
  if (!timestampSchema.safeParse(now).success) invalidCredentials();
  if (!isValidSandboxId(sandboxId) || sandboxId.startsWith('dind-')) invalidCredentials();
  const member = memberSchema.safeParse({
    sessionId: input.sessionId,
    kiloSessionId: source.kiloSessionId,
  });
  const token = realTokenSchema.safeParse(source.kiloToken);
  if (!member.success || !token.success) invalidCredentials();
  const provider = input.provider;
  const containmentEnabled = input.containmentEnabled;
  const targets = deriveKiloSandboxTargets(env, token.data, {
    requireHttps: provider === 'vercel',
  });
  if (!targets.success) invalidCredentials();
  const existing = input.existing === undefined ? undefined : validateGrant(input.existing);
  const directory = input.directory;
  if (!directory) invalidCredentials();
  const scopeId = scopeIdSchema.safeParse(input.scopeId);
  if (!scopeId.success) invalidCredentials();
  const repository = repositoryFromSource(source.repository, provider, existing, {
    containmentEnabled,
    ...(source.orgId === undefined ? {} : { orgId: source.orgId }),
    ...(source.createdOnPlatform === undefined
      ? {}
      : { createdOnPlatform: source.createdOnPlatform }),
  });
  if (
    existing &&
    (isContainedSessionCredentialGrant(existing) !== containmentEnabled ||
      existing.scopeId !== scopeId.data ||
      existing.directory !== directory ||
      existing.sandboxId !== sandboxId ||
      existing.userId !== source.userId ||
      existing.orgId !== source.orgId ||
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
  const modernRuntimeAuthorization = kiloTokenHasRuntimeAuthorization(token.data);
  const modernRuntimeProxy =
    provider === 'vercel' && containmentEnabled && modernRuntimeAuthorization
      ? runtimeProxyTargets(env)
      : null;
  if (
    provider === 'vercel' &&
    containmentEnabled &&
    modernRuntimeAuthorization &&
    !modernRuntimeProxy
  ) {
    invalidCredentials();
  }
  const kiloToken = containmentEnabled
    ? token.data
    : await selectDirectKiloToken(env, token.data, existing, now);
  let grant: SessionCredentialGrant = {
    version: 1,
    ...(!containmentEnabled ? { containmentEnabled: false as const } : {}),
    scopeId: scopeId.data,
    directory,
    sandboxId,
    userId: source.userId,
    ...(source.orgId === undefined ? {} : { orgId: source.orgId }),
    provider,
    ...(input.outboundContainerId ? { outboundContainerId: input.outboundContainerId } : {}),
    members: members.some(current => current.sessionId === member.data.sessionId)
      ? [...members]
      : [...members, member.data],
    ...(repository ? { repository } : {}),
    kilo: {
      ...(containmentEnabled
        ? { alias: existing?.kilo.alias ?? createControlPlaneCredential(sandboxId, 'kilo') }
        : {}),
      token: kiloToken,
      ...(!containmentEnabled
        ? {
            tokenSelectedAt:
              existing?.kilo.token === kiloToken
                ? (existing.kilo.tokenSelectedAt ?? existing.preparedAt)
                : now,
          }
        : {}),
      targets: targets.targets,
      ...(modernRuntimeProxy
        ? {
            runtimeProxy: {
              targets: modernRuntimeProxy,
              members: existing?.kilo.runtimeProxy?.members ?? [
                ...(input.runtimeProxyMembers ?? []),
              ],
            },
          }
        : {}),
      capabilities: existing?.kilo.token === kiloToken ? existing.kilo.capabilities : {},
    },
    ...(existing?.scm ? { scm: existing.scm } : {}),
    preparedAt: now,
    expiresAt: now + (input.leaseMs ?? WORKTREE_LEASE_MS),
  };
  // The native repository token can arrive on the source or on the wrapper-safe
  // git payload (legacy built it from metadata; V2 carries it in the spec).
  const repositoryToken = repositoryTokenOf(source.repository) ?? input.payload.git?.token;
  if (!containmentEnabled) {
    grant = await resolveDirectScmCredentials(env, grant, repositoryToken);
  } else if (providerUsesOutboundCredentialProxy(provider)) {
    const outboundContainerId = input.outboundContainerId;
    if (!outboundContainerId) invalidCredentials();
    grant = await refreshKiloCapability(env, grant, member.data, outboundContainerId, now);
    grant = await refreshScmCapability(env, grant, outboundContainerId, now);
  } else if (repository?.type === 'github') {
    let nativeToken = repositoryToken;
    let author: { name: string; email: string } | undefined;
    if (repository.authentication === 'managed') {
      const resolved = await resolveCloudAgentGitHubAuthForRepo(env, {
        githubRepo: repository.repo,
        accessPurpose: repository.accessPurpose ?? 'workflow',
        allowUserAuthorization: false,
        userId: grant.userId,
        ...(grant.orgId ? { orgId: grant.orgId } : {}),
        ...(repository.expectedIntegrationId
          ? { expectedIntegrationId: repository.expectedIntegrationId }
          : {}),
      });
      if (!resolved.success) throw new Error('GitHub credential is unavailable');
      nativeToken = resolved.value.githubToken;
      author = resolved.value.gitAuthor;
    }
    if (!nativeToken) invalidCredentials();
    grant = {
      ...grant,
      scm: {
        purpose: 'github',
        alias: existing?.scm?.alias ?? createControlPlaneCredential(sandboxId, 'github'),
        gitUrl: `https://github.com/${repository.repo}.git`,
        nativeToken,
        ...(author ? { author } : {}),
      },
    };
  }
  grant = validateGrant(grant);
  if (!isContainedSessionCredentialGrant(grant)) {
    return {
      grant,
      payload: preparedPayload({
        payload: input.payload,
        grant,
        existing,
        nativeKiloToken: source.kiloToken,
        nativeRepositoryToken: repositoryToken,
        profileEnv: input.profileEnv,
      }),
    };
  }
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
  return {
    grant,
    payload: preparedPayload({
      payload: input.payload,
      grant,
      existing,
      nativeKiloToken: source.kiloToken,
      nativeRepositoryToken: repositoryToken,
      profileEnv: input.profileEnv,
    }),
  };
}

/**
 * Projects grouped metadata's repository into the DO-only credential source's
 * strict shape. The grant core reads only these fields; extra metadata fields
 * (for example `upstreamBranch`, `githubInstallationId`) are dropped so the
 * source validates against `controlPlaneCredentialRepositorySchema` (the B4
 * Session DO sends it through the Sandbox DO's strict `prepare` input).
 */
function credentialRepositoryFromMetadata(
  repository: SessionMetadata['repository']
): ControlPlaneCredentialRepository | undefined {
  if (repository === undefined) return undefined;
  switch (repository.type) {
    case 'github':
      return {
        type: 'github',
        repo: repository.repo,
        ...(repository.token ? { token: repository.token } : {}),
        ...(repository.githubIntegrationId
          ? { githubIntegrationId: repository.githubIntegrationId }
          : {}),
        ...(repository.githubAccessPurpose
          ? { githubAccessPurpose: repository.githubAccessPurpose }
          : {}),
      };
    case 'gitlab':
      return {
        type: 'gitlab',
        url: repository.url,
        ...(repository.token ? { token: repository.token } : {}),
        ...(repository.gitlabTokenManaged ? { gitlabTokenManaged: true } : {}),
      };
    case 'bitbucket':
      return {
        type: 'bitbucket',
        url: repository.url,
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
        ...(repository.bitbucketIntegrationId
          ? { bitbucketIntegrationId: repository.bitbucketIntegrationId }
          : {}),
      };
    case 'git':
      return {
        type: 'git',
        url: repository.url,
        ...(repository.token ? { token: repository.token } : {}),
        ...(repository.platform ? { platform: repository.platform } : {}),
      };
  }
}

/**
 * Legacy-plane boundary: adapts `SessionMetadata` to the credential source and
 * the metadata-only guards, then delegates to the shared grant core. Behavior
 * is unchanged for existing callers; the repository projection is the B4
 * strict-schema cleanup described above.
 */
export function credentialSourceFromMetadata(
  metadata: SessionMetadata
): ControlPlaneCredentialSource {
  const kiloToken = metadata.auth.kilocodeToken;
  const kiloSessionId = metadata.auth.kiloSessionId;
  const userId = metadata.identity.userId;
  if (
    typeof kiloToken !== 'string' ||
    typeof kiloSessionId !== 'string' ||
    typeof userId !== 'string'
  ) {
    invalidCredentials();
  }
  const repository = credentialRepositoryFromMetadata(metadata.repository);
  return {
    userId,
    kiloSessionId,
    kiloToken,
    ...(metadata.identity.orgId === undefined ? {} : { orgId: metadata.identity.orgId }),
    ...(metadata.identity.createdOnPlatform === undefined
      ? {}
      : { createdOnPlatform: metadata.identity.createdOnPlatform }),
    ...(repository === undefined ? {} : { repository }),
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
  const payload = buildSessionAttachPayload(metadata, undefined, env.AGENT_ENV_VARS_PRIVATE_KEY);
  return prepareCredentialGrant({
    env,
    source: credentialSourceFromMetadata(metadata),
    sessionId: metadata.identity.sessionId,
    sandboxId,
    provider: getSandboxProvider(metadata),
    containmentEnabled: requiresContainmentSandbox(metadata),
    directory: payload.directory ?? '',
    scopeId: metadata.workspace?.worktreeId ?? metadata.identity.sessionId,
    payload,
    profileEnv: readProfileBundle(metadata).envVars,
    ...(input.outboundContainerId === undefined
      ? {}
      : { outboundContainerId: input.outboundContainerId }),
    ...(input.existing === undefined ? {} : { existing: input.existing }),
    now,
  });
}

/**
 * Wrapper-facing projection of a route grant: the resolved material the wrapper
 * installs. Carries no issuer material (native tokens stay DO-side).
 */
export function sessionCredentialsPayloadFromGrant(
  grant: SessionCredentialGrant,
  sessionId: string
): {
  sessionId: string;
  git?: { token: string; platform?: 'github' | 'gitlab' | 'bitbucket' };
  kilo: { token: string };
  proxy?: {
    handle: string;
    targets: { backendBaseUrl: string; providerBaseUrl: string; sessionIngestBaseUrl: string };
  };
} {
  const contained = isContainedSessionCredentialGrant(grant);
  const kiloToken = contained ? grant.kilo.alias : grant.kilo.token;
  const scmToken = contained ? grant.scm?.alias : grant.scm?.nativeToken;
  // The runtime credential proxy facade and the per-session handle (minted by
  // the Session DO and bound to the route grant) are projected here, never into
  // the route spec.
  const proxyMember = grant.kilo.runtimeProxy?.members.find(
    member => member.sessionId === sessionId
  );
  return {
    sessionId,
    ...(grant.scm && scmToken
      ? {
          git: {
            token: scmToken,
            ...(grant.scm.purpose ? { platform: grant.scm.purpose } : {}),
          },
        }
      : {}),
    kilo: { token: kiloToken },
    ...(grant.kilo.runtimeProxy && proxyMember
      ? { proxy: { handle: proxyMember.handle, targets: grant.kilo.runtimeProxy.targets } }
      : {}),
  };
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
          ...(grant.kilo.runtimeProxy
            ? {
                runtimeProxy: {
                  ...grant.kilo.runtimeProxy,
                  members: grant.kilo.runtimeProxy.members.filter(
                    member => member.sessionId !== sessionId
                  ),
                },
              }
            : {}),
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
    if (
      !isContainedSessionCredentialGrant(grant) ||
      grant.provider !== 'vercel' ||
      grant.sandboxId !== grants[0]?.sandboxId
    ) {
      invalidCredentials();
    }
    return buildVercelCredentialNetworkPolicy({
      kilo: {
        token: grant.kilo.token,
        placeholder: grant.kilo.alias,
        targets: grant.kilo.targets,
        rootSessionIds: grant.members.map(member => member.kiloSessionId),
        organizationId: grant.orgId,
        ...(grant.kilo.runtimeProxy ? { runtimeProxy: grant.kilo.runtimeProxy } : {}),
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
    allowedDomains: [
      ...new Set(policies.flatMap(policy => policy.allowedDomains)),
      ...(policies.length === 0 ? ['*'] : []),
    ],
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
    !isContainedSessionCredentialGrant(grant) ||
    !providerUsesOutboundCredentialProxy(grant.provider) ||
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
