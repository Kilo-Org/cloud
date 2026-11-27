import type { BuilderRefusal } from './builder-errors.js';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import type { Env } from '../types.js';
import { enrolledByocOwner } from '../byoc/owner.js';
import { sameEnvironmentScope } from './reference.js';
import { environmentBuildActorAllowed, type EnvironmentActorAccess } from './access.js';
import { awsEc2BuildTargetSchema, type AwsEc2BuilderAllocation } from './aws-ec2-build-target.js';
import { builderSandboxIdForBuild } from './builder-identity.js';
import { createBuilderLifecycleState } from './builder-state.js';
import { readAwsBuildState } from './aws-build-state.js';
import { parseBuildInput, type BuildStore } from './store.js';
import { BuilderStateInvalidError } from './builder-errors.js';

export class AwsBuildInactiveError extends Error {
  constructor() {
    super('AWS environment build is inactive');
    this.name = 'AwsBuildInactiveError';
  }
}
export type AwsBuildContextDeps = {
  env: Env;
  store: Pick<BuildStore, 'build' | 'environment' | 'providerState' | 'setProviderState'>;
  transaction<T>(write: () => T): T;
  reference(environmentId: string): Promise<EnvironmentReference | null>;
  actorAccess(
    owner: EnvironmentReference['owner'],
    userId: string
  ): Promise<EnvironmentActorAccess>;
  refuse(buildId: string, reason: BuilderRefusal): Promise<void>;
  now?: () => number;
};

/** The environment DO owns lifecycle and synchronous state writes; PostgreSQL owns current actor access. */
export function createAwsBuildContexts(deps: AwsBuildContextDeps) {
  const now = deps.now ?? Date.now;
  function state(buildId: string) {
    return createBuilderLifecycleState({
      read: () => deps.store.providerState(buildId),
      write: value => deps.store.setProviderState(buildId, value),
      transaction: write => deps.transaction(write),
    });
  }
  function pinned(buildId: string) {
    const build = deps.store.build(buildId);
    if (!build || !build.allocation_id) throw new AwsBuildInactiveError();
    const input = parseBuildInput(build);
    const target = awsEc2BuildTargetSchema.safeParse(input.target);
    const environment = deps.store.environment();
    if (
      !target.success ||
      !environment ||
      environment.environmentId !== input.reference.environmentId ||
      build.revision !== input.reference.configurationRevision
    )
      throw new BuilderStateInvalidError();
    const scope = {
      environmentId: environment.environmentId,
      buildId: build.id,
      allocationId: build.allocation_id,
      actorUserId: build.actor_user_id,
      owner: input.reference.owner,
    };
    const allocation: AwsEc2BuilderAllocation = {
      ...scope,
      target: target.data,
      provider: 'aws-ec2',
      sandboxId: builderSandboxIdForBuild(build.id),
    };
    return {
      build,
      input,
      allocation,
      state: readAwsBuildState(deps.store.providerState(buildId), allocation),
    };
  }
  type Context = ReturnType<typeof pinned>;
  function assertActive(initial: Context): void {
    const current = deps.store.build(initial.build.id);
    const environment = deps.store.environment();
    if (
      !current ||
      current.state !== 'preparing' ||
      current.allocation_id !== initial.allocation.allocationId ||
      current.actor_user_id !== initial.allocation.actorUserId ||
      current.input !== initial.build.input ||
      current.deadline_at !== initial.build.deadline_at ||
      current.deadline_at <= now() ||
      !environment ||
      environment.environmentId !== initial.allocation.environmentId ||
      environment.deletedAt != null
    )
      throw new AwsBuildInactiveError();
  }
  async function refuse(context: Context, reason: BuilderRefusal): Promise<never> {
    await deps.refuse(context.build.id, reason);
    throw new AwsBuildInactiveError();
  }
  async function active(buildId: string): Promise<Context> {
    const initial = pinned(buildId);
    if (initial.build.state !== 'preparing') throw new AwsBuildInactiveError();
    if (initial.build.deadline_at <= now()) return refuse(initial, 'deadline');
    if (deps.store.environment()?.deletedAt != null) return refuse(initial, 'environment_deleted');
    const owner = initial.allocation.owner;
    if (
      !enrolledByocOwner(
        deps.env.BYOC_AWS_IDS,
        owner.type === 'organization' ? { orgId: owner.id } : { userId: owner.id }
      )
    )
      return refuse(initial, 'unsupported');
    const reference = await deps.reference(initial.allocation.environmentId);
    if (!reference) return refuse(initial, 'environment_deleted');
    if (
      reference.configurationRevision !== initial.build.revision ||
      !sameEnvironmentScope(reference, initial.input.reference)
    )
      return refuse(initial, 'configuration_changed');
    const access = await deps.actorAccess(owner, initial.allocation.actorUserId);
    if (!environmentBuildActorAllowed(access, initial.build.trigger))
      return refuse(initial, 'actor_unauthorized');
    assertActive(initial);
    return pinned(buildId);
  }
  function assertAllocation(context: Context, allocation: AwsEc2BuilderAllocation): void {
    const stored = context.allocation;
    if (
      stored.provider !== allocation.provider ||
      stored.sandboxId !== allocation.sandboxId ||
      stored.environmentId !== allocation.environmentId ||
      stored.buildId !== allocation.buildId ||
      stored.allocationId !== allocation.allocationId ||
      stored.actorUserId !== allocation.actorUserId ||
      stored.owner.type !== allocation.owner.type ||
      stored.owner.id !== allocation.owner.id ||
      stored.target.provider !== allocation.target.provider ||
      stored.target.credentialId !== allocation.target.credentialId ||
      stored.target.baseImage !== allocation.target.baseImage ||
      stored.target.instance !== allocation.target.instance
    )
      throw new BuilderStateInvalidError();
  }

  return { pinned, active, assertActive, assertAllocation, state, now };
}
export type AwsBuildContexts = ReturnType<typeof createAwsBuildContexts>;
export type AwsPinnedBuild = ReturnType<AwsBuildContexts['pinned']>;
