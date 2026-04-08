import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import type { KiloClawEnv } from '../types';
import type { InstanceProviderAdapter } from './types';
import { flyProviderAdapter } from './fly';

export function getProviderAdapter(
  _env: KiloClawEnv,
  state: Pick<InstanceMutableState, 'provider'>
): InstanceProviderAdapter {
  switch (state.provider) {
    case 'fly':
      return flyProviderAdapter;
    case 'northflank':
    case 'aws':
    case 'k8s':
      throw new Error(`Provider ${state.provider} is not implemented yet`);
  }
}
