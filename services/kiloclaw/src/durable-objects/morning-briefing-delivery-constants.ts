export const MORNING_BRIEFING_DELIVERY_CHANNELS = ['telegram', 'discord', 'slack'] as const;

export const MORNING_BRIEFING_DELIVERY_STATUSES = ['sent', 'skipped', 'failed'] as const;

export const MORNING_BRIEFING_DELIVERY_REASONS = [
  'missing_target',
  'ambiguous_target',
  'send_failed',
  'config_unavailable',
] as const;
