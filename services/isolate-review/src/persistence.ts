import { eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate as migrateDatabase } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../drizzle/migrations';
import { reviewApplicationState } from './db/sqlite-schema';

export type ReviewPersistence = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteExcept(key: string): Promise<void>;
};

export function createReviewPersistence(storage: DurableObjectStorage): {
  persistence: ReviewPersistence;
  migrate: () => Promise<void>;
} {
  const database = drizzle(storage, { logger: false });

  return {
    persistence: {
      async deleteExcept(key: string): Promise<void> {
        database.delete(reviewApplicationState).where(ne(reviewApplicationState.key, key)).run();
      },
      async get<T>(key: string): Promise<T | undefined> {
        const row = database
          .select({ payload: reviewApplicationState.payload })
          .from(reviewApplicationState)
          .where(eq(reviewApplicationState.key, key))
          .get();

        return row ? (JSON.parse(row.payload) as T) : undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        const payload = JSON.stringify(value);

        database
          .insert(reviewApplicationState)
          .values({ key, payload })
          .onConflictDoUpdate({
            target: reviewApplicationState.key,
            set: { payload },
          })
          .run();
      },
    },
    migrate: () => migrateDatabase(database, migrations),
  };
}
