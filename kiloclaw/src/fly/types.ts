/**
 * Type definitions for the Fly.io Machines REST API.
 * Based on https://docs.machines.dev/swagger/index.html
 */

// -- Machine types --

export type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'suspended'
  | 'replacing'
  | 'destroying'
  | 'destroyed';

/**
 * States accepted by the /wait endpoint (spec.json:1549).
 * Narrower than FlyMachineState — only states you can wait for.
 */
export type FlyWaitableState = 'started' | 'stopped' | 'suspended' | 'destroyed';

export type FlyMachineGuest = {
  cpus: number;
  memory_mb: number;
  cpu_kind?: 'shared' | 'performance';
};

export type FlyMachinePort = {
  port: number;
  handlers?: string[];
};

export type FlyMachineService = {
  ports: FlyMachinePort[];
  internal_port: number;
  protocol: 'tcp' | 'udp';
  autostart?: boolean;
  autostop?: 'off' | 'stop' | 'suspend';
};

export type FlyMachineMount = {
  volume: string;
  path: string;
  name?: string;
};

export type FlyMachineConfig = {
  image: string;
  env?: Record<string, string>;
  guest?: FlyMachineGuest;
  services?: FlyMachineService[];
  mounts?: FlyMachineMount[];
  metadata?: Record<string, string>;
  auto_destroy?: boolean;
};

export type FlyMachine = {
  id: string;
  name: string;
  state: FlyMachineState;
  region: string;
  instance_id: string;
  config: FlyMachineConfig;
  created_at: string;
  updated_at: string;
};

export type CreateMachineRequest = {
  name?: string;
  region?: string;
  config: FlyMachineConfig;
  skip_launch?: boolean;
};

// -- Volume types --

export type FlyVolume = {
  id: string;
  name: string;
  state: 'created' | 'attached' | 'detached' | 'destroying' | 'destroyed';
  size_gb: number;
  region: string;
  attached_machine_id: string | null;
  created_at: string;
};

export type CreateVolumeRequest = {
  name: string;
  region: string;
  size_gb: number;
  snapshot_retention?: number;
};
