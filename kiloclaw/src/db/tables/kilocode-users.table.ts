import { getTable } from '../../util/table';

/**
 * Table definition for kilocode_users.
 * Only includes columns needed for pepper validation.
 */
export const kilocode_users = getTable({
  name: 'kilocode_users',
  columns: ['id', 'api_token_pepper'] as const,
});

export type UserForPepper = {
  id: string;
  api_token_pepper: string | null;
};
