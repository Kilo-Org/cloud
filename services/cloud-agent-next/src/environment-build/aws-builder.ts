import type { Env } from '../types.js';
import { resolveSecret } from '../auth.js';
import { hashSandboxCredential } from '../sandbox-control/credential.js';
import { createAwsProviderAdapter } from '../sandbox-control/aws-provider.js';
import { createAwsEcsProviderAdapter } from '../sandbox-control/aws-ecs-provider.js';
import { awsOperationSchema, encodeAwsProviderRef } from '../sandbox-control/aws-operation.js';
import {
  awsEcsOperationSchema,
  encodeAwsEcsProviderRef,
} from '../sandbox-control/aws-ecs-operation.js';
import type { AwsComputeAdapter } from '../sandbox-control/aws-compute-lifecycle.js';
import type { ProviderStartup } from '../sandbox-control/provider.js';
import { downloadedStartup } from '../sandbox-control/downloaded-startup.js';
import {
  createAwsRuntimeAccessResolver,
  createAwsEcsRuntimeAccessResolver,
} from '../byoc/aws-runtime-access.js';
import { validateAwsStartupStack, validateAwsEcsStartupStack } from '../byoc/aws-startup-stack.js';
import {
  awsProxyStartup,
  readPinnedAwsProxyDeployment,
  type AwsProxyMetadata,
} from '../byoc/aws-proxy.js';
import type { AwsEgressConfiguration } from '../egress/aws-scoped-admission.js';
import {
  ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT,
  ENVIRONMENT_BUILD_RUNNER_ENV,
} from '../shared/environment-build-protocol.js';
import type { AwsBuilderAllocation } from './aws-build-target.js';
import { resolveAwsBuildConfiguration } from './aws-build-target.js';
import { createAwsBuilderOperationStorage, readAwsBuildState } from './aws-build-state.js';
import type { BuilderLifecycleState } from './builder-state.js';
import type { BuilderLaunch } from './builder-provider.js';
import {
  BuilderRetryableError,
  BuilderStateInvalidError,
  BuilderTargetMismatchError,
} from './builder-errors.js';
import { mintAwsBuildEgressCredential } from './aws-egress-credential.js';
import { verifyRunnerCredential } from './runner-credential.js';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ProviderLifecycleError } from '../sandbox-control/provider-failure.js';

const RETRYABLE_START_REASONS: ReadonlySet<string> = new Set([
  'byoc_aws_not_ready',
  'byoc_aws_proxy_unavailable',
]);

/**
 * A transient AWS fault keeps the build preparing, and the next tick starts it again within the build
 * deadline. Setup reads reach this point already normalized to `ProviderLifecycleError`.
 */
export function awsBuilderStartFailure(error: unknown): unknown {
  if (
    error instanceof AwsRequestError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  )
    return new BuilderRetryableError('AWS builder request is temporarily unavailable');
  if (error instanceof ProviderLifecycleError && RETRYABLE_START_REASONS.has(error.reason))
    return new BuilderRetryableError('AWS builder setup is temporarily unavailable');
  return error;
}

/** Compute differs by engine. Launch ordering, proxy setup and runner delivery stay common. */
export function createAwsBuilderLifecycle(deps: { env: Env; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const microvmAccess = createAwsRuntimeAccessResolver(deps.env);
  const ecsAccess = createAwsEcsRuntimeAccessResolver(deps.env);
  type Prepare = (
    startup: ProviderStartup,
    config: AwsEgressConfiguration,
    read: (signal?: AbortSignal) => Promise<AwsProxyMetadata>
  ) => Promise<ProviderStartup>;
  function adapter(
    allocation: AwsBuilderAllocation,
    state: BuilderLifecycleState,
    beforeLaunch: () => void,
    prepare: Prepare
  ): AwsComputeAdapter {
    if (allocation.provider === 'aws')
      return createAwsProviderAdapter({
        sandboxId: allocation.sandboxId,
        now,
        storage: createAwsBuilderOperationStorage({
          allocation,
          state,
          schema: awsOperationSchema,
          beforeLaunch,
        }),
        resolveRuntime: async pinned => {
          if (pinned) return microvmAccess(pinned);
          const selected = await resolveAwsBuildConfiguration(deps.env, allocation);
          if (selected.provider !== 'aws') throw new BuilderTargetMismatchError();
          return microvmAccess(selected.configuration);
        },
        async prepareStartup(input) {
          const access = await microvmAccess(input.configuration);
          await validateAwsStartupStack({
            configuration: input.configuration,
            read: signal => access.readStack(input.configuration.stackId, signal),
          });
          return prepare(input.startup, input.configuration, access.readProxyMetadata);
        },
      });
    return createAwsEcsProviderAdapter({
      sandboxId: allocation.sandboxId,
      now,
      storage: createAwsBuilderOperationStorage({
        allocation,
        state,
        schema: awsEcsOperationSchema,
        beforeLaunch,
      }),
      resolveRuntime: async pinned => {
        if (pinned) return ecsAccess(pinned);
        const selected = await resolveAwsBuildConfiguration(deps.env, allocation);
        if (selected.provider !== 'aws-ecs') throw new BuilderTargetMismatchError();
        return ecsAccess(selected.configuration);
      },
      async prepareStartup(input) {
        const access = await ecsAccess(input.configuration);
        await validateAwsEcsStartupStack({
          configuration: input.configuration,
          read: signal => access.readStack(input.configuration.stackId, signal),
        });
        return prepare(input.startup, input.configuration, access.readProxyMetadata);
      },
    });
  }
  return {
    async launch(
      allocation: AwsBuilderAllocation,
      launch: BuilderLaunch,
      state: BuilderLifecycleState,
      assertActive: () => void
    ): Promise<void> {
      assertActive();
      const secret = await resolveSecret(deps.env.NEXTAUTH_SECRET);
      const claims = secret ? verifyRunnerCredential(launch.runner.credential, secret) : null;
      if (
        !secret ||
        !claims ||
        claims.environmentId !== allocation.environmentId ||
        claims.buildId !== allocation.buildId ||
        claims.allocationId !== allocation.allocationId
      )
        throw new BuilderStateInvalidError();
      const credentialHash = await hashSandboxCredential(claims.credential);
      await state.update(raw => {
        assertActive();
        const current = readAwsBuildState(raw, allocation);
        if (current.credentialHash && current.credentialHash !== credentialHash)
          throw new BuilderStateInvalidError();
        return { ...current, credentialHash };
      });
      const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
      if (!descriptor) throw new BuilderStateInvalidError();
      const startupDeadlineAt = Math.min(launch.deadlineAt, now() + 5 * 60_000);
      const command = await downloadedStartup({
        env: deps.env,
        descriptor,
        sandboxId: allocation.sandboxId,
        allocationId: allocation.allocationId,
        deadlineAt: startupDeadlineAt,
        mainProcess: 'environment-builder',
        reportUrl: `${launch.runner.url}/startup-failure`,
      });
      const compute = adapter(
        allocation,
        state,
        assertActive,
        async (startup, configuration, readMetadata) => {
          const { deployment } = await readPinnedAwsProxyDeployment(configuration, readMetadata);
          assertActive();
          if (Date.parse(deployment.expiresAt) <= launch.deadlineAt + 60_000)
            throw new BuilderTargetMismatchError();
          const credential = mintAwsBuildEgressCredential(
            {
              runnerCredential: launch.runner.credential,
              provider: allocation.provider,
              environmentId: allocation.environmentId,
              buildId: allocation.buildId,
              allocationId: allocation.allocationId,
              sandboxId: allocation.sandboxId,
              actorUserId: allocation.actorUserId,
              credentialId: allocation.target.credentialId,
              generation: deployment.generation,
              stackId: configuration.stackId,
              expiresAt: Math.min(launch.deadlineAt, Date.parse(deployment.expiresAt)),
            },
            secret
          );
          return awsProxyStartup(startup, deployment, credential);
        }
      );
      try {
        const created = await compute.create({
          intentId: allocation.allocationId,
          createdAt: now(),
        });
        assertActive();
        if (!('providerRef' in created))
          throw new BuilderRetryableError('AWS builder identity is unresolved');
        await compute.launch(
          created.providerRef,
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
              // Only the owning builder callback accepts this runner-purpose credential.
              SANDBOX_CONTROL_CREDENTIAL: launch.runner.credential,
            },
          },
          { deadlineAt: startupDeadlineAt }
        );
      } catch (error) {
        throw awsBuilderStartFailure(error);
      }
      assertActive();
    },
    async stop(
      allocation: AwsBuilderAllocation,
      state: BuilderLifecycleState
    ): Promise<'terminal' | 'retryable'> {
      const current = readAwsBuildState(await state.get(), allocation);
      if (!current.operation) return 'terminal';
      const ref =
        current.operation.ref.provider === 'aws'
          ? encodeAwsProviderRef(current.operation.ref)
          : encodeAwsEcsProviderRef(current.operation.ref);
      const refuseCreate = () => {
        throw new BuilderStateInvalidError();
      };
      const compute = adapter(allocation, state, refuseCreate, async () => {
        throw new BuilderStateInvalidError();
      });
      return compute.stop(ref);
    },
  };
}
