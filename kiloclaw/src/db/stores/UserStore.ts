import { SqlStore } from '../SqlStore';
import type { Database, Transaction } from '../database';
import { kilocode_users, type UserForPepper } from '../tables/kilocode-users.table';

export class UserStore extends SqlStore {
  constructor(db: Database | Transaction) {
    super(db);
  }

  /**
   * Look up a user's api_token_pepper by userId for token validation.
   */
  async findPepperByUserId(userId: string): Promise<UserForPepper | null> {
    const rows = await this.query(
      /* sql */ `
      SELECT ${kilocode_users.id}, ${kilocode_users.api_token_pepper}
      FROM ${kilocode_users}
      WHERE ${kilocode_users.id} = $1
      LIMIT 1
      `,
      { 1: userId }
    );

    if (rows.length === 0) return null;
    return rows[0] as UserForPepper;
  }
}
