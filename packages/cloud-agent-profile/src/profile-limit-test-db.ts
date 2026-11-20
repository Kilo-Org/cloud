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

/** One stored setup command: its text and the sequence the service assigned. */
export type StoredCommandRow = { command: string; sequence: number };

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
 * One inserted command row: its text and the sequence the service assigned.
 * The fake only ever receives the row the service builds, so an absent string
 * or sequence is a bug worth throwing on.
 */
function commandRowOf(row: unknown): StoredCommandRow {
  if (
    typeof row === 'object' &&
    row !== null &&
    'command' in row &&
    typeof row.command === 'string' &&
    'sequence' in row &&
    typeof row.sequence === 'number'
  ) {
    return { command: row.command, sequence: row.sequence };
  }
  throw new Error('profile limit test db: command row without command text and sequence');
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
 * owner column matches another owner's row. The chain after `where` is
 * production-shaped: a plain `await` finishes the statement, and `.returning()`
 * resolves to the matched row ids, so a service that asserts its affected row
 * count is testable. A profile read that names one id also answers from the
 * seeded rows, so an ownership lookup can miss.
 *
 * `state.lockCalls` counts the profile row locks, `state.advisoryLocks` the
 * `execute`d statements, `state.rowCount` tracks the stored rows,
 * `state.upserts` counts variable writes, `initialVarKeys` are the variable
 * keys the profile already holds, `state.profileRows` is the current profile
 * rows, `state.defaultWrites` the `update`s this fake executed,
 * `state.profileInserts` the profile rows it inserted, and `initialCommands` /
 * `state.commands` the setup commands the profile holds in list order, with
 * `state.commandRows` the same rows carrying the sequence each one was written
 * under, `state.commandInserts` the command `insert`s it executed, and
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
  let storedCommandRows: StoredCommandRow[] = initialCommands.map((command, sequence) => ({
    command,
    sequence,
  }));
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
      return storedCommandRows.map(row => row.command);
    },
    /** The stored command rows with the sequence each one was written under. */
    get commandRows(): readonly StoredCommandRow[] {
      return storedCommandRows.map(row => ({ ...row }));
    },
    defaultWrites,
    lockCalls: 0,
    /** `execute`d statements, counted because the creation lock is one. */
    advisoryLocks: 0,
    commandDeletes: 0,
    /** Command `insert`s this fake executed; a whole-list replace may run none. */
    commandInserts: 0,
  };

  let tail: Promise<unknown> = Promise.resolve();

  const select = () => ({
    from: (table: unknown) => ({
      where: (condition?: unknown) => {
        const resolve = () => {
          if (table === agent_environment_profile_vars) {
            return [...varKeys].map(key => ({ key, delivery: 'env' }));
          }
          // A profile read that names one id answers from the seeded rows, so
          // an ownership lookup can miss. Every other read, such as the owner
          // cap count, keeps the single profile the limit tests expect.
          const equalities =
            table === agent_environment_profiles && profileRows.length > 0
              ? equalitiesOf(condition)
              : [];
          if (equalities.some(equality => equality.column === 'id')) {
            return profileRows
              .filter(row =>
                equalities.every(equality => readRowField(row, equality.column) === equality.value)
              )
              .map(row => ({
                id: row.id,
                is_default: row.isDefault,
                owned_by_user_id: row.ownerType === 'user' ? row.ownerId : null,
                owned_by_organization_id: row.ownerType === 'organization' ? row.ownerId : null,
              }));
          }
          return resolveRowsFor(table, rowCount);
        };
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
          state.commandInserts += 1;
          storedCommandRows = rows.map(commandRowOf);
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
        storedCommandRows = [];
        return Promise.resolve();
      }
      throw new Error('profile limit test db: unexpected delete');
    },
  });

  // The owner creation lock is an advisory `execute`; the fake serializes
  // transactions itself, so the statement only needs to succeed and be counted,
  // which is what lets a test assert the create path took the owner lock.
  const execute = (): Promise<void> => {
    state.advisoryLocks += 1;
    return Promise.resolve();
  };

  const update = () => ({
    set: (values: { is_default?: boolean }) => ({
      where: (condition: unknown) => {
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

        // Production shape of the chain: a plain `await` sees the statement
        // finish, and `.returning()` sees the rows the condition matched.
        const ids = matched.map(row => row.id);
        return {
          returning: () => Promise.resolve(ids.map(id => ({ id }))),
          then: (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (error: unknown) => unknown
          ) => Promise.resolve().then(onFulfilled, onRejected),
        };
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
