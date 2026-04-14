import type { KiloClawEnv } from '../types';
import type {
  MachineSize,
  PersistedState,
  ProviderId,
  ProviderState,
} from '../schemas/instance-config';
import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';

export type ProviderContext = {
  env: KiloClawEnv;
  state: InstanceMutableState;
};

export type ProviderRoutingContext = Pick<ProviderContext, 'env' | 'state'>;

export type ProviderRoutingTarget = {
  origin: string;
  headers: Record<string, string>;
};

export type ProviderCapability =
  | 'volumeSnapshots'
  | 'candidateVolumes'
  | 'volumeReassociation'
  | 'snapshotRestore'
  | 'directMachineDestroy';

export type ProviderCapabilities = Record<ProviderCapability, boolean>;

export type RuntimeSpec = {
  imageRef: string;
  env: Record<string, string>;
  bootstrapEnv: Record<string, string>;
  machineSize: MachineSize | null;
  rootMountPath: '/root';
  controllerPort: number;
  controllerHealthCheckPath: '/_kilo/health';
  metadata: Record<string, string>;
};

export type ProviderObservation = {
  runtimeState?: 'starting' | 'running' | 'stopped' | 'failed' | 'missing';
  machineSize?: MachineSize | null;
};

export type ProviderResult<TProviderState extends ProviderState = ProviderState> = {
  providerState: TProviderState;
  corePatch?: Partial<Pick<PersistedState, 'machineSize' | 'restartUpdateSent'>>;
  observation?: ProviderObservation;
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
  runtimeSpec: RuntimeSpec;
  minSecretsVersion?: number;
  preferredRegion?: string;
  onCapacityRecovery?: (error: unknown) => Promise<void> | void;
  onProviderResult?: (result: ProviderResult) => Promise<void>;
};

export type StopRuntimeArgs = ProviderContext;

export type RestartRuntimeArgs = ProviderContext & {
  runtimeSpec: RuntimeSpec;
  minSecretsVersion?: number;
  onProviderResult?: (result: ProviderResult) => Promise<void>;
};

export type DestroyRuntimeArgs = ProviderContext;

export type DestroyStorageArgs = ProviderContext;

export type InstanceProviderAdapter = {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  getRoutingTarget(args: ProviderRoutingContext): Promise<ProviderRoutingTarget>;
  ensureProvisioningResources(args: EnsureProvisioningResourcesArgs): Promise<ProviderResult>;
  ensureStorage(args: EnsureStorageArgs): Promise<ProviderResult>;
  startRuntime(args: StartRuntimeArgs): Promise<ProviderResult>;
  stopRuntime(args: StopRuntimeArgs): Promise<ProviderResult>;
  restartRuntime(args: RestartRuntimeArgs): Promise<ProviderResult>;
  inspectRuntime(args: ProviderContext): Promise<ProviderResult>;
  destroyRuntime(args: DestroyRuntimeArgs): Promise<ProviderResult>;
  destroyStorage(args: DestroyStorageArgs): Promise<ProviderResult>;
};
