import type { Database, QueryParams, Transaction } from './database.js';
import { logger } from '../util/logger.js';

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
      const errorDetails =
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : { message: String(e) };
      logger.error('error executing query', {
        error: errorDetails,
        query,
        paramsCount: Object.keys(params ?? {}).length,
      });
      throw e;
    }
  }
}
