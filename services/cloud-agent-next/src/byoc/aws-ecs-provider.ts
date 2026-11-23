import type { prepareAwsSnapshotStartup } from '../sandbox-control/aws-snapshot-startup.js';
import type { Env } from '../types.js';
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { ByocSource } from './owner.js';
import { resolveAwsEcsByocConfiguration } from './aws-ecs-credential-resolver.js';
import { createAwsEcsRuntimeAccessResolver } from './aws-runtime-access.js';
import { createAwsEcsProviderAdapter } from '../sandbox-control/aws-ecs-provider.js';
import type { AwsEcsOperationStorage } from '../sandbox-control/aws-ecs-operation.js';
import { validateAwsEcsStartupStack } from './aws-startup-stack.js';
import { prepareAwsEcsProxyStartup } from './aws-proxy.js';
import { resolveSecret } from '../auth.js';

export function createByocAwsEcsProviderAdapter(deps: {
  env: Env;
  source: ByocSource;
  sandboxId: string;
  prepareSnapshot?: typeof prepareAwsSnapshotStartup;
  storage: AwsEcsOperationStorage;
}) {
  const prepareSnapshot = deps.prepareSnapshot;
  const access = createAwsEcsRuntimeAccessResolver(deps.env);
  const resolveRuntime = async (pinned?: AwsEcsByocConfiguration) =>
    access(pinned ?? (await resolveAwsEcsByocConfiguration(deps.env, deps.source)));
  return createAwsEcsProviderAdapter({
    sandboxId: deps.sandboxId,
    storage: deps.storage,
    resolveRuntime,
    ...(prepareSnapshot
      ? {
          async prepareSnapshot(input) {
            const runtime = await resolveRuntime(input.configuration);
            return prepareSnapshot({
              ...input,
              provider: 'aws-ecs',
              connectionId: deps.source.credentialId,
              currentConfiguration: () => resolveAwsEcsByocConfiguration(deps.env, deps.source),
              objects: runtime.objects,
              workerUrl: deps.env.WORKER_URL,
              sandboxId: deps.sandboxId,
              allocationId: input.ref.intentId,
            });
          },
        }
      : {}),
    async prepareStartup(input) {
      const runtime = await resolveRuntime(input.configuration);
      await validateAwsEcsStartupStack({
        configuration: input.configuration,
        read: signal => runtime.readStack(input.configuration.stackId, signal),
      });
      const signingSecret = await resolveSecret(deps.env.NEXTAUTH_SECRET);
      if (!signingSecret) throw new Error('AWS egress signing unavailable');
      return prepareAwsEcsProxyStartup({
        ...input,
        signingSecret,
        readMetadata: runtime.readProxyMetadata,
      });
    },
  });
}
