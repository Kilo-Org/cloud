import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  getBuiltinAgentSettings,
  hasBuiltinAgentSettings,
  loadEnvironmentForSession,
  mergeProfileConfiguration,
  profileMcpServersToClientRecord,
  ProfileNotFoundError,
  type BuiltinAgentSettings,
  type EnvironmentForSession,
  type EnvironmentInlineArgs,
  type EnvironmentOwner,
  type EnvironmentSessionLayer,
  type InlineAgentInput,
  type MergeProfileConfigurationResult,
  type ProfileOwner,
} from '@kilocode/cloud-agent-profile';
import { repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import type { EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import { getPgDb } from '../../db/pg.js';
import { assertKiloModelAvailable } from '../../model-validation.js';
import { CurrentSessionMetadataSchema } from '../../persistence/session-metadata.js';
import { SessionProfileBundleSchema } from '../../persistence/schemas.js';
import type { SessionProfileBundle } from '../../session-profile.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { launchRepositoryIdentity } from '../../session/environment-launch.js';
import { isPolicyBearingAuthToken } from '../../session/policy-bearing-token.js';
import {
  assertEnvironmentRepositoriesAccess,
  assertRepositoryAccessBeforeSessionCreation,
} from '../../session/validate-repository-access.js';
import type { TRPCContext } from '../../types.js';
import { isBuiltinMode } from '../schemas.js';
import { assertOrganizationMembership } from './organization-membership.js';
import { assertRequestedRepositories } from './requested-environment-repositories.js';
import { getSandboxSessionStub, type SessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';
import { validateBalanceOnly } from '../../balance-validation.js';
import { timingSafeEqual } from '@kilocode/encryption';
import { isRepositoryAgentOrigin } from '../../shared/agent-modes.js';
import { isInteractiveSessionOrigin } from '../../shared/control-plane-permission.js';
import { logger } from '../../logger.js';

const WEB_ORIGIN = 'cloud-agent-web';

const IMPLICIT_PROFILE_RESOLUTION_ORIGINS: ReadonlySet<string> = new Set([
  WEB_ORIGIN,
  'slack',
  'github',
  'linear',
  'discord',
  'webhook',
  'scheduled',
]);

export type ProfileResolutionPolicy = {
  defaultProfileResolution: 'explicit-profile-only' | 'include-web-defaults';
};

export function profileResolutionPolicyForSessionCreateOrigin(
  createdOnPlatform: string | undefined
): ProfileResolutionPolicy {
  return {
    defaultProfileResolution:
      createdOnPlatform !== undefined && IMPLICIT_PROFILE_RESOLUTION_ORIGINS.has(createdOnPlatform)
        ? 'include-web-defaults'
        : 'explicit-profile-only',
  };
}

function repoFullNameForBindingLookup(input: SessionCreateRequest): string | undefined {
  if (input.repository.type === 'github') return input.repository.repo;
  if (input.repository.type === 'gitlab') {
    // The repository discriminator establishes this host as GitLab, including self-hosted instances.
    return repoFullNameFromGitUrl(input.repository.url, input.repository.url);
  }
  return undefined;
}

function environmentOwnerForSession(
  ctx: Pick<TRPCContext, 'userId'>,
  input: SessionCreateRequest
): EnvironmentOwner {
  const organizationId = input.options?.kilocodeOrganizationId;
  return organizationId
    ? { type: 'organization', id: organizationId }
    : { type: 'user', id: ctx.userId };
}

/**
 * The environment of the session's repository. It applies on the same origins
 * as the implicit profile defaults; other origins (for example code review and
 * the security agent) run without it.
 *
 * Several environments can contain the repository. A client that selected one
 * names it in `requestedEnvironment`. Without a selection, a client that marks
 * `requireEnvironmentChoice` gets a conflict that names the environments, and
 * every other client runs with no environment.
 */
async function resolveEnvironment(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb
): Promise<EnvironmentForSession | null> {
  if (policy.defaultProfileResolution !== 'include-web-defaults') return null;
  const repository = launchRepositoryIdentity(input.repository);
  if (!repository) return null;

  const resolution = await loadEnvironmentForSession(db ?? getPgDb(ctx.env), {
    owner: environmentOwnerForSession(ctx, input),
    repository,
    ...(input.requestedEnvironment ? { environmentId: input.requestedEnvironment.id } : {}),
  });
  switch (resolution.status) {
    case 'match':
      return resolution.environment;
    case 'none':
      return null;
    case 'requested-not-found':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'The selected environment was not found' });
    case 'requested-without-repository':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The selected environment does not contain this repository',
      });
    case 'conflict':
      if (input.requireEnvironmentChoice !== true) return null;
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Several environments contain this repository: ${resolution.environments
          .map(environment => `"${environment.name}" (${environment.id})`)
          .join(', ')}. Select one.`,
      });
  }
}

function inlineOverridesForResolution(input: SessionCreateRequest): EnvironmentInlineArgs {
  const overrides = input.profile?.overrides;
  return {
    envVars: overrides?.envVars,
    setupCommands: overrides?.setupCommands,
    encryptedSecrets: overrides?.encryptedSecrets,
    mcpServers: overrides?.mcpServers,
    runtimeSkills: overrides?.runtimeSkills,
    runtimeAgents: overrides?.runtimeAgents as InlineAgentInput[] | undefined,
  };
}

function shouldResolveProfile(
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy
): boolean {
  return (
    input.profile?.id !== undefined || policy.defaultProfileResolution === 'include-web-defaults'
  );
}

async function resolveProfileForSessionCreateRequest(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  environment: EnvironmentSessionLayer | undefined,
  db?: WorkerDb
): Promise<MergeProfileConfigurationResult> {
  const owner: ProfileOwner = environmentOwnerForSession(ctx, input);
  const userId = input.options?.kilocodeOrganizationId ? ctx.userId : undefined;

  try {
    return await mergeProfileConfiguration(db ?? getPgDb(ctx.env), {
      profileId: input.profile?.id,
      owner,
      userId,
      repoFullName: repoFullNameForBindingLookup(input),
      platform:
        input.repository.type === 'gitlab'
          ? 'gitlab'
          : input.repository.type === 'github'
            ? 'github'
            : undefined,
      environment,
      ...inlineOverridesForResolution(input),
    });
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
    }
    throw err;
  }
}

function applyProfileResolution(
  input: SessionCreateRequest,
  resolved: MergeProfileConfigurationResult | null,
  builtinAgents: BuiltinAgentSettings
): SessionCreateRequest {
  const hasBuiltinAgents = hasBuiltinAgentSettings(builtinAgents);
  if (!resolved) {
    return {
      ...input,
      profile: {
        ...input.profile,
        resolved: {
          ...input.profile?.resolved,
          envVars: input.profile?.overrides?.envVars,
          encryptedSecrets: input.profile?.overrides?.encryptedSecrets,
          setupCommands: input.profile?.overrides?.setupCommands,
          mcpServers: input.profile?.overrides?.mcpServers,
          runtimeSkills: input.profile?.overrides?.runtimeSkills,
          runtimeAgents: input.profile?.overrides?.runtimeAgents,
          ...(hasBuiltinAgents ? { builtinAgents } : {}),
        },
      },
    };
  }

  return {
    ...input,
    profile: {
      ...input.profile,
      // The resolved active profile id. Absent when no profile applied, so a
      // session that runs on no profile records none rather than the client's
      // requested id.
      ...(resolved.resolvedProfileId ? { resolvedProfileId: resolved.resolvedProfileId } : {}),
      resolved: {
        envVars: resolved.envVars,
        setupCommands: resolved.setupCommands,
        ...(resolved.startCommands ? { startCommands: resolved.startCommands } : {}),
        ...(resolved.environmentSetupCommandCount === undefined
          ? {}
          : { environmentSetupCommandCount: resolved.environmentSetupCommandCount }),
        encryptedSecrets: resolved.encryptedSecrets,
        mcpServers: profileMcpServersToClientRecord(resolved.mcpServers),
        runtimeSkills: resolved.skills,
        runtimeAgents: resolved.agents,
        ...(hasBuiltinAgents ? { builtinAgents } : {}),
        kiloCommands: resolved.kiloCommands ?? input.profile?.resolved?.kiloCommands,
        runtimeInstructions: resolved.instructions ?? input.profile?.resolved?.runtimeInstructions,
      },
    },
  };
}

function assertResolvedConfigurationWithinSessionLimits(
  resolved: SessionProfileBundle | undefined
): void {
  // An older wrapper receives the start commands appended to setup, so the
  // combined list must fit one setup list.
  const setupAndStart = [...(resolved?.setupCommands ?? []), ...(resolved?.startCommands ?? [])];
  const parsed = SessionProfileBundleSchema.safeParse({
    envVars: resolved?.envVars,
    encryptedSecrets: resolved?.encryptedSecrets,
    setupCommands: setupAndStart,
  });
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'resolved configuration exceeds session limits',
    });
  }
}

async function loadBuiltinAgentSettingsForSession(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  db?: WorkerDb
): Promise<BuiltinAgentSettings> {
  try {
    return await getBuiltinAgentSettings(db ?? getPgDb(ctx.env), ctx.userId);
  } catch (error) {
    logger
      .withFields({
        userId: ctx.userId,
        errorClass: error instanceof Error ? error.name : typeof error,
      })
      .warn('Unable to load built-in agent preferences; using defaults');
    return {};
  }
}

export async function resolveEffectiveSessionConfiguration(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb
): Promise<SessionCreateRequest> {
  const environment = await resolveEnvironment(ctx, input, policy, db);
  assertRequestedRepositories({
    environment: environment?.reference ?? null,
    launch: launchRepositoryIdentity(input.repository),
    requested: input.requestedEnvironment,
  });
  // An environment resolves only under the implicit-defaults policy, so the
  // profile path always runs when one exists.
  const [resolved, builtinAgents] = await Promise.all([
    shouldResolveProfile(input, policy)
      ? resolveProfileForSessionCreateRequest(ctx, input, environment?.layer, db)
      : Promise.resolve(null),
    loadBuiltinAgentSettingsForSession(ctx, db),
  ]);

  const resolvedRequest = applyProfileResolution(input, resolved, builtinAgents);
  assertResolvedConfigurationWithinSessionLimits(resolvedRequest.profile?.resolved);
  // The reference and the allocation travel beside the merged configuration;
  // a client cannot set them.
  const {
    environment: _clientEnvironment,
    environmentSandboxAllocation: _clientAllocation,
    ...withoutEnvironment
  } = resolvedRequest;
  let effectiveRequest: SessionCreateRequest = {
    ...withoutEnvironment,
    ...(environment ? { environment: environment.reference } : {}),
    ...(environment?.sandboxAllocation
      ? { environmentSandboxAllocation: environment.sandboxAllocation }
      : {}),
  };
  // A saved allowlist enters the same runtime slot as explicit input, but only
  // when the request named no policy. Full and legacy null policies are already
  // the unrestricted default, so they need no write.
  if (
    environment?.egressMode === 'allowlist' &&
    input.runtime?.egressMode === undefined &&
    input.runtime?.egressAllowlist === undefined
  ) {
    effectiveRequest = {
      ...effectiveRequest,
      runtime: {
        ...effectiveRequest.runtime,
        egressMode: 'allowlist',
        egressAllowlist: environment.egressAllowlist ?? [],
      },
    };
  }
  return effectiveRequest;
}

type InheritedEgressPolicy = {
  egressMode: EgressMode;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

function parentPolicyUnavailableError(): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Cloud Agent parent policy unavailable',
  });
}

/**
 * Reads the policy the authorized parent recorded when it was created. The
 * environment's current settings do not apply to an existing parent.
 */
async function readParentEgressPolicy(
  getStub: () => SessionStub,
  authority: CloudAgentAuthority
): Promise<InheritedEgressPolicy | undefined> {
  let raw: unknown;
  try {
    raw = await withDORetry(getStub, parent => parent.getMetadata(), 'getMetadata');
  } catch {
    throw parentPolicyUnavailableError();
  }

  // The RPC returns the current grouped schema, but revalidate so a malformed
  // or legacy payload cannot be read as an unrestricted parent.
  const parsed = CurrentSessionMetadataSchema.safeParse(raw);
  if (!parsed.success) throw parentPolicyUnavailableError();
  const metadata = parsed.data;
  if (
    metadata.identity.sessionId !== authority.parentSessionId ||
    metadata.identity.userId !== authority.ownerId ||
    (metadata.identity.orgId ?? null) !== authority.organizationId
  ) {
    throw parentPolicyUnavailableError();
  }

  const workspace = metadata.workspace;
  if (workspace?.egressMode !== 'allowlist' && workspace?.egressAudit !== true) return undefined;
  return {
    egressMode: workspace.egressMode ?? 'unrestricted',
    ...(workspace.egressMode === 'allowlist'
      ? { egressAllowlist: workspace.egressAllowlist ?? [] }
      : {}),
    ...(workspace.egressAudit === true ? { egressAudit: true } : {}),
  };
}

export function assertModeAvailableForProfile(
  mode: string,
  profile: SessionProfileBundle,
  allowRepositoryAgent: boolean
): void {
  // Automation repositories are cloned later; Kilo resolves their agent files at execution.
  if (isBuiltinMode(mode) || allowRepositoryAgent) return;
  const slugs = new Set((profile.runtimeAgents ?? []).map(a => a.slug));
  if (slugs.has(mode)) return;

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `Mode "${mode}" is not a built-in slug and does not match any runtimeAgents on this session`,
  });
}

/**
 * Server-owned mode fallback for a continued session. A local mode is kept when
 * it is a built-in or a runtimeAgents slug of the resolved profile; otherwise
 * the session registers as `code` and reports `modeFallback`. This never fails
 * the operation. Only the continuation handler uses it, so a normal create
 * still rejects an unavailable user-picked mode.
 */
export function resolveContinuationMode(
  requestedMode: string,
  resolvedProfile: SessionProfileBundle
): { mode: string; modeFallback: boolean } {
  if (isBuiltinMode(requestedMode)) return { mode: requestedMode, modeFallback: false };
  const slugs = new Set((resolvedProfile.runtimeAgents ?? []).map(a => a.slug));
  if (slugs.has(requestedMode)) return { mode: requestedMode, modeFallback: false };
  return { mode: 'code', modeFallback: true };
}

/**
 * Per-call profile-resolution and mode policy.
 *
 * `includeWebDefaults` forces `include-web-defaults` for one create (the
 * continuation first session), instead of widening the global origin allowlist.
 * `continuationModeResolution` replaces an unavailable local mode with `code`
 * after resolution, so the following `assertModeAvailableForProfile` passes.
 * Only the continuation handler sets these.
 */
export type SessionCreationPolicyOptions = {
  includeWebDefaults?: boolean;
  continuationModeResolution?: boolean;
};

type SessionCreationContext = Pick<
  TRPCContext,
  'env' | 'userId' | 'authToken' | 'cloudAgentAuthority'
> &
  Partial<Pick<TRPCContext, 'request'>>;
type EndpointValidator = (request: SessionCreateRequest) => void | Promise<void>;

export async function preflightSessionCreation(
  request: SessionCreateRequest,
  ctx: SessionCreationContext,
  procedure: string,
  validateEndpoint?: EndpointValidator,
  policyOptions?: SessionCreationPolicyOptions
): Promise<SessionCreateRequest> {
  let inheritedEgress: InheritedEgressPolicy | undefined;
  if (ctx.cloudAgentAuthority) {
    const authority = ctx.cloudAgentAuthority;
    if (
      request.parentCloudAgentSessionId !== authority.parentSessionId ||
      authority.ownerId !== ctx.userId ||
      (request.options?.kilocodeOrganizationId ?? null) !== authority.organizationId
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Cloud Agent parent binding mismatch' });
    }
    const parentStub = () => getSandboxSessionStub(ctx.env, ctx.userId, authority.parentSessionId);
    let token: string;
    let parentCreatedOnPlatform: string | undefined;
    try {
      const parent = await withDORetry(
        parentStub,
        stub => stub.getCloudAgentSpawnContext(authority),
        'getCloudAgentSpawnContext'
      );
      token = parent.token;
      parentCreatedOnPlatform = parent.createdOnPlatform;
    } catch {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cloud Agent parent authorization unavailable',
      });
    }
    if (!isInteractiveSessionOrigin(parentCreatedOnPlatform)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cloud Agent parent authorization unavailable',
      });
    }
    request.options = {
      ...request.options,
      createdOnPlatform: parentCreatedOnPlatform,
    };
    inheritedEgress = await readParentEgressPolicy(parentStub, authority);
    const internalApiKey = ctx.request?.headers.get('x-internal-api-key');
    const skipBalance =
      ctx.request?.headers.get('x-skip-balance-check') === 'true' &&
      typeof ctx.env.INTERNAL_API_SECRET === 'string' &&
      internalApiKey !== undefined &&
      internalApiKey !== null &&
      timingSafeEqual(internalApiKey, ctx.env.INTERNAL_API_SECRET);
    if (!skipBalance) {
      const balance = await validateBalanceOnly(
        token,
        authority.organizationId ?? undefined,
        ctx.env
      );
      if (!balance.success)
        throw new TRPCError({
          code: balance.status === 402 ? 'PAYMENT_REQUIRED' : 'INTERNAL_SERVER_ERROR',
          message: balance.message,
        });
    }
  }
  const organizationId = request.options?.kilocodeOrganizationId;
  let db: WorkerDb | undefined;
  if (organizationId) {
    db = getPgDb(ctx.env);
    await assertOrganizationMembership(db, ctx.userId, organizationId);
  }

  await assertRepositoryAccessBeforeSessionCreation({
    env: ctx.env,
    userId: ctx.userId,
    orgId: organizationId,
    repository: request.repository,
  });

  const policy: ProfileResolutionPolicy = policyOptions?.includeWebDefaults
    ? { defaultProfileResolution: 'include-web-defaults' }
    : profileResolutionPolicyForSessionCreateOrigin(request.options?.createdOnPlatform);
  let resolvedRequest = await resolveEffectiveSessionConfiguration(ctx, request, policy, db);
  if (policyOptions?.continuationModeResolution) {
    // Replace the agent object instead of mutating it: the resolution result
    // shares the caller's `agent` reference, and the continuation handler derives
    // its request digest and per-source fallback from the caller's object.
    resolvedRequest = {
      ...resolvedRequest,
      agent: {
        ...resolvedRequest.agent,
        mode: resolveContinuationMode(
          resolvedRequest.agent.mode,
          resolvedRequest.profile?.resolved ?? {}
        ).mode,
      },
    };
  }
  // The environment resolves here, so its members are authorized after it.
  await assertEnvironmentRepositoriesAccess({
    env: ctx.env,
    userId: ctx.userId,
    orgId: organizationId,
    createdOnPlatform: resolvedRequest.options?.createdOnPlatform,
    repository: resolvedRequest.repository,
    environment: resolvedRequest.environment,
  });
  if (
    inheritedEgress &&
    request.runtime?.egressMode === undefined &&
    request.runtime?.egressAllowlist === undefined
  ) {
    const { egressAllowlist, ...inheritedPolicy } = inheritedEgress;
    const runtime = { ...resolvedRequest.runtime, ...inheritedPolicy };
    // An environment-derived allowlist must not survive an unrestricted
    // inherited mode; the policy schema rejects that combination.
    if (runtime.egressMode === 'allowlist') {
      runtime.egressAllowlist = egressAllowlist ?? [];
    } else {
      delete runtime.egressAllowlist;
    }
    resolvedRequest = { ...resolvedRequest, runtime };
  }
  assertModeAvailableForProfile(
    resolvedRequest.agent.mode,
    resolvedRequest.profile?.resolved ?? {},
    procedure === 'prepareSession' &&
      isRepositoryAgentOrigin(resolvedRequest.options?.createdOnPlatform)
  );
  await validateEndpoint?.(resolvedRequest);

  if (resolvedRequest.initialTurn?.type === 'prompt' && !isPolicyBearingAuthToken(ctx.authToken)) {
    await assertKiloModelAvailable({
      env: ctx.env,
      submittedModel: resolvedRequest.agent.model,
      originalToken: ctx.authToken,
      originalOrganizationId: resolvedRequest.options?.kilocodeOrganizationId,
      createdOnPlatform: resolvedRequest.options?.createdOnPlatform,
      procedure,
    });
  }

  return resolvedRequest;
}
