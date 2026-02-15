import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

export type ClawState = KiloClawDashboardStatus['status'];

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
