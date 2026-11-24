import type { AwsScmAdmission } from '../egress/aws-scm-admission.js';
import type { EnvironmentBuildArchiveRequest } from '../shared/environment-build-archive.js';
import { environmentBuildArchiveUploadSchema } from '../shared/environment-build-archive.js';
import type { EnvironmentBuildGit } from '../shared/environment-build-protocol.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';
import { grantScmEntries } from '../sandbox-control/session-credential-members.js';
import { encodeAwsEcsProviderRef } from '../sandbox-control/aws-ecs-operation.js';
import type { AwsEgressProof } from '../egress/aws-scoped-admission.js';
import { awsAccountAccess } from '../byoc/aws-account-access.js';
import { createAwsRoleSessionCache } from '../byoc/aws-runtime-access.js';
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { NativeCaptureResult } from '../sandbox-containers/native-capture.js';
import type { BuilderLifecycleState } from './builder-state.js';
import type { BuilderLaunch } from './builder-provider.js';
import type { AwsBuilderAllocation } from './aws-build-target.js';
import { awsBuildOwner, resolveAwsBuildConfiguration } from './aws-build-target.js';
import { readAwsBuildState } from './aws-build-state.js';
import { createAwsBuilderLifecycle } from './aws-builder.js';
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
import { createAwsBuildArchiveStorage, AwsBuildArchiveError } from './aws-archive-storage.js';
import { BuilderStateInvalidError, BuilderTargetMismatchError } from './builder-errors.js';

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
  const operation = state.operation ?? null;
  const scm = state.scm === 'retired' ? undefined : state.scm;
  const scmActive = available && scm !== undefined;
  const providerRef = operation ? encodeAwsEcsProviderRef(operation.ref) : null;
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
    credentialHash: state.credentialHash,
    operation,
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
            providerRoutingTargets: operation
              ? [`https://${operation.config.bucket}.s3.${operation.config.region}.amazonaws.com`]
              : [],
          })
        : undefined,
    // Build input stores no audit setting, so build egress is not audited.
    audit: false,
  };
}

/** AWS build behavior uses the same compute, archive and admission components as sessions. */
export function createAwsEnvironmentBuildServices(deps: AwsBuildContextDeps) {
  const contexts = createAwsBuildContexts(deps);
  const compute = createAwsBuilderLifecycle(deps);
  const access = createAwsRoleSessionCache((config: AwsEcsByocConfiguration) =>
    awsAccountAccess(deps.env, config)
  );
  // This queue covers broker renewals and archive reservations. Lifecycle cancellation uses SQLite directly.
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
  async function archives(initial: AwsPinnedBuild) {
    const operation = initial.state.operation;
    if (!operation) throw new AwsBuildInactiveError();
    const configuration = await resolveAwsBuildConfiguration(deps.env, initial.allocation);
    if (JSON.stringify(configuration) !== JSON.stringify(operation.config))
      throw new BuilderTargetMismatchError();
    const { objects } = await access(configuration);
    return createAwsBuildArchiveStorage({
      now: contexts.now,
      serial,
      objects,
      async readContext() {
        const current = contexts.pinned(initial.build.id);
        if (current.build.state === 'preparing') await contexts.active(current.build.id);
        return {
          environmentId: current.allocation.environmentId,
          buildId: current.build.id,
          allocationId: current.allocation.allocationId,
          baseImage: current.allocation.target.baseImage,
          deadlineAt: current.build.deadline_at,
          state:
            current.build.state === 'preparing' || current.build.state === 'capturing'
              ? current.build.state
              : 'inactive',
          ...(current.build.capture_id ? { captureId: current.build.capture_id } : {}),
          archive: readAwsBuildState(deps.store.providerState(current.build.id), current.allocation)
            .archive,
        };
      },
      persist(archive) {
        deps.transaction(() => {
          contexts.assertActive(initial);
          const state = readAwsBuildState(
            deps.store.providerState(initial.build.id),
            initial.allocation
          );
          deps.store.setProviderState(
            initial.build.id,
            readAwsBuildState({ ...state, archive }, initial.allocation)
          );
        });
      },
    });
  }
  return {
    async launch(
      allocation: AwsBuilderAllocation,
      launch: BuilderLaunch,
      state: BuilderLifecycleState
    ) {
      const context = await contexts.active(allocation.buildId);
      contexts.assertAllocation(context, allocation);
      return compute.launch(allocation, launch, state, () => contexts.assertActive(context));
    },
    async stop(allocation: AwsBuilderAllocation, state: BuilderLifecycleState) {
      contexts.assertAllocation(contexts.pinned(allocation.buildId), allocation);
      // S3 lifecycle expires prepared archives. Never race a still-valid PUT with an early delete.
      return compute.stop(allocation, state);
    },
    async capture(
      allocation: AwsBuilderAllocation,
      captureId: string
    ): Promise<NativeCaptureResult> {
      const context = contexts.pinned(allocation.buildId);
      contexts.assertAllocation(context, allocation);
      try {
        return await (await archives(context)).capture(captureId);
      } catch (error) {
        if (
          error instanceof AwsBuildArchiveError ||
          error instanceof BuilderStateInvalidError ||
          error instanceof BuilderTargetMismatchError
        )
          return { status: 'failed', reason: 'snapshot_failed' };
        throw error;
      }
    },
    async input(buildId: string): Promise<{ sources: EnvironmentBuildGit[]; baseImage: string }> {
      const initial = await contexts.active(buildId);
      if (!initial.state.operation?.request) throw new AwsBuildInactiveError();
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
      return { sources, baseImage: initial.allocation.target.baseImage };
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
      if (
        context.state.scm !== 'retired' ||
        !context.state.archive ||
        context.state.archive.verifiedAt === undefined
      )
        throw new AwsBuildArchiveError('archive_unverified');
    },
    async archive(buildId: string, request: EnvironmentBuildArchiveRequest) {
      const initial = await contexts.active(buildId);
      if (initial.state.scm !== 'retired') throw new AwsBuildArchiveError('build_inactive');
      const storage = await archives(initial);
      if (request.action === 'prepare')
        return environmentBuildArchiveUploadSchema.parse(
          await storage.prepareUpload(request.descriptor)
        );
      await storage.completeUpload();
      return { ok: true as const };
    },
    policy: (buildId: string, proof: AwsEgressProof) => admission(buildId).policy(proof),
    audit: (buildId: string, proof: AwsEgressProof, value: unknown) =>
      admission(buildId).audit(proof, value),
    admitScm: (buildId: string, proof: AwsEgressProof, request: AwsScmAdmission) =>
      admission(buildId).admitScm(proof, request),
  };
}
export type AwsEnvironmentBuildServices = ReturnType<typeof createAwsEnvironmentBuildServices>;
