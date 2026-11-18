/**
 * Scoping tests for the attribution reads, the debug listing and the delete.
 *
 * The Durable Object stores its rows through the Durable Object SQLite driver,
 * which talks to `ctx.storage.sql`. The tests hand that storage a `node:sqlite`
 * database, so the class, the driver, the migration and every statement run
 * unchanged against a real engine; only the workerd binding is replaced. Two
 * different targets share one instance here, because the instance name joins the
 * labels, and each operation must still answer for its own target only.
 */
jest.mock(
  'cloudflare:workers',
  () => ({
    DurableObject: class {
      protected ctx: unknown;
      protected env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  }),
  { virtual: true }
);

/**
 * The generated `drizzle/migrations` module imports `.sql` and `.json` files,
 * which this jest setup does not transform, so the module is rebuilt here from
 * the same inputs: the real journal and every migration file it names.
 */
jest.mock('../../drizzle/migrations', () => {
  const fs = jest.requireActual('node:fs') as {
    readFileSync: (file: string, encoding: 'utf8') => string;
  };
  const path = jest.requireActual('node:path') as { join: (...parts: string[]) => string };
  const directory = path.join(__dirname, '../../drizzle');
  const journal = JSON.parse(
    fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
  ) as { entries: { idx: number; tag: string }[] };
  return {
    __esModule: true,
    default: {
      journal,
      migrations: Object.fromEntries(
        journal.entries.map(entry => [
          `m${String(entry.idx).padStart(4, '0')}`,
          fs.readFileSync(path.join(directory, `${entry.tag}.sql`), 'utf8'),
        ])
      ),
    },
  };
});

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  AttributionTrackerDO,
  attributionTrackerKey,
  type AttributionTarget,
} from './AttributionTracker.do';

type SqlRow = Record<string, unknown>;

function cursor(rows: SqlRow[], columns: string[]) {
  let position = 0;
  return {
    toArray: () => rows,
    raw: () => ({ toArray: () => rows.map(row => columns.map(column => row[column])) }),
    next: () => {
      const row = rows[position];
      position += 1;
      return row === undefined ? { value: undefined, done: true } : { value: row, done: false };
    },
  };
}

function sqlStorage(database: DatabaseSync) {
  return {
    sql: {
      exec: (query: string, ...params: SQLInputValue[]) => {
        const statement = database.prepare(query);
        const columns = statement.columns().map(column => column.name);
        if (columns.length === 0) {
          statement.run(...params);
          return cursor([], []);
        }
        return cursor(statement.all(...params) as SqlRow[], columns);
      },
    },
    transactionSync: <T>(run: () => T): T => {
      database.exec('BEGIN');
      try {
        const result = run();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function openTracker(): { tracker: AttributionTrackerDO; ready: Promise<unknown> } {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: sqlStorage(database),
    blockConcurrencyWhile: (run: () => Promise<unknown>) => {
      ready = run();
      return ready;
    },
  };
  const tracker = new AttributionTrackerDO(
    ctx as unknown as ConstructorParameters<typeof AttributionTrackerDO>[0],
    {} as ConstructorParameters<typeof AttributionTrackerDO>[1]
  );
  return { tracker, ready };
}

const ORG = 'org-1';
// Two different targets, both naming the same instance.
const TARGET_A: AttributionTarget = {
  organization_id: ORG,
  project_id: 'P/src',
  file_path: 'a.ts',
};
const TARGET_B: AttributionTarget = {
  organization_id: ORG,
  project_id: 'P',
  file_path: 'src/a.ts',
};

const HASH_A = 'a'.repeat(40);
const HASH_A_FEATURE = 'b'.repeat(40);
const HASH_B = 'c'.repeat(40);

function track(
  tracker: AttributionTrackerDO,
  target: AttributionTarget,
  taskId: string,
  branch: string,
  lineHash: string
): number {
  const tracked = tracker.trackAttribution({
    ...target,
    user_id: `user-${taskId}`,
    branch,
    status: 'accepted',
    task_id: taskId,
    lines_added: [{ line_number: 3, line_hash: lineHash }],
    lines_removed: [],
  });
  return tracked.id;
}

/** One tracker holding rows for both targets, as a shared instance holds them. */
async function sharedInstance() {
  const { tracker, ready } = openTracker();
  await ready;
  const idOfA = track(tracker, TARGET_A, 'task-a', 'main', HASH_A);
  const idOfAOnFeature = track(tracker, TARGET_A, 'task-a-feature', 'feature', HASH_A_FEATURE);
  const idOfB = track(tracker, TARGET_B, 'task-b', 'main', HASH_B);
  return { tracker, idOfA, idOfAOnFeature, idOfB };
}

describe('attribution target scoping', () => {
  it('puts two different targets on one instance', () => {
    expect(attributionTrackerKey(TARGET_A)).toBe(attributionTrackerKey(TARGET_B));
  });

  it('returns only the events stored for the requested target', async () => {
    const { tracker } = await sharedInstance();

    const eventsA = tracker.getAttributionEvents(TARGET_A);
    const eventsB = tracker.getAttributionEvents(TARGET_B);

    expect(eventsA.map(event => event.taskId)).toEqual(['task-a', 'task-a-feature']);
    expect(eventsA.map(event => event.lineHashes)).toEqual([[HASH_A], [HASH_A_FEATURE]]);
    expect(eventsB.map(event => event.taskId)).toEqual(['task-b']);
    expect(eventsB.map(event => event.lineHashes)).toEqual([[HASH_B]]);
  });

  it('returns only the accepted line hashes stored for the requested target', async () => {
    const { tracker } = await sharedInstance();

    expect(tracker.getLinesAddedByHash(TARGET_A)).toEqual({
      [HASH_A]: [3],
      [HASH_A_FEATURE]: [3],
    });
    expect(tracker.getLinesAddedByHash(TARGET_B)).toEqual({ [HASH_B]: [3] });
  });

  it('keeps the branch filter inside the requested target', async () => {
    const { tracker } = await sharedInstance();

    expect(tracker.getAttributionEvents(TARGET_A, 'main').map(event => event.taskId)).toEqual([
      'task-a',
    ]);
    expect(tracker.getAttributionEvents(TARGET_A, 'feature').map(event => event.taskId)).toEqual([
      'task-a-feature',
    ]);
  });

  it('lists and summarizes only the requested target, and keeps the instance totals apart', async () => {
    const { tracker } = await sharedInstance();

    const debugA = tracker.getDebugData(TARGET_A);
    const debugB = tracker.getDebugData(TARGET_B);

    expect(debugA.attributions.map(row => row.task_id)).toEqual(['task-a-feature', 'task-a']);
    expect(debugB.attributions.map(row => row.task_id)).toEqual(['task-b']);

    expect(debugA.summary).toEqual({
      total_attributions: 2,
      total_lines_added: 2,
      total_lines_removed: 0,
      by_status: { accepted: 2 },
      by_branch: { main: 1, feature: 1 },
    });
    expect(debugB.summary.total_attributions).toBe(1);
    expect(debugB.summary.by_branch).toEqual({ main: 1 });

    expect(debugA.instance_summary.total_attributions).toBe(3);
    expect(debugA.instance_summary.total_lines_added).toBe(3);
    expect(debugA.instance_summary.by_status).toEqual({ accepted: 3 });
    expect(debugB.instance_summary).toEqual(debugA.instance_summary);
  });

  it('refuses to delete a row through another target and leaves it in place', async () => {
    const { tracker, idOfA, idOfB } = await sharedInstance();

    expect(tracker.deleteAttribution(TARGET_B, idOfA)).toBe(false);
    expect(tracker.deleteAttribution(TARGET_A, idOfB)).toBe(false);

    expect(tracker.getAttributionEvents(TARGET_A).map(event => event.taskId)).toEqual([
      'task-a',
      'task-a-feature',
    ]);
    expect(tracker.getAttributionEvents(TARGET_B).map(event => event.taskId)).toEqual(['task-b']);
  });

  it('removes the row and its line records through its own target', async () => {
    const { tracker, idOfA } = await sharedInstance();

    expect(tracker.deleteAttribution(TARGET_A, idOfA)).toBe(true);

    expect(tracker.getAttributionEvents(TARGET_A).map(event => event.taskId)).toEqual([
      'task-a-feature',
    ]);
    expect(tracker.getLinesAddedByHash(TARGET_A)).toEqual({ [HASH_A_FEATURE]: [3] });
    expect(tracker.getAttributionEvents(TARGET_B).map(event => event.taskId)).toEqual(['task-b']);
  });

  it('does not return rows stored without an organization label', async () => {
    const { tracker, ready } = openTracker();
    await ready;
    tracker.insertAttributionMetadata({
      user_id: 'user-legacy',
      project_id: TARGET_B.project_id,
      organization_id: null,
      branch: 'main',
      file_path: TARGET_B.file_path,
      status: 'accepted',
      task_id: 'task-unlabelled',
    });

    expect(tracker.getAttributionEvents(TARGET_B)).toEqual([]);
    expect(tracker.deleteAttribution(TARGET_B, 1)).toBe(false);
  });
});
