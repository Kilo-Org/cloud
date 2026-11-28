import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import type { Env } from '../types.js';
import type { ByocSource } from './owner.js';
import { awsRuntimeAccess, resolveAwsByocConfiguration } from './aws-credential-resolver.js';
import { createAwsProviderAdapter } from '../sandbox-control/aws-provider.js';
import type { AwsOperationStorage } from '../sandbox-control/aws-operation.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';

export function createByocAwsProviderAdapter(deps: {
  env: Env;
  /** The invocation's context, for a secret read's bundle revalidation. */
  ctx?: SecretsExecutionContext;
  source: ByocSource;
  sandboxId: string;
  storage: AwsOperationStorage;
}) {
  let cached: Awaited<ReturnType<typeof awsRuntimeAccess>> | undefined;
  let pending: Promise<Awaited<ReturnType<typeof awsRuntimeAccess>>> | undefined;
  let pendingKey: string | undefined;
  return createAwsProviderAdapter({
    sandboxId: deps.sandboxId,
    storage: deps.storage,
    async resolveRuntime(pinned?: AwsByocConfiguration) {
      const config = pinned ?? (await resolveAwsByocConfiguration(deps.env, deps.source, deps.ctx));
      const key = JSON.stringify(config);
      if (
        cached &&
        JSON.stringify(cached.config) === key &&
        cached.expiresAt > Date.now() + 15 * 60_000
      )
        return cached;
      if (pending && pendingKey === key) return pending;
      const request = awsRuntimeAccess(deps.env, config);
      pending = request;
      pendingKey = key;
      try {
        const resolved = await request;
        cached = resolved;
        return resolved;
      } finally {
        if (pending === request) {
          pending = undefined;
          pendingKey = undefined;
        }
      }
    },
  });
}
