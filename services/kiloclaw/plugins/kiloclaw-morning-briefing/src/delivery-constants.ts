export const DELIVERY_CHANNELS = ['telegram', 'discord', 'slack'] as const;

export const DELIVERY_STATUSES = ['sent', 'skipped', 'failed'] as const;

export const DELIVERY_REASONS = [
  'missing_target',
  'ambiguous_target',
  'send_failed',
  'config_unavailable',
] as const;
