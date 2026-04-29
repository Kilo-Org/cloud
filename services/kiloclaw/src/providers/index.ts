import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import { ProviderIdSchema, type ProviderId } from '../schemas/instance-config';
import type { KiloClawEnv } from '../types';
import type { InstanceProviderAdapter } from './types';
import { flyProviderAdapter } from './fly';
import { dockerLocalProviderAdapter } from './docker-local';
import { northflankProviderAdapter } from './northflank';

export function assertImplementedProvider(provider: ProviderId): void {
  switch (provider) {
    case 'fly':
    case 'docker-local':
    case 'northflank':
      return;
  }
}

function invalidProviderConfiguration(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function isDevelopmentWorker(env: Pick<KiloClawEnv, 'WORKER_ENV'>): boolean {
  return env.WORKER_ENV === 'development';
}

export function assertAvailableProvider(env: KiloClawEnv, provider: ProviderId): void {
  assertImplementedProvider(provider);
  if (provider === 'docker-local' && !isDevelopmentWorker(env)) {
    throw invalidProviderConfiguration('Provider docker-local is only available in development');
  }
  if (provider === 'northflank') {
    const requiredNorthflankKeys = [
      'NF_API_TOKEN',
      'NF_REGION',
      'NF_DEPLOYMENT_PLAN',
      'NF_EDGE_HEADER_NAME',
      'NF_EDGE_HEADER_VALUE',
      'NF_IMAGE_PATH_TEMPLATE',
    ] satisfies Array<keyof KiloClawEnv>;
    const missing = requiredNorthflankKeys.filter(key => !env[key]);
    if (missing.length > 0) {
      throw invalidProviderConfiguration(
        `Provider northflank is not configured; missing ${missing.join(', ')}`,
        503
      );
    }
  }
}

export function resolveDefaultProvider(
  env: Pick<KiloClawEnv, 'KILOCLAW_DEFAULT_PROVIDER'>
): ProviderId {
  const parsed = ProviderIdSchema.safeParse(env.KILOCLAW_DEFAULT_PROVIDER);
  return parsed.success ? parsed.data : 'fly';
}

export function getProviderAdapter(
  env: KiloClawEnv,
  state: Pick<InstanceMutableState, 'provider'>
): InstanceProviderAdapter {
  assertAvailableProvider(env, state.provider);
  switch (state.provider) {
    case 'fly':
      return flyProviderAdapter;
    case 'docker-local':
      return dockerLocalProviderAdapter;
    case 'northflank':
      return northflankProviderAdapter;
  }
}
