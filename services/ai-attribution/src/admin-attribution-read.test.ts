/**
 * Tests for the attribution read paths that the admin routes serve. The Durable
 * Object runs on workerd in production, so the class is built here without its
 * SQLite-backed constructor and given a scripted query chain. The route tests
 * drive the real Hono app with that same class, so the JSON the admin consumer
 * parses is produced by the code under test.
 */
jest.mock('cloudflare:workers', () => ({ DurableObject: class {} }), { virtual: true });
jest.mock('../drizzle/migrations', () => ({
  default: { journal: { entries: [] }, migrations: {} },
}));

let mockTracker: unknown;

jest.mock('./dos/AttributionTracker.do', () => {
  const actual = jest.requireActual('./dos/AttributionTracker.do');
  return {
    ...actual,
    getAttributionTrackerDO: () => mockTracker,
  };
});

import type { HonoContext } from './ai-attribution.worker';
import { AttributionTrackerDO } from './dos/AttributionTracker.do';
import type { AttributionsMetadataSelect } from './db/sqlite-schema';

const ADMIN_SECRET = 'test-admin-secret';
const TARGET = { organization_id: 'org-1', project_id: 'project-1', file_path: 'src/index.ts' };

type QueryResults = unknown[];

function scriptedQueryChain(results: QueryResults[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    all: () => results.shift() ?? [],
  };
  return { select: () => chain };
}

function trackerWith(results: QueryResults[]): AttributionTrackerDO {
  const tracker = Object.create(AttributionTrackerDO.prototype) as AttributionTrackerDO;
  // The Durable Object's private drizzle handle is the only seam here; the fake
  // serves the query rows each method consumes, and the methods run unchanged.
  const internals: { db: unknown } = tracker as unknown as { db: unknown };
  internals.db = scriptedQueryChain(results);
  return tracker;
}

function metadata(branch: string, id: number): AttributionsMetadataSelect {
  return {
    id,
    user_id: 'user-1',
    project_id: 'project-1',
    organization_id: 'org-1',
    branch,
    file_path: 'src/index.ts',
    status: 'accepted',
    task_id: null,
    created_at: `2026-10-30 10:00:0${id}`,
  };
}

const env = () =>
  ({
    ENVIRONMENT: 'development',
    ADMIN_SECRET: { get: async () => ADMIN_SECRET },
  }) as unknown as HonoContext['Bindings'];

describe('AttributionTrackerDO reads', () => {
  it('groups line numbers under any stored hash string', () => {
    const tracker = trackerWith([
      [
        { line_hash: 'constructor', line_number: 4 },
        { line_hash: 'constructor', line_number: 9 },
        { line_hash: '__proto__', line_number: 2 },
        { line_hash: '9f2c0b7d1e4a5c6b8d0f1a2b3c4d5e6f7a8b9c0d', line_number: 7 },
      ],
    ]);

    const linesAdded = tracker.getLinesAddedByHash(TARGET);

    expect(Object.keys(linesAdded)).toEqual([
      'constructor',
      '__proto__',
      '9f2c0b7d1e4a5c6b8d0f1a2b3c4d5e6f7a8b9c0d',
    ]);
    expect(linesAdded['constructor']).toEqual([4, 9]);
    expect(Object.hasOwn(linesAdded, '__proto__')).toBe(true);
    expect(linesAdded['__proto__']).toEqual([2]);
    expect(linesAdded['9f2c0b7d1e4a5c6b8d0f1a2b3c4d5e6f7a8b9c0d']).toEqual([7]);

    const roundTripped: Record<string, number[]> = JSON.parse(JSON.stringify(linesAdded));
    expect(Object.keys(roundTripped)).toEqual([
      'constructor',
      '__proto__',
      '9f2c0b7d1e4a5c6b8d0f1a2b3c4d5e6f7a8b9c0d',
    ]);
    expect(roundTripped['constructor']).toEqual([4, 9]);
    expect(roundTripped['__proto__']).toEqual([2]);
  });

  it('counts any stored branch string as data', () => {
    const rows = [metadata('constructor', 1), metadata('__proto__', 2), metadata('main', 3)];
    const lineRows = [{ line_hash: 'constructor', line_number: 1 }];
    const tracker = trackerWith([rows, lineRows, [], [], [], [], []]);

    const { summary } = tracker.getDebugData(TARGET);

    expect(summary.total_attributions).toBe(3);
    expect(Object.keys(summary.by_branch)).toEqual(['constructor', '__proto__', 'main']);
    expect(summary.by_branch['constructor']).toBe(1);
    expect(Object.hasOwn(summary.by_branch, '__proto__')).toBe(true);
    expect(summary.by_branch['__proto__']).toBe(1);
    expect(summary.by_branch['main']).toBe(1);
    expect(summary.by_status).toEqual({ accepted: 3 });

    const roundTripped: Record<string, number> = JSON.parse(JSON.stringify(summary.by_branch));
    expect(roundTripped['constructor']).toBe(1);
    expect(roundTripped['__proto__']).toBe(1);
  });
});

describe('admin attribution routes', () => {
  const request = async (path: string) => {
    const { default: app } = await import('./ai-attribution.worker');
    return app.request(path, { headers: { 'X-Admin-Secret': ADMIN_SECRET } }, env());
  };

  beforeEach(() => {
    mockTracker = undefined;
  });

  it('serves stored hash strings as they are stored', async () => {
    mockTracker = trackerWith([
      [
        { line_hash: 'constructor', line_number: 1 },
        { line_hash: '__proto__', line_number: 2 },
      ],
    ]);

    const response = await request(
      '/admin/attributions?organization_id=org-1&project_id=project-1&file_path=src%2Findex.ts'
    );

    expect(response.status).toBe(200);
    // The worker's own JSON contract, so the assertion reads the parsed body.
    const body = JSON.parse(await response.text()) as {
      data: { lines_added: Record<string, number[]> };
    };
    expect(body.data.lines_added['constructor']).toEqual([1]);
    expect(body.data.lines_added['__proto__']).toEqual([2]);
  });

  it('serves branch counts as numbers for any stored branch string', async () => {
    const rows = [metadata('constructor', 1), metadata('constructor', 2)];
    mockTracker = trackerWith([rows, [], [], [], []]);

    const response = await request(
      '/admin/debug-data?organization_id=org-1&project_id=project-1&file_path=src%2Findex.ts'
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text()) as {
      data: { summary: { by_branch: Record<string, number> } };
    };
    expect(body.data.summary.by_branch).toEqual({ constructor: 2 });
  });
});
