import { getTable } from '../../util/table';

/**
 * Table definition for kiloclaw_access_codes.
 * Used by the worker to validate and redeem access codes.
 */
export const kiloclaw_access_codes = getTable({
  name: 'kiloclaw_access_codes',
  columns: ['id', 'code', 'kilo_user_id', 'status', 'expires_at', 'redeemed_at'] as const,
});
