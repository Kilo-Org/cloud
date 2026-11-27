import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  ENVIRONMENT_SETUP_LIMITS,
  getBuiltinAgentSettings,
  getModelContextLimits,
  getWebSearchPreference,
  hasBuiltinAgentSettings,
  hasModelContextLimits,
  isAgentWritableSetupRunStatus,
  loadEnvironmentForSession,
  loadSetupRunForSession,
  mergeProfileConfiguration,
  mergeRequiredHosts,
  profileMcpServersToClientRecord,
  ProfileNotFoundError,
  sameRepositoryIdentity,
  type BuiltinAgentSettings,
  type EnvironmentForSession,
  type EnvironmentInlineArgs,
  type EnvironmentOwner,
  type EnvironmentSessionLayer,
  type InlineAgentInput,
  type MergeProfileConfigurationResult,
  type ModelContextLimits,
  type ProfileOwner,
  type WebSearchPreference,
} from '@kilocode/cloud-agent-profile';
import { repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import type { EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import {
  getSandboxAllocationProvider,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import { getPgDb } from '../../db/pg.js';
import { assertKiloModelAvailable } from '../../model-validation.js';
import { SessionProfileBundleSchema } from '../../persistence/schemas.js';
import type { SessionProfileBundle } from '../../session-profile.js';
import type { EnvironmentSetupBinding } from '../../shared/environment-setup.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { launchRepositoryIdentity } from '../../session/environment-launch.js';
import { isPolicyBearingAuthToken } from '../../session/policy-bearing-token.js';
import {
  assertEnvironmentRepositoriesAccess,
  assertRepositoryAccessBeforeSessionCreation,
} from '../../session/validate-repository-access.js';
import type { TRPCContext } from '../../types.js';
import { isBuiltinMode } from '../schemas.js';
import { resolveHostedWorkspaceRepositories } from './hosted-workspace-repositories.js';
import { assertOrganizationMembership } from './organization-membership.js';
import { assertRequestedRepositories } from './requested-environment-repositories.js';
import { getWorkspaceStub } from '../../control-plane/workspace/workspace-stub.js';
import {
  workspaceSpawnContextSchema,
  type WorkspaceSpawnConfiguration,
} from '../../cloud-agent-authority.js';
import { withDORetry } from '../../utils/do-retry.js';
import { validateBalanceOnly } from '../../balance-validation.js';
import { timingSafeEqual } from '@kilocode/encryption';
import { isRepositoryAgentOrigin } from '../../shared/agent-modes.js';
import { logger } from '../../logger.js';
import { NETWORK_SECRET_LIMITS } from '@kilocode/worker-utils/network-secrets';
import { readCloudAgentNextSecret } from '../../secrets.js';

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
 *
 * A setup or verification session names its binding instead; that resolves the
 * run's draft even on an origin that has no implicit defaults.
 */
async function resolveEnvironment(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb,
  binding?: EnvironmentSetupBinding
): Promise<EnvironmentForSession | null> {
  if (
    policy.defaultProfileResolution !== 'include-web-defaults' &&
    input.requestedEnvironment === undefined &&
    binding === undefined
  )
    return null;
  const repository = launchRepositoryIdentity(input.repository);
  if (!repository) return null;

  const resolution = await loadEnvironmentForSession(db ?? getPgDb(ctx.env), {
    owner: environmentOwnerForSession(ctx, input),
    repository,
    ...(binding
      ? {
          environmentId: binding.environmentId,
          allowDraft: { setupRunId: binding.runId },
        }
      : input.requestedEnvironment
        ? { environmentId: input.requestedEnvironment.id }
        : {}),
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
  builtinAgents: BuiltinAgentSettings,
  modelContextLimits: ModelContextLimits,
  webSearchPreference: WebSearchPreference
): SessionCreateRequest {
  const webSearch = {
    webSearchDisabled: webSearchPreference === 'off' ? (true as const) : undefined,
    webSearchProvider:
      webSearchPreference === 'off' || webSearchPreference === 'default'
        ? undefined
        : webSearchPreference,
  };
  const hasBuiltinAgents = hasBuiltinAgentSettings(builtinAgents);
  const hasContextLimits = hasModelContextLimits(modelContextLimits);
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
          ...(hasContextLimits ? { modelContextLimits } : {}),
          ...webSearch,
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
        ...(resolved.networkSecrets ? { networkSecrets: resolved.networkSecrets } : {}),
        mcpServers: profileMcpServersToClientRecord(resolved.mcpServers),
        runtimeSkills: resolved.skills,
        runtimeAgents: resolved.agents,
        ...(hasBuiltinAgents ? { builtinAgents } : {}),
        ...(hasContextLimits ? { modelContextLimits } : {}),
        ...webSearch,
        kiloCommands: resolved.kiloCommands ?? input.profile?.resolved?.kiloCommands,
        runtimeInstructions: resolved.instructions ?? input.profile?.resolved?.runtimeInstructions,
      },
    },
  };
}

function assertResolvedConfigurationWithinSessionLimits(
  resolved: SessionProfileBundle | undefined
): void {
  if (Object.keys(resolved?.networkSecrets ?? {}).length > NETWORK_SECRET_LIMITS.MAX_SECRETS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Maximum ${NETWORK_SECRET_LIMITS.MAX_SECRETS} network secrets per workspace after merging environments and profiles`,
    });
  }
  // An older wrapper receives the start commands appended to setup, so the
  // combined list must fit one setup list.
  const setupAndStart = [...(resolved?.setupCommands ?? []), ...(resolved?.startCommands ?? [])];
  const parsed = SessionProfileBundleSchema.safeParse({
    envVars: resolved?.envVars,
    encryptedSecrets: resolved?.encryptedSecrets,
    networkSecrets: resolved?.networkSecrets,
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

async function loadModelContextLimitsForSession(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  db?: WorkerDb
): Promise<ModelContextLimits> {
  try {
    return await getModelContextLimits(db ?? getPgDb(ctx.env), ctx.userId);
  } catch (error) {
    logger
      .withFields({
        userId: ctx.userId,
        errorClass: error instanceof Error ? error.name : typeof error,
      })
      .warn('Unable to load model context limit preferences; using defaults');
    return {};
  }
}

async function loadWebSearchPreferenceForSession(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  db?: WorkerDb
): Promise<WebSearchPreference> {
  try {
    return await getWebSearchPreference(db ?? getPgDb(ctx.env), ctx.userId);
  } catch (error) {
    logger
      .withFields({
        userId: ctx.userId,
        errorClass: error instanceof Error ? error.name : typeof error,
      })
      .warn('Unable to load web search preferences; using defaults');
    return 'default';
  }
}

export async function resolveEffectiveSessionConfiguration(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb,
  binding?: EnvironmentSetupBinding
): Promise<SessionCreateRequest> {
  const environment = await resolveEnvironment(ctx, input, policy, db, binding);
  // The binding is only valid for the environment it names: a run's draft that
  // did not resolve must never run as an unbound session.
  if (
    binding !== undefined &&
    (environment === null || environment.reference.environmentId !== binding.environmentId)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Environment setup run is not available' });
  }
  assertRequestedRepositories({
    environment: environment?.reference ?? null,
    launch: launchRepositoryIdentity(input.repository),
    requested: input.requestedEnvironment,
  });
  const [resolved, builtinAgents, modelContextLimits, webSearchPreference] = await Promise.all([
    environment !== null || shouldResolveProfile(input, policy)
      ? resolveProfileForSessionCreateRequest(ctx, input, environment?.layer, db)
      : Promise.resolve(null),
    loadBuiltinAgentSettingsForSession(ctx, db),
    loadModelContextLimitsForSession(ctx, db),
    input.options?.kilocodeOrganizationId
      ? Promise.resolve('default' as const)
      : loadWebSearchPreferenceForSession(ctx, db),
  ]);

  // Drafts cannot use an environment snapshot, so their setup commands run in the session.
  const resolvedRequest = applyProfileResolution(
    input,
    resolved && binding ? { ...resolved, environmentSetupCommandCount: undefined } : resolved,
    builtinAgents,
    modelContextLimits,
    webSearchPreference
  );
  if (resolved?.skippedAgentSlugs !== undefined) {
    // A stored profile agent that carries a CLI agent id no longer reaches a
    // session; record it so the rows that stop applying are measurable.
    logger
      .withFields({
        userId: ctx.userId,
        profileId: resolved.resolvedProfileId ?? null,
        slugs: resolved.skippedAgentSlugs,
      })
      .warn('Stored profile agents omitted from the session: their ids belong to the CLI');
  }
  assertResolvedConfigurationWithinSessionLimits(resolvedRequest.profile?.resolved);
  // The reference, the allocation and the setup binding travel beside the
  // merged configuration; a client cannot set them.
  const {
    environment: _clientEnvironment,
    environmentSandboxAllocation: _clientAllocation,
    environmentSetup: _clientEnvironmentSetup,
    ...withoutEnvironment
  } = resolvedRequest;
  let effectiveRequest: SessionCreateRequest = {
    ...withoutEnvironment,
    ...(environment ? { environment: environment.reference } : {}),
    ...(environment?.sandboxAllocation
      ? { environmentSandboxAllocation: environment.sandboxAllocation }
      : {}),
    ...(binding ? { environmentSetup: binding } : {}),
  };
  if (binding?.role === 'setup') {
    const { egressAllowlist: _allowlist, ...runtime } = effectiveRequest.runtime ?? {};
    return {
      ...effectiveRequest,
      runtime: { ...runtime, egressMode: 'unrestricted', egressAudit: true },
    };
  }
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
  // A restricted policy always includes the environment's required hosts. The
  // environment's saved policy and an explicit client allowlist both pass
  // through this merge.
  if (environment && effectiveRequest.runtime?.egressMode === 'allowlist') {
    const merged = mergeRequiredHosts(
      effectiveRequest.runtime.egressAllowlist ?? [],
      environment.egressRequiredHosts
    );
    if (merged && merged.length > ENVIRONMENT_SETUP_LIMITS.MAX_EFFECTIVE_ALLOWLIST) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: "The allowlist and the environment's required hosts together exceed 100 hostnames",
      });
    }
    effectiveRequest = {
      ...effectiveRequest,
      runtime: { ...effectiveRequest.runtime, egressAllowlist: merged ?? [] },
    };
  }
  return effectiveRequest;
}

type InheritedEgressPolicy = {
  egressMode: EgressMode;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

function inheritSpawnConfiguration(
  request: SessionCreateRequest,
  inherited: WorkspaceSpawnConfiguration | undefined
): SessionCreateRequest | undefined {
  if (inherited === undefined || request.requestedEnvironment !== undefined) return undefined;
  const environment = inherited.environment;
  const launch = launchRepositoryIdentity(request.repository);
  const members =
    environment?.repositories?.map(member => member.identity) ??
    (environment?.repository ? [environment.repository] : []);
  if (environment && (!launch || !members.some(member => sameRepositoryIdentity(member, launch))))
    return undefined;
  const scope =
    environment?.repositories === undefined
      ? environment
      : {
          ...environment,
          repositories: environment.repositories.map(({ branch: _branch, ...member }) => member),
        };
  return {
    ...request,
    profile: { resolved: inherited.profile },
    ...(scope ? { environment: scope } : {}),
  };
}

function supportsEgressAudit(request: SessionCreateRequest): boolean {
  const allocation = request.runtime?.sandboxAllocation ?? request.environmentSandboxAllocation;
  if (allocation === undefined) return true;
  const parsed = sandboxAllocationSchema.safeParse(allocation);
  return !parsed.success || getSandboxAllocationProvider(parsed.data) === 'cloudflare-containers';
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
 * The two profile flags are only used by the continuation handler.
 */
export type SessionCreationPolicyOptions = {
  includeWebDefaults?: boolean;
  continuationModeResolution?: boolean;
  hostedAdditionalRepositoryIds?: number[] | undefined;
};

type SessionCreationContext = Pick<
  TRPCContext,
  'env' | 'userId' | 'authToken' | 'cloudAgentAuthority'
> &
  Partial<Pick<TRPCContext, 'request'>>;
type EndpointValidator = (request: SessionCreateRequest) => void | Promise<void>;

/**
 * The setup run a session serves, from the two trusted request fields. A setup
 * session must be started by the server on a run that is still `starting`, and
 * its draft must be the requested environment. A verification session is a
 * child of that setup workspace, whose stored authority must agree with the request.
 */
async function resolveEnvironmentSetupBinding(
  ctx: Pick<TRPCContext, 'env' | 'userId' | 'cloudAgentAuthority'>,
  request: SessionCreateRequest,
  workspaceSetup: CloudAgentAuthority['environmentSetup'],
  db?: WorkerDb
): Promise<EnvironmentSetupBinding | undefined> {
  const setupRunId = request.environmentSetupRunId;
  if (setupRunId === undefined && request.verificationOf === undefined) return undefined;

  const setupRunDb = db ?? getPgDb(ctx.env);
  const owner = environmentOwnerForSession(ctx, request);

  if (setupRunId !== undefined) {
    if (request.verificationOf !== undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid environment setup request' });
    }
    // The server starts setup sessions on the internal key. A scoped child can
    // never take the setup role.
    if (ctx.cloudAgentAuthority !== undefined) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Environment setup run is not available' });
    }
    const environmentId = request.requestedEnvironment?.id;
    if (environmentId === undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid environment setup request' });
    }
    const run = await loadSetupRunForSession(setupRunDb, { runId: setupRunId, owner });
    if (!run || run.status !== 'starting' || run.draftEnvironmentId !== environmentId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Environment setup run is not available' });
    }
    return { runId: setupRunId, environmentId, role: 'setup' };
  }

  const verificationOf = request.verificationOf;
  if (verificationOf === undefined) return undefined;
  const environmentId = request.requestedEnvironment?.id;
  const claim = ctx.cloudAgentAuthority?.environmentSetup;
  if (
    claim === undefined ||
    claim.runId !== verificationOf.runId ||
    claim.environmentId !== environmentId
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Environment verification is not permitted',
    });
  }
  if (
    workspaceSetup?.runId !== verificationOf.runId ||
    workspaceSetup.environmentId !== environmentId
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Environment verification is not permitted',
    });
  }
  const run = await loadSetupRunForSession(setupRunDb, { runId: verificationOf.runId, owner });
  if (
    !run ||
    !isAgentWritableSetupRunStatus(run.status) ||
    run.draftEnvironmentId !== environmentId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Environment setup run is not available' });
  }
  return { runId: verificationOf.runId, environmentId, role: 'verification' };
}

export async function preflightSessionCreation(
  request: SessionCreateRequest,
  ctx: SessionCreationContext,
  procedure: string,
  validateEndpoint?: EndpointValidator,
  policyOptions?: SessionCreationPolicyOptions
): Promise<SessionCreateRequest> {
  let inheritedConfiguration: WorkspaceSpawnConfiguration | undefined;
  let workspaceEgress: InheritedEgressPolicy | undefined;
  let workspaceSetup: CloudAgentAuthority['environmentSetup'];
  if (ctx.cloudAgentAuthority) {
    const authority = ctx.cloudAgentAuthority;
    if (
      request.parentCloudAgentSessionId !== authority.parentSessionId ||
      authority.ownerId !== ctx.userId ||
      (request.options?.kilocodeOrganizationId ?? null) !== authority.organizationId
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Cloud Agent parent binding mismatch' });
    }
    let token: string;
    let parentCreatedOnPlatform: string | undefined;
    try {
      // The workspace records the policy it was created with; the environment's
      // current settings do not apply to an existing workspace.
      const workspace = workspaceSpawnContextSchema.parse(
        await withDORetry(
          () => getWorkspaceStub(ctx.env, ctx.userId, authority.parentSessionId),
          stub => stub.getSpawnContext(authority),
          'getSpawnContext'
        )
      );
      token = workspace.token;
      parentCreatedOnPlatform = workspace.createdOnPlatform;
      inheritedConfiguration = workspace.configuration;
      workspaceEgress = workspace.egress;
      workspaceSetup = workspace.environmentSetup;
    } catch {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cloud Agent parent authorization unavailable',
      });
    }
    request.options = {
      ...request.options,
      createdOnPlatform: parentCreatedOnPlatform,
    };
    const internalApiKey = ctx.request?.headers.get('x-internal-api-key');
    const expectedInternalApiSecret = await readCloudAgentNextSecret(
      ctx.env,
      'INTERNAL_API_SECRET',
      ctx.executionCtx
    ).catch(() => undefined);
    const skipBalance =
      ctx.request?.headers.get('x-skip-balance-check') === 'true' &&
      typeof expectedInternalApiSecret === 'string' &&
      internalApiKey !== undefined &&
      internalApiKey !== null &&
      timingSafeEqual(internalApiKey, expectedInternalApiSecret);
    if (!skipBalance) {
      const balance = await validateBalanceOnly(
        token,
        authority.organizationId ?? undefined,
        ctx.env,
        ctx.executionCtx
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

  if (policyOptions?.hostedAdditionalRepositoryIds?.length) {
    request = await resolveHostedWorkspaceRepositories(
      ctx,
      request,
      policyOptions.hostedAdditionalRepositoryIds
    );
  } else {
    await assertRepositoryAccessBeforeSessionCreation({
      env: ctx.env,
      userId: ctx.userId,
      orgId: organizationId,
      createdOnPlatform: request.options?.createdOnPlatform,
      repository: request.repository,
    });
  }

  const binding = await resolveEnvironmentSetupBinding(ctx, request, workspaceSetup, db);

  const policy: ProfileResolutionPolicy = policyOptions?.includeWebDefaults
    ? { defaultProfileResolution: 'include-web-defaults' }
    : profileResolutionPolicyForSessionCreateOrigin(request.options?.createdOnPlatform);
  const inheritedRequest =
    binding === undefined ? inheritSpawnConfiguration(request, inheritedConfiguration) : undefined;
  let resolvedRequest =
    inheritedRequest ??
    (await resolveEffectiveSessionConfiguration(ctx, request, policy, db, binding));
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
    workspaceEgress &&
    workspaceSetup === undefined &&
    request.runtime?.egressMode === undefined &&
    request.runtime?.egressAllowlist === undefined
  ) {
    const { egressAllowlist, ...inheritedPolicy } = workspaceEgress;
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
  if (
    binding?.role === 'verification' &&
    workspaceEgress?.egressAudit === true &&
    supportsEgressAudit(resolvedRequest)
  ) {
    resolvedRequest = {
      ...resolvedRequest,
      runtime: { ...resolvedRequest.runtime, egressAudit: true },
    };
  }
  assertModeAvailableForProfile(
    resolvedRequest.agent.mode,
    resolvedRequest.profile?.resolved ?? {},
    procedure === 'prepareSession' &&
      isRepositoryAgentOrigin(resolvedRequest.options?.createdOnPlatform)
  );
  await validateEndpoint?.(resolvedRequest);

  // Only a model the caller's organization catalogue makes available may serve a
  // session. This create-time check answers that for a prompt turn. A policy-bearing
  // bearer is checked in `issueSessionRuntimeAuthorization`, once the runtime
  // authorization exists. The AI gateway enforces the same requirement for the
  // session at inference time (`resolveProviderAndPolicy` ->
  // `getEffectiveModelDecision`).
  if (resolvedRequest.initialTurn?.type === 'prompt' && !isPolicyBearingAuthToken(ctx.authToken)) {
    await assertKiloModelAvailable({
      env: ctx.env,
      ctx: ctx.executionCtx,
      submittedModel: resolvedRequest.agent.model,
      originalToken: ctx.authToken,
      originalOrganizationId: resolvedRequest.options?.kilocodeOrganizationId,
      createdOnPlatform: resolvedRequest.options?.createdOnPlatform,
      procedure,
    });
  }

  return resolvedRequest;
}
