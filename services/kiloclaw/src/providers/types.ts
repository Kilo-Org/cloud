import type { FlyMachineConfig } from '../fly/types';
import type { KiloClawEnv } from '../types';
import type { ProviderId } from '../schemas/instance-config';
import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';

export type ProviderContext = {
  env: KiloClawEnv;
  ctx: DurableObjectState;
  state: InstanceMutableState;
};

export type ProviderRoutingContext = Pick<ProviderContext, 'env' | 'state'>;

export type ProviderRoutingTarget = {
  origin: string;
  headers: Record<string, string>;
};

export type EnsureProvisioningResourcesArgs = ProviderContext & {
  orgId: string | null;
  machineSize: InstanceMutableState['machineSize'];
  region?: string;
};

export type EnsureStorageArgs = ProviderContext & {
  reason: string;
};

export type StartRuntimeArgs = ProviderContext & {
  machineConfig: FlyMachineConfig;
  minSecretsVersion?: number;
  envRegion?: string;
  onCapacityRecovery?: (error: unknown) => Promise<void> | void;
};

export type StopRuntimeArgs = ProviderContext;

export type RestartRuntimeArgs = ProviderContext & {
  machineConfig: FlyMachineConfig;
  minSecretsVersion?: number;
};

export type InstanceProviderAdapter = {
  readonly id: ProviderId;
  getRoutingTarget(args: ProviderRoutingContext): Promise<ProviderRoutingTarget>;
  ensureProvisioningResources(args: EnsureProvisioningResourcesArgs): Promise<void>;
  ensureStorage(args: EnsureStorageArgs): Promise<void>;
  startRuntime(args: StartRuntimeArgs): Promise<void>;
  stopRuntime(args: StopRuntimeArgs): Promise<void>;
  restartRuntime(args: RestartRuntimeArgs): Promise<{ aborted?: boolean; instanceId?: string }>;
};
