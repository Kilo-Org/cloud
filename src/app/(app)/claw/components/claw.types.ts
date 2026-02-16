import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

export type ClawState = KiloClawDashboardStatus['status'];
export type ClawInstanceTypeName = 'shared-cpu-2x2' | 'shared-cpu-2x4' | 'performance-cpu-2x4';
export type ClawInstanceType = {
  name: ClawInstanceTypeName;
  description: string;
  isDefault: boolean;
};

export const CLAW_INSTANCE_TYPES = [
  {
    name: 'shared-cpu-2x2',
    description: '2 vCPU, 2 GB RAM',
    isDefault: false,
  },
  {
    name: 'shared-cpu-2x4',
    description: '2 vCPU, 4 GB RAM',
    isDefault: true,
  },
  {
    name: 'performance-cpu-2x4',
    description: '2 vCPU, 4 GB RAM (Performance CPU)',
    isDefault: false,
  },
] satisfies readonly [ClawInstanceType, ...ClawInstanceType[]];

export const DEFAULT_CLAW_INSTANCE_TYPE =
  CLAW_INSTANCE_TYPES.find(instanceType => instanceType.isDefault) ?? CLAW_INSTANCE_TYPES[0];

export const CLAW_STATUS_BADGE: Record<
  Exclude<ClawState, null>,
  { label: string; className: string }
> = {
  running: {
    label: 'Running',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  },
  stopped: {
    label: 'Stopped',
    className: 'border-red-500/30 bg-red-500/15 text-red-400',
  },
  provisioned: {
    label: 'Provisioned',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  },
  destroying: {
    label: 'Destroying',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-400 animate-pulse',
  },
};
