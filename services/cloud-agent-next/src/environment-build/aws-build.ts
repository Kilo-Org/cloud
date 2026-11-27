import type { AwsScmAdmission } from '../egress/aws-scm-admission.js';
import type { EnvironmentBuildGit } from '../shared/environment-build-protocol.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';
import { grantScmEntries } from '../sandbox-control/session-credential-members.js';
import type { AwsEgressProof } from '../egress/aws-scoped-admission.js';
import type { SnapshotCaptureResult } from '../sandbox-control/snapshots.js';
import type { BuilderLifecycleState } from './builder-state.js';
import type { BuilderLaunch } from './builder-provider.js';
import { awsBuildOwner, type AwsEc2BuilderAllocation } from './aws-ec2-build-target.js';
import { awsEc2BuildIdentity, createAwsEc2BuilderLifecycle } from './aws-ec2-builder.js';
import { awsEc2Ref } from '../sandbox-control/aws-ec2-lifecycle.js';
import { readAwsBuildState } from './aws-build-state.js';
import {
  createAwsBuildContexts,
  AwsBuildInactiveError,
  type AwsBuildContextDeps,
  type AwsPinnedBuild,
} from './aws-build-context.js';
import {
  createAwsBuildEgressAdmission,
  type AwsBuildEgressContext,
} from './aws-egress-admission.js';
import {
  issueBuildScmGrant,
  resolveBuildScmCredential,
  awsBuildOutboundContainerId,
  type BuildScmGrant,
} from './scm-credentials.js';
import { buildInputMembers } from './build-input.js';
import { BuilderStateInvalidError } from './builder-errors.js';
import type { BuilderProvider } from './builder-provider.js';

/**
 * Egress authority for one build. A retired grant, or a build that left `preparing`, yields no SCM
 * grant or live member, and the identity binding changes on retirement to fence in-flight admissions.
 */
export function awsBuildEgressContext(
  env: AwsBuildContextDeps['env'],
  context: AwsPinnedBuild,
  available: boolean
): AwsBuildEgressContext {
  const { allocation, build, input, state } = context;
  const scm = state.scm === 'retired' ? undefined : state.scm;
  const scmActive = available && scm !== undefined;
  const ec2 = state.workspace ?? null;
  const providerRef = ec2 ? awsEc2Ref(ec2) : null;
  return {
    environmentId: allocation.environmentId,
    buildId: build.id,
    actorUserId: allocation.actorUserId,
    sandboxId: allocation.sandboxId,
    ownerId: allocation.actorUserId,
    provider: allocation.provider,
    containmentEnabled: true,
    available,
    byoc: { ...awsBuildOwner(allocation.owner), credentialId: allocation.target.credentialId },
    ec2,
    ec2Build: awsEc2BuildIdentity(allocation),
    allocation: { active: available, allocationId: allocation.allocationId, providerRef },
    outboundContainerId: awsBuildOutboundContainerId(allocation),
    grants: scmActive && scm ? [scm] : [],
    liveMemberIds: scmActive ? [build.id] : [],
    identityBinding: JSON.stringify([
      build.id,
      build.revision,
      build.deadline_at,
      build.input,
      state.scm === 'retired' ? 'retired' : 'active',
    ]),
    allowlist:
      input.egressPolicy?.egressMode === 'allowlist'
        ? buildNativeEgressAllowlist({
            env,
            allowlist: input.egressPolicy.egressAllowlist ?? [],
            providerRoutingTargets: [],
          })
        : undefined,
    // Build input stores no audit setting, so build egress is not audited.
    audit: false,
  };
}

/** AWS build behavior uses the same compute, snapshot and admission components as sessions. */
export function createAwsEnvironmentBuildServices(deps: AwsBuildContextDeps) {
  const contexts = createAwsBuildContexts(deps);
  const ec2 = createAwsEc2BuilderLifecycle(deps.env, deps.now);
  let tail = Promise.resolve();
  let queued = 0;
  async function serial<T>(operation: () => Promise<T>): Promise<T> {
    if (queued >= 16) throw new Error('AWS build admission queue is full');
    queued++;
    const queuedAt = Date.now();
    const result = tail.then(() => {
      if (Date.now() - queuedAt > 15_000) throw new Error('AWS build admission queue expired');
      return operation();
    });
    tail = result.then(
      () => undefined,
      () => undefined
    );
    try {
      return await result;
    } finally {
      queued--;
    }
  }
  function persistScm(initial: AwsPinnedBuild, grant: BuildScmGrant): void {
    deps.transaction(() => {
      contexts.assertActive(initial);
      const state = readAwsBuildState(
        deps.store.providerState(initial.build.id),
        initial.allocation
      );
      if (state.scm === 'retired') throw new AwsBuildInactiveError();
      deps.store.setProviderState(
        initial.build.id,
        readAwsBuildState({ ...state, scm: grant }, initial.allocation)
      );
    });
  }
  async function egressContext(buildId: string): Promise<AwsBuildEgressContext> {
    let context: AwsPinnedBuild;
    let available = true;
    try {
      context = await contexts.active(buildId);
    } catch (error) {
      if (!(error instanceof AwsBuildInactiveError)) throw error;
      context = contexts.pinned(buildId);
      available = false;
    }
    return awsBuildEgressContext(deps.env, context, available);
  }
  const admissions = new Map<string, ReturnType<typeof createAwsBuildEgressAdmission>>();
  function admission(buildId: string) {
    const cached = admissions.get(buildId);
    if (cached) return cached;
    const created = createAwsBuildEgressAdmission({
      env: deps.env,
      serial,
      readContext: () => egressContext(buildId),
      now: contexts.now,
      resolve: input => resolveBuildScmCredential({ ...input, env: deps.env, now: contexts.now() }),
      persist: grant => persistScm(contexts.pinned(buildId), grant),
    });
    if (admissions.size >= 32) {
      const oldest = admissions.keys().next().value;
      if (oldest) admissions.delete(oldest);
    }
    admissions.set(buildId, created);
    return created;
  }
  return {
    snapshotCleanup: {
      manages: provider => provider === 'aws-ec2',
      async release(snapshot, allocation, state) {
        if (
          snapshot.provider !== 'aws-ec2' ||
          allocation.provider !== 'aws-ec2' ||
          allocation.buildId !== snapshot.buildId ||
          allocation.environmentId !== snapshot.environmentId
        )
          throw new BuilderStateInvalidError();
        return ec2.releaseSnapshot(allocation, state, snapshot.snapshotId);
      },
    } satisfies NonNullable<BuilderProvider['snapshotCleanup']>,
    async launch(
      allocation: AwsEc2BuilderAllocation,
      launch: BuilderLaunch,
      state: BuilderLifecycleState
    ) {
      const context = await contexts.active(allocation.buildId);
      contexts.assertAllocation(context, allocation);
      return ec2.launch(allocation, launch, state, () => contexts.assertActive(context));
    },
    async stop(allocation: AwsEc2BuilderAllocation, state: BuilderLifecycleState) {
      const context = contexts.pinned(allocation.buildId);
      contexts.assertAllocation(context, allocation);
      return ec2.stop(allocation, state, context.build.outcome === 'succeeded');
    },
    async capture(
      allocation: AwsEc2BuilderAllocation,
      captureId: string,
      state: BuilderLifecycleState
    ): Promise<SnapshotCaptureResult> {
      const context = contexts.pinned(allocation.buildId);
      contexts.assertAllocation(context, allocation);
      return ec2.capture(allocation, captureId, state);
    },
    async input(buildId: string): Promise<EnvironmentBuildGit[]> {
      const initial = await contexts.active(buildId);
      if (initial.state.workspace?.phase !== 'active') throw new AwsBuildInactiveError();
      let grant = initial.state.scm;
      if (grant === 'retired') throw new AwsBuildInactiveError();
      if (!grant) {
        const issued = await issueBuildScmGrant({
          env: deps.env,
          provider: initial.allocation.provider,
          owner: {
            environmentId: initial.allocation.environmentId,
            buildId,
            allocationId: initial.allocation.allocationId,
            sandboxId: initial.allocation.sandboxId,
            userId: initial.allocation.actorUserId,
            ...(initial.allocation.owner.type === 'organization'
              ? { orgId: initial.allocation.owner.id }
              : {}),
          },
          members: buildInputMembers(initial.input),
          now: contexts.now(),
          deadlineAt: initial.build.deadline_at,
        });
        await contexts.active(buildId);
        const stored = await contexts.state(buildId).update(raw => {
          contexts.assertActive(initial);
          const state = readAwsBuildState(raw, initial.allocation);
          return state.scm
            ? state
            : readAwsBuildState({ ...state, scm: issued }, initial.allocation);
        });
        grant = readAwsBuildState(stored, initial.allocation).scm;
      }
      if (grant === 'retired') throw new AwsBuildInactiveError();
      if (!grant) throw new BuilderStateInvalidError();
      const sources = grantScmEntries(grant).map(entry => {
        if (entry.repository.type === 'git' || !entry.scm.alias)
          throw new BuilderStateInvalidError();
        return { url: entry.scm.gitUrl, token: entry.scm.alias, platform: entry.repository.type };
      });
      contexts.assertActive(initial);
      return sources;
    },
    retireScm(buildId: string): void {
      const initial = contexts.pinned(buildId);
      deps.transaction(() => {
        contexts.assertActive(initial);
        const state = readAwsBuildState(deps.store.providerState(buildId), initial.allocation);
        deps.store.setProviderState(buildId, { ...state, scm: 'retired' });
      });
    },
    assertReady(buildId: string): void {
      const context = contexts.pinned(buildId);
      contexts.assertActive(context);
      if (context.state.scm !== 'retired') throw new AwsBuildInactiveError();
    },
    policy: (buildId: string, proof: AwsEgressProof) => admission(buildId).policy(proof),
    audit: (buildId: string, proof: AwsEgressProof, value: unknown) =>
      admission(buildId).audit(proof, value),
    admitScm: (buildId: string, proof: AwsEgressProof, request: AwsScmAdmission) =>
      admission(buildId).admitScm(proof, request),
  };
}
export type AwsEnvironmentBuildServices = ReturnType<typeof createAwsEnvironmentBuildServices>;
