import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import { ProviderIdSchema, type ProviderId } from '../schemas/instance-config';
import type { KiloClawEnv } from '../types';
import type { InstanceProviderAdapter } from './types';
import { flyProviderAdapter } from './fly';
import { dockerLocalProviderAdapter } from './docker-local';

function notImplementedProviderError(
  provider: Exclude<ProviderId, 'fly' | 'docker-local'>
): Error & { status: number } {
  return Object.assign(new Error(`Provider ${provider} is not implemented yet`), {
    status: 501,
  });
}

export function assertImplementedProvider(provider: ProviderId): void {
  switch (provider) {
    case 'fly':
    case 'docker-local':
      return;
    case 'northflank':
      throw notImplementedProviderError(provider);
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
      throw notImplementedProviderError(state.provider);
  }
}
