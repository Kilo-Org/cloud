import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ProviderLifecycleError } from '../sandbox-control/provider-failure.js';
import type { AwsEc2EgressClaims } from '@kilocode/worker-utils/aws-egress';
import { resolveSecret } from '../auth.js';
import { createAwsEc2RuntimeAccess, prepareAwsEc2Host } from '../byoc/aws-ec2-runtime.js';
import { awsEc2Ref, createAwsEc2Lifecycle } from '../sandbox-control/aws-ec2-lifecycle.js';
import { createAwsEc2SnapshotCapture } from '../sandbox-control/aws-ec2-snapshot.js';
import { downloadedStartup } from '../sandbox-control/downloaded-startup.js';
import {
  ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT,
  ENVIRONMENT_BUILD_RUNNER_ENV,
} from '../shared/environment-build-protocol.js';
import type { Env } from '../types.js';
import { readAwsBuildState } from './aws-build-state.js';
import { BuilderRetryableError, BuilderStateInvalidError } from './builder-errors.js';
import type { BuilderLaunch } from './builder-provider.js';
import type { BuilderLifecycleState } from './builder-state.js';
import {
  resolveAwsEc2BuildConfiguration,
  type AwsEc2BuilderAllocation,
} from './aws-ec2-build-target.js';
import { verifyRunnerCredential } from './runner-credential.js';

const RETRYABLE_START_REASONS: ReadonlySet<string> = new Set([
  'byoc_aws_not_ready',
  'byoc_aws_stack_unavailable',
]);

/**
 * A transient AWS fault keeps the build preparing, and the next tick starts it again within the build
 * deadline. Setup reads reach this point already normalized to `ProviderLifecycleError`.
 */
function awsBuilderStartFailure(error: unknown): unknown {
  if (
    error instanceof AwsRequestError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  )
    return new BuilderRetryableError('AWS builder request is temporarily unavailable');
  if (error instanceof ProviderLifecycleError && RETRYABLE_START_REASONS.has(error.reason))
    return new BuilderRetryableError('AWS builder setup is temporarily unavailable');
  return error;
}

export function awsEc2BuildIdentity(
  allocation: AwsEc2BuilderAllocation
): NonNullable<AwsEc2EgressClaims['build']> {
  return {
    environmentId: allocation.environmentId,
    buildId: allocation.buildId,
    actorUserId: allocation.actorUserId,
    credentialId: allocation.target.credentialId,
  };
}

export function createAwsEc2BuilderLifecycle(env: Env, now = Date.now) {
  const runtime = createAwsEc2RuntimeAccess(env);
  const mutations = new Map<string, Promise<void>>();

  function serialize<T>(buildId: string, run: () => Promise<T>): Promise<T> {
    const result = (mutations.get(buildId) ?? Promise.resolve()).then(run);
    const tail = result.then(
      () => {},
      () => {}
    );
    mutations.set(buildId, tail);
    void tail.then(() => {
      if (mutations.get(buildId) === tail) mutations.delete(buildId);
    });
    return result;
  }

  function bind(
    allocation: AwsEc2BuilderAllocation,
    state: BuilderLifecycleState,
    assertActive?: () => void
  ) {
    const read = (raw: unknown) => readAwsBuildState(raw, allocation);
    const configuration = () => resolveAwsEc2BuildConfiguration(env, allocation);
    const controller = createAwsEc2Lifecycle({
      sandboxId: allocation.sandboxId,
      configuration,
      runtime,
      now,
      assertLaunchActive: assertActive,
      serialize: run => serialize(allocation.buildId, run),
      prepareHost: workspace =>
        prepareAwsEc2Host(env, allocation.sandboxId, workspace, awsEc2BuildIdentity(allocation)),
      storage: {
        async get() {
          return read(await state.get()).workspace;
        },
        async put(workspace) {
          await state.update(raw => {
            const current = read(raw);
            if (!current.workspace) assertActive?.();
            return read({ ...current, workspace });
          });
        },
        async delete() {
          await state.update(raw => ({ ...read(raw), workspace: undefined }));
        },
      },
    });
    const captures = createAwsEc2SnapshotCapture({
      now,
      client: async config => (await runtime(config)).ec2,
      storage: {
        async get(id) {
          const capture = read(await state.get()).capture;
          return capture?.id === id ? capture.operation : undefined;
        },
        async update(id, transition) {
          await state.update(raw => {
            const current = read(raw);
            if (current.capture && current.capture.id !== id) throw new BuilderStateInvalidError();
            return read({
              ...current,
              capture: { id, operation: transition(current.capture?.operation) },
            });
          });
        },
        async delete(id) {
          await state.update(raw => {
            const current = read(raw);
            return current.capture?.id === id ? { ...current, capture: undefined } : current;
          });
        },
      },
    });
    return { configuration, controller, captures };
  }

  return {
    async releaseSnapshot(
      allocation: AwsEc2BuilderAllocation,
      state: BuilderLifecycleState,
      snapshotId: string
    ) {
      const capture = readAwsBuildState(await state.get(), allocation).capture;
      if (!capture) return 'done' as const;
      if (capture.operation.snapshotId !== snapshotId) throw new BuilderStateInvalidError();
      return bind(allocation, state).captures.discard(capture.id);
    },
    async launch(
      allocation: AwsEc2BuilderAllocation,
      launch: BuilderLaunch,
      state: BuilderLifecycleState,
      assertActive: () => void
    ) {
      const secret = await resolveSecret(env.NEXTAUTH_SECRET);
      const claims = secret ? verifyRunnerCredential(launch.runner.credential, secret) : null;
      if (
        !claims ||
        claims.environmentId !== allocation.environmentId ||
        claims.buildId !== allocation.buildId ||
        claims.allocationId !== allocation.allocationId ||
        !env.RUNTIME_RELEASE_DESCRIPTOR
      )
        throw new BuilderStateInvalidError();
      const { configuration, controller } = bind(allocation, state, assertActive);
      try {
        const config = await configuration();
        await (await runtime(config)).verifyLaunch();
        const deadlineAt = Math.min(launch.deadlineAt, now() + 5 * 60_000);
        const command = await downloadedStartup({
          env,
          descriptor: env.RUNTIME_RELEASE_DESCRIPTOR,
          sandboxId: allocation.sandboxId,
          allocationId: allocation.allocationId,
          deadlineAt,
          mainProcess: 'environment-builder',
          reportUrl: `${launch.runner.url}/startup-failure`,
        });
        assertActive();
        const ref = await controller.reserve(allocation.allocationId, undefined, config);
        await controller.launch(
          ref,
          {
            command: {
              argv: [
                '/bin/sh',
                '-c',
                `${ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT}\nunset ${ENVIRONMENT_BUILD_RUNNER_ENV}\nexec "$@"`,
                'aws-environment-builder',
                ...command.argv,
              ],
              user: 'root',
            },
            env: {
              [ENVIRONMENT_BUILD_RUNNER_ENV]: JSON.stringify(launch.runner),
              SANDBOX_CONTROL_CREDENTIAL: launch.runner.credential,
            },
          },
          deadlineAt
        );
      } catch (error) {
        throw awsBuilderStartFailure(error);
      }
    },
    async capture(allocation: AwsEc2BuilderAllocation, id: string, state: BuilderLifecycleState) {
      const { controller, captures } = bind(allocation, state);
      const prior = readAwsBuildState(await state.get(), allocation).capture;
      if (prior?.id === id) return captures.poll(id);
      if ((await controller.stop(allocation.allocationId)) === 'pending')
        return { status: 'in_progress' } as const;
      const workspace = await controller.read();
      const volumeId = workspace?.volumes?.data;
      if (workspace && volumeId) {
        const started = await controller.captureStopped(awsEc2Ref(workspace), source =>
          captures.start(id, {
            config: source.config,
            generation: source.generation,
            volumeId,
            baseImage: allocation.target.baseImage,
          })
        );
        if (started) return captures.poll(id);
      }
      return { status: 'failed', reason: 'snapshot_failed' } as const;
    },
    async stop(
      allocation: AwsEc2BuilderAllocation,
      state: BuilderLifecycleState,
      publish: boolean
    ) {
      const { controller, captures } = bind(allocation, state);
      const workspace = await controller.read();
      if (workspace && (await controller.destroy(workspace.generation)) === 'pending')
        return 'retryable' as const;
      const capture = readAwsBuildState(await state.get(), allocation).capture;
      if (capture && !publish && (await captures.discard(capture.id)) === 'pending')
        return 'retryable' as const;
      return 'terminal' as const;
    },
  };
}
