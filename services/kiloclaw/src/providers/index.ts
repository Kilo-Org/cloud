import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import type { ProviderId } from '../schemas/instance-config';
import type { KiloClawEnv } from '../types';
import type { InstanceProviderAdapter } from './types';
import { flyProviderAdapter } from './fly';

function notImplementedProviderError(
  provider: Exclude<ProviderId, 'fly'>
): Error & { status: number } {
  return Object.assign(new Error(`Provider ${provider} is not implemented yet`), {
    status: 501,
  });
}

export function assertImplementedProvider(provider: ProviderId): void {
  switch (provider) {
    case 'fly':
      return;
    case 'northflank':
    case 'aws':
    case 'k8s':
      throw notImplementedProviderError(provider);
  }
}

export function getProviderAdapter(
  _env: KiloClawEnv,
  state: Pick<InstanceMutableState, 'provider'>
): InstanceProviderAdapter {
  assertImplementedProvider(state.provider);
  return flyProviderAdapter;
}
