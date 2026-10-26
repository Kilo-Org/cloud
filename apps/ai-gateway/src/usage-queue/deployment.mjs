/** @param {Record<string, string | undefined>} env */
export function isStagingDeployment(env) {
  // The CLI runs before remote env is pulled; CI already supplies TARGET_ENVIRONMENT.
  // The hosted Next build instead receives VERCEL_TARGET_ENV. Conflicts fail closed.
  const targets = [env.TARGET_ENVIRONMENT, env.VERCEL_TARGET_ENV].filter(
    target => target !== undefined
  );
  return (
    env.VERCEL_ENV !== 'production' &&
    targets.length > 0 &&
    targets.every(target => target === 'staging')
  );
}

/** @param {Record<string, string | undefined>} env */
export function usageQueueDeployment(env) {
  return {
    ...(isStagingDeployment(env)
      ? {
          functions: {
            'src/app/api/v1/internal/queues/usage/route.ts': {
              experimentalTriggers: [
                {
                  type: 'queue/v2beta',
                  topic: 'usage-staging',
                  retryAfterSeconds: 60,
                  maxDeliveries: 20,
                  maxConcurrency: 200,
                },
              ],
              regions: ['fra1'],
            },
          },
        }
      : {}),
  };
}
