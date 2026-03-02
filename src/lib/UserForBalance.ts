import type { User } from '@kilocode/db/schema';

export type UserForBalance = Pick<
  User,
  | 'id'
  | 'total_microdollars_acquired'
  | 'microdollars_used'
  | 'next_credit_expiration_at'
  | 'updated_at'
  | 'auto_top_up_enabled'
>;
