import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { Env } from '../types.js';
import { awsEcsRuntimeAccess } from './aws-credential-resolver.js';

/** Cache role sessions inside one owner. Each caller still checks current connection authorization. */
export function createAwsRoleSessionCache<
  Config,
  Access extends { config: Config; expiresAt: number },
>(resolve: (config: Config) => Promise<Access>, now = Date.now) {
  let cached: Access | undefined;
  let pending: Promise<Access> | undefined;
  let pendingKey: string | undefined;
  return async (configuration: Config) => {
    const key = JSON.stringify(configuration);
    if (cached && JSON.stringify(cached.config) === key && cached.expiresAt > now() + 15 * 60_000)
      return cached;
    if (pending && pendingKey === key) return pending;
    const request = resolve(configuration);
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
export function createAwsEcsRuntimeAccessResolver(env: Env) {
  return createAwsRoleSessionCache((configuration: AwsEcsByocConfiguration) =>
    awsEcsRuntimeAccess(env, configuration)
  );
}
