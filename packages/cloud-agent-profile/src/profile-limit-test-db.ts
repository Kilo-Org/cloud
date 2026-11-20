import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_agents,
  agent_environment_profile_commands,
  agent_environment_profile_instructions,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profile_vars,
  agent_environment_profiles,
} from '@kilocode/db/schema';

export const TEST_PROFILE_ID = '11111111-1111-4111-8111-111111111111';

/** One stored profile row, as far as the fake `update` can observe it. */
export type LimitTestProfileRow = {
  id: string;
  ownerType: 'user' | 'organization';
  ownerId: string;
  isDefault: boolean;
};

/** One `update` the fake executed, with its condition and the rows it matched. */
export type LimitTestDefaultWrite = {
  isDefault: boolean;
  conditionColumns: readonly string[];
  matchedProfileIds: readonly string[];
};

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
 * Reads one column of a seeded row. A condition naming a column this fake does
 * not model throws instead of matching nothing: a silently empty match would
 * make an owner-scoped assertion pass for the wrong reason.
 */
function readRowField(row: LimitTestProfileRow, column: string): unknown {
  switch (column) {
    case 'id':
      return row.id;
    case 'is_default':
      return row.isDefault;
    case 'owned_by_user_id':
      return row.ownerType === 'user' ? row.ownerId : null;
    case 'owned_by_organization_id':
      return row.ownerType === 'organization' ? row.ownerId : null;
    default:
      throw new Error(`profile limit test db: unexpected column ${column}`);
  }
}

/**
 * Collects the column-equality pairs of a drizzle `where` condition.
 *
 * The fake cannot execute SQL, so it reads the condition as a conjunction of
 * equalities: every `eq(column, value)` in the tree becomes one pair, and a
 * row matches only when it satisfies all of them. Nesting (`and(and(...))`)
 * and argument order do not matter. A condition this cannot read as
 * equalities yields no pairs, and the caller treats that as "every row
 * matches", which fails the ownership assertions loudly instead of quietly.
 */
function equalitiesOf(condition: unknown): ReadonlyArray<{ column: string; value: unknown }> {
  const equalities: Array<{ column: string; value: unknown }> = [];

  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || !('queryChunks' in node)) return;
    const chunks: unknown = node.queryChunks;
    if (!Array.isArray(chunks)) return;

    let column: string | null = null;
    let value: unknown;
    let hasValue = false;

    for (const chunk of chunks as readonly unknown[]) {
      if (
        typeof chunk === 'object' &&
        chunk !== null &&
        'name' in chunk &&
        typeof chunk.name === 'string' &&
        'table' in chunk
      ) {
        column = chunk.name;
      } else if (
        typeof chunk === 'object' &&
        chunk !== null &&
        'value' in chunk &&
        'encoder' in chunk
      ) {
        value = chunk.value;
        hasValue = true;
      }
      visit(chunk);
    }

    if (column !== null && hasValue) equalities.push({ column, value });
  };

  visit(condition);
  return equalities;
}

/**
 * The command text of one inserted command row. The fake only ever receives
 * the row the service builds, so an absent string is a bug worth throwing on.
 */
function commandOf(row: unknown): string {
  if (
    typeof row === 'object' &&
    row !== null &&
    'command' in row &&
    typeof row.command === 'string'
  ) {
    return row.command;
  }
  throw new Error('profile limit test db: command row without command text');
}

/** The key of one inserted variable row, when it carries one. */
function keyOf(row: unknown): string | undefined {
  if (typeof row === 'object' && row !== null && 'key' in row && typeof row.key === 'string') {
    return row.key;
  }
  return undefined;
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
 * `update` models the profile default flag: `initialProfiles` seeds the stored
 * rows, and every `update` matches rows by the equalities of its condition. That
 * is what makes an owner-scoped `where` observable: a condition without the
 * owner column matches another owner's row.
 *
 * `state.lockCalls` counts the profile row locks, `state.advisoryLocks` the
 * `execute`d advisory locks, `state.rowCount` tracks the stored rows,
 * `state.upserts` counts variable writes, `initialVarKeys` are the variable
 * keys the profile already holds, `state.profileRows` is the current profile
 * rows, `state.defaultWrites` the `update`s this fake executed,
 * `state.profileInserts` the profile rows it inserted, and `initialCommands` /
 * `state.commands` the setup commands the profile holds, with
 * `state.commandDeletes` counting the whole-list deletes.
 */
export function createLimitTestDb(
  initialRowCount: number,
  initialVarKeys: readonly string[] = [],
  initialProfiles: readonly LimitTestProfileRow[] = [],
  initialCommands: readonly string[] = []
) {
  let rowCount = initialRowCount;
  let nextId = 0;
  let upserts = 0;
  let profileInserts = 0;
  let storedCommands: string[] = [...initialCommands];
  const varKeys = new Set(initialVarKeys);
  const profileRows: LimitTestProfileRow[] = initialProfiles.map(row => ({ ...row }));
  const defaultWrites: LimitTestDefaultWrite[] = [];
  const state = {
    get rowCount() {
      return rowCount;
    },
    get upserts() {
      return upserts;
    },
    get profileRows(): readonly LimitTestProfileRow[] {
      return profileRows.map(row => ({ ...row }));
    },
    /** Profile rows this fake inserted. */
    get profileInserts() {
      return profileInserts;
    },
    /** The stored setup commands of the profile, in list order. */
    get commands(): readonly string[] {
      return [...storedCommands];
    },
    defaultWrites,
    lockCalls: 0,
    commandDeletes: 0,
  };

  let tail: Promise<unknown> = Promise.resolve();

  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        const resolve = () =>
          table === agent_environment_profile_vars
            ? [...varKeys].map(key => ({ key, delivery: 'env' }))
            : resolveRowsFor(table, rowCount);
        const then = (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (error: unknown) => unknown
        ) => Promise.resolve(resolve()).then(onFulfilled, onRejected);
        const chain = {
          for: () => {
            state.lockCalls += 1;
            return chain;
          },
          limit: () => Promise.resolve(resolve()),
          then,
        };
        return chain;
      },
    }),
  });

  const insert = (table: unknown) => ({
    values: (row: unknown = {}) => {
      const commit = (): Promise<unknown> => {
        if (table === agent_environment_profile_commands) {
          const rows = Array.isArray(row) ? row : [row];
          storedCommands = rows.map(commandOf);
          return Promise.resolve();
        }
        if (table === agent_environment_profile_vars) {
          upserts += 1;
          const key = keyOf(row);
          if (key !== undefined && !varKeys.has(key)) {
            varKeys.add(key);
            rowCount += 1;
          }
          return Promise.resolve();
        }
        if (table === agent_environment_profiles) {
          profileInserts += 1;
          nextId += 1;
          rowCount += 1;
          return Promise.resolve([{ id: `row-${nextId}` }]);
        }
        // Any other profile collection row (an agent, a command, a skill):
        // one stored row under the profile cap.
        nextId += 1;
        rowCount += 1;
        return Promise.resolve([{ id: `row-${nextId}` }]);
      };
      return {
        returning: commit,
        onConflictDoUpdate: commit,
        then: (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (error: unknown) => unknown
        ) => commit().then(onFulfilled, onRejected),
      };
    },
  });

  const remove = (table: unknown) => ({
    where: (): Promise<void> => {
      if (table === agent_environment_profile_commands) {
        state.commandDeletes += 1;
        storedCommands = [];
        return Promise.resolve();
      }
      throw new Error('profile limit test db: unexpected delete');
    },
  });

  // The owner creation lock is an advisory `execute`; the fake serializes
  // transactions itself, so the statement only needs to succeed.
  const execute = (): Promise<void> => Promise.resolve();

  const update = () => ({
    set: (values: { is_default?: boolean }) => ({
      where: (condition: unknown): Promise<void> => {
        const equalities = equalitiesOf(condition);
        const matched = profileRows.filter(row =>
          equalities.every(equality => readRowField(row, equality.column) === equality.value)
        );

        if (values.is_default !== undefined) {
          for (const row of matched) row.isDefault = values.is_default;
          defaultWrites.push({
            isDefault: values.is_default,
            conditionColumns: equalities.map(equality => equality.column),
            matchedProfileIds: matched.map(row => row.id),
          });
        }

        return Promise.resolve();
      },
    }),
  });

  const channel = { select, insert, update, delete: remove, execute };
  const db = {
    select,
    insert,
    update,
    delete: remove,
    execute,
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
