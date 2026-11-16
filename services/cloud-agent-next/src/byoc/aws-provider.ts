import { validateAwsStartupStack } from './aws-startup-stack.js';
import { createAwsRuntimeAccessResolver } from './aws-runtime-access.js';
import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import type { Env } from '../types.js';
import type { ByocSource } from './owner.js';
import { resolveAwsByocConfiguration } from './aws-credential-resolver.js';
import { createAwsProviderAdapter } from '../sandbox-control/aws-provider.js';
import { resolveSecret } from '../auth.js';
import { prepareAwsProxyStartup } from './aws-proxy.js';
import type { AwsOperationStorage } from '../sandbox-control/aws-operation.js';

export function createByocAwsProviderAdapter(deps: {
  env: Env;
  source: ByocSource;
  sandboxId: string;
  storage: AwsOperationStorage;
}) {
  const access = createAwsRuntimeAccessResolver(deps.env);
  const resolveRuntime = async (pinned?: AwsByocConfiguration) =>
    access(pinned ?? (await resolveAwsByocConfiguration(deps.env, deps.source)));
  return createAwsProviderAdapter({
    sandboxId: deps.sandboxId,
    storage: deps.storage,
    resolveRuntime,
    async prepareStartup(input) {
      const access = await resolveRuntime(input.configuration);
      await validateAwsStartupStack({
        configuration: input.configuration,
        read: signal => access.readStack(input.configuration.stackId, signal),
      });
      const signingSecret = await resolveSecret(deps.env.NEXTAUTH_SECRET);
      if (!signingSecret) throw new Error('AWS egress signing unavailable');
      return prepareAwsProxyStartup({
        ...input,
        signingSecret,
        readMetadata: access.readProxyMetadata,
      });
    },
  });
}
