import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import type { Env } from '../types.js';
import { awsRuntimeAccess } from './aws-credential-resolver.js';

/** Cache role sessions inside one owner. Current connection authorization stays with each caller. */
export function createAwsRuntimeAccessResolver(env: Env) {
  let cached: Awaited<ReturnType<typeof awsRuntimeAccess>> | undefined;
  let pending: Promise<Awaited<ReturnType<typeof awsRuntimeAccess>>> | undefined;
  let pendingKey: string | undefined;
  return async (configuration: AwsByocConfiguration) => {
    const key = JSON.stringify(configuration);
    if (
      cached &&
      JSON.stringify(cached.config) === key &&
      cached.expiresAt > Date.now() + 15 * 60_000
    )
      return cached;
    if (pending && pendingKey === key) return pending;
    const request = awsRuntimeAccess(env, configuration);
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
  };
}
