import type { Database, QueryParams, Transaction } from './database';

export class SqlStore {
  constructor(public db: Database | Transaction) {}

  async begin<T>(transaction: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.db.__kind === 'Database') {
      return this.db.begin(tx => transaction(tx));
    }

    return transaction(this.db);
  }

  async query<Query extends string>(query: Query, params: QueryParams<Query>): Promise<unknown[]> {
    try {
      return await this.db.query(query, params);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[SqlStore] query error:', message);
      throw e;
    }
  }
}
