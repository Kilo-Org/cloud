import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_agents,
  agent_environment_profile_instructions,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profiles,
} from '@kilocode/db/schema';

export const TEST_PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function resolveRowsFor(table: unknown, rowCount: number): Array<{ n: number } | { id: string }> {
  if (table === agent_environment_profiles) return [{ id: TEST_PROFILE_ID }];
  if (
    table === agent_environment_profile_agents ||
    table === agent_environment_profile_kilo_commands ||
    table === agent_environment_profile_skills ||
    table === agent_environment_profile_mcp_servers ||
    table === agent_environment_profile_instructions
  ) {
    return [{ n: rowCount }];
  }
  throw new Error('profile limit test db: unexpected table');
}

/**
 * In-memory stand-in for the pool-backed `WorkerDb` used by the profile
 * create services.
 *
 * Transactions are serialized: a create that wraps the cap count and the
 * insert in `db.transaction` keeps them one ordered unit, matching the
 * PostgreSQL row lock the services take in production. These tests pin the
 * transaction, the row lock and the error contract.
 *
 * `state.lockCalls` counts the profile row locks and `state.rowCount` tracks
 * the stored rows.
 */
export function createLimitTestDb(initialRowCount: number) {
  let rowCount = initialRowCount;
  let nextId = 0;
  const state = {
    get rowCount() {
      return rowCount;
    },
    lockCalls: 0,
  };

  let tail: Promise<unknown> = Promise.resolve();

  const select = () => ({
    from: (table: unknown) => ({
      where: () =>
        (() => {
          const then = (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (error: unknown) => unknown
          ) => Promise.resolve(resolveRowsFor(table, rowCount)).then(onFulfilled, onRejected);
          const chain = {
            for: () => {
              state.lockCalls += 1;
              return chain;
            },
            limit: () => Promise.resolve(resolveRowsFor(table, rowCount)),
            then,
          };
          return chain;
        })(),
    }),
  });

  const insert = () => ({
    values: () => ({
      returning: () => {
        rowCount += 1;
        nextId += 1;
        return Promise.resolve([{ id: `row-${nextId}` }]);
      },
    }),
  });

  const channel = { select, insert };
  const db = {
    select,
    insert,
    transaction: <T>(work: (tx: typeof channel) => Promise<T>): Promise<T> => {
      const run = tail.then(() => work(channel));
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };

  return { db: db as unknown as WorkerDb, state };
}
