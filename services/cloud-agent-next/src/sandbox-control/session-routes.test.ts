import { describe, expect, it } from 'vitest';
import {
  applyReportedSessionState,
  attachRoute,
  detachRoute,
  emptyRouteTable,
  getRouteByDirectory,
  getRouteByKiloSessionId,
  getRouteBySessionId,
  hasActiveWork,
  resolveSessionEventRoute,
  type AttachRouteInput,
} from './session-routes.js';

const OWNER = 'owner_1';
const WORKTREE_A = 'worktree_11111111-1111-4111-8111-111111111111';
const WORKTREE_B = 'worktree_22222222-2222-4222-8222-222222222222';

const attachInput = {
  sessionId: 'ses_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace/a',
  ownerId: OWNER,
};

const worktreeInput = { ...attachInput, worktreeId: 'worktree_1' };

function attachedTable(input: AttachRouteInput = attachInput) {
  return attachRoute(emptyRouteTable(), input, OWNER);
}

function sharedDirectoryTable() {
  const { table, route: first } = attachedTable(worktreeInput);
  const { route: second } = attachRoute(
    table,
    { ...worktreeInput, sessionId: 'ses_2', kiloSessionId: 'kilo_2' },
    OWNER
  );
  return { table, first, second };
}

function groupedTable() {
  const first = attachRoute(emptyRouteTable(), { ...attachInput, worktreeId: WORKTREE_A }, OWNER);
  const second = attachRoute(
    first.table,
    {
      ...attachInput,
      sessionId: 'ses_2',
      kiloSessionId: 'kilo_2',
      worktreeId: WORKTREE_A,
    },
    OWNER
  );
  return { table: first.table, first: first.route, second: second.route };
}

describe('session routes', () => {
  it('attaches a route and looks it up by session, directory, and kiloSessionId', () => {
    const { table, route, changed } = attachedTable();
    expect(changed).toBe(true);
    expect(route).toMatchObject({
      ...attachInput,
      lastState: null,
      lastStateAt: null,
      idleForMs: null,
      waitingOn: null,
    });
    expect(getRouteBySessionId(table, 'ses_1')).toBe(route);
    expect(getRouteByDirectory(table, '/workspace/a')).toBe(route);
    expect(getRouteByKiloSessionId(table, 'kilo_1')).toBe(route);
  });

  it.each([
    { name: 'legacy', input: attachInput },
    { name: 'worktree-scoped', input: worktreeInput },
  ])('reattaches the same $name tuple idempotently without resetting state', ({ input }) => {
    const { table, route } = attachedTable(input);
    applyReportedSessionState(
      table,
      input.kiloSessionId,
      { state: 'active', idleForMs: 10, waitingOn: 'model' },
      1000
    );
    const before = structuredClone(route);

    const again = attachRoute(table, input, OWNER);
    expect(again.changed).toBe(false);
    expect(again.route).toBe(route);
    expect(again.route).toEqual(before);
    expect(table.size).toBe(1);
  });

  it('attaches multiple independent roots only to their shared explicit worktree', () => {
    const { table, first, second } = sharedDirectoryTable();
    const third = attachRoute(
      table,
      { ...worktreeInput, sessionId: 'ses_3', kiloSessionId: 'kilo_3' },
      OWNER
    );

    expect(third.changed).toBe(true);
    expect(table.size).toBe(3);
    expect([...table.values()].map(route => route.worktreeId)).toEqual([
      'worktree_1',
      'worktree_1',
      'worktree_1',
    ]);
    expect(getRouteBySessionId(table, 'ses_1')).toBe(first);
    expect(getRouteByKiloSessionId(table, 'kilo_2')).toBe(second);
    expect(getRouteByKiloSessionId(table, 'kilo_3')).toBe(third.route);
    expect(getRouteByDirectory(table, worktreeInput.directory)).toBeUndefined();
    expect(attachRoute(table, worktreeInput, OWNER)).toEqual({
      table,
      route: first,
      changed: false,
    });
  });

  it('rejects an owner mismatch', () => {
    expect(() => attachRoute(emptyRouteTable(), attachInput, 'other_owner')).toThrow(
      'Sandbox owner mismatch'
    );
  });

  it('rejects a directory already attached to another session', () => {
    const { table } = attachedTable();
    expect(() =>
      attachRoute(
        table,
        {
          sessionId: 'ses_2',
          kiloSessionId: 'kilo_2',
          directory: '/workspace/a',
          ownerId: OWNER,
        },
        OWNER
      )
    ).toThrow('Directory already attached');
  });

  it.each([
    [undefined, 'worktree_1'],
    ['worktree_1', undefined],
    ['worktree_1', 'worktree_2'],
    ['', ''],
    ['', 'worktree_1'],
    ['worktree_1', ''],
  ])('rejects directory sharing between worktree ids %j and %j', (existingId, worktreeId) => {
    const { table, route } = attachedTable({ ...attachInput, worktreeId: existingId });
    expect(() =>
      attachRoute(
        table,
        { ...attachInput, sessionId: 'ses_2', kiloSessionId: 'kilo_2', worktreeId },
        OWNER
      )
    ).toThrow('Directory already attached');
    expect([...table.values()]).toEqual([route]);
  });

  it('rejects assigning the same worktree to a different directory', () => {
    const { table, route } = attachedTable(worktreeInput);
    expect(() =>
      attachRoute(
        table,
        {
          ...worktreeInput,
          sessionId: 'ses_2',
          kiloSessionId: 'kilo_2',
          directory: '/workspace/b',
        },
        OWNER
      )
    ).toThrow('Worktree already attached to another directory');
    expect([...table.values()]).toEqual([route]);
  });

  it('rejects sharing a worktree route across owners', () => {
    const { table, route } = attachedTable(worktreeInput);
    expect(() =>
      attachRoute(
        table,
        {
          ...worktreeInput,
          sessionId: 'ses_2',
          kiloSessionId: 'kilo_2',
          ownerId: 'other_owner',
        },
        'other_owner'
      )
    ).toThrow('Directory already attached');
    expect([...table.values()]).toEqual([route]);
  });

  it('rejects a duplicate root within the same worktree', () => {
    const { table, route } = attachedTable(worktreeInput);
    expect(() => attachRoute(table, { ...worktreeInput, sessionId: 'ses_2' }, OWNER)).toThrow(
      'Kilo session already attached'
    );
    expect([...table.values()]).toEqual([route]);
  });

  it('allows different worktrees in different directories', () => {
    const { table } = attachRoute(
      emptyRouteTable(),
      { ...attachInput, worktreeId: WORKTREE_A },
      OWNER
    );

    const next = attachRoute(
      table,
      {
        ...attachInput,
        sessionId: 'ses_2',
        kiloSessionId: 'kilo_2',
        directory: '/workspace/b',
        worktreeId: WORKTREE_B,
      },
      OWNER
    );

    expect(next.changed).toBe(true);
    expect(table.size).toBe(2);
  });

  it('rejects a kiloSessionId already attached to another session', () => {
    const { table } = attachedTable();
    expect(() =>
      attachRoute(
        table,
        {
          sessionId: 'ses_2',
          kiloSessionId: 'kilo_1',
          directory: '/workspace/b',
          ownerId: OWNER,
        },
        OWNER
      )
    ).toThrow('Kilo session already attached');
  });

  it('rejects a duplicate root even when its worktree and directory match', () => {
    const { table } = attachRoute(
      emptyRouteTable(),
      { ...attachInput, worktreeId: WORKTREE_A },
      OWNER
    );

    expect(() =>
      attachRoute(table, { ...attachInput, sessionId: 'ses_2', worktreeId: WORKTREE_A }, OWNER)
    ).toThrow('Kilo session already attached');
  });

  it('rejects the same sessionId with a different directory', () => {
    const { table } = attachedTable();
    expect(() =>
      attachRoute(
        table,
        {
          ...attachInput,
          directory: '/workspace/b',
        },
        OWNER
      )
    ).toThrow('Session route conflict');
  });

  it.each([
    [undefined, 'worktree_1'],
    ['worktree_1', undefined],
    ['worktree_1', 'worktree_2'],
  ])('rejects reattaching a session from worktree %j to %j', (existingId, worktreeId) => {
    const { table, route } = attachedTable({ ...attachInput, worktreeId: existingId });
    expect(() => attachRoute(table, { ...attachInput, worktreeId }, OWNER)).toThrow(
      'Session route conflict'
    );
    expect([...table.values()]).toEqual([route]);
    expect(route.worktreeId).toBe(existingId);
  });

  it('rejects replacing the root of an attached session', () => {
    const { table } = attachedTable(worktreeInput);
    expect(() => attachRoute(table, { ...worktreeInput, kiloSessionId: 'kilo_2' }, OWNER)).toThrow(
      'Session route conflict'
    );
    expect(getRouteByKiloSessionId(table, 'kilo_2')).toBeUndefined();
  });

  it('rejects reattaching a route owned by a different sandbox owner', () => {
    const { table, route } = attachedTable();
    expect(() =>
      attachRoute(table, { ...attachInput, ownerId: 'other_owner' }, 'other_owner')
    ).toThrow('Session route conflict');
    expect(route.ownerId).toBe(OWNER);
  });

  it('detaches a shared-directory root without removing the remaining route', () => {
    const { table, second } = sharedDirectoryTable();
    expect(detachRoute(table, 'ses_1')).toEqual({ table, existed: true });
    expect(getRouteByKiloSessionId(table, 'kilo_1')).toBeUndefined();
    expect(getRouteByDirectory(table, worktreeInput.directory)).toBe(second);
    expect(resolveSessionEventRoute(table, { directory: worktreeInput.directory })).toBe(second);
  });

  it('detaches a route', () => {
    const { table } = attachedTable();
    expect(detachRoute(table, 'ses_1')).toEqual({ table, existed: true });
    expect(getRouteBySessionId(table, 'ses_1')).toBeUndefined();
    expect(getRouteByDirectory(table, '/workspace/a')).toBeUndefined();
    expect(detachRoute(table, 'ses_1')).toEqual({ table, existed: false });
  });

  it('tracks activity independently for roots sharing a worktree directory', () => {
    const { table, first, second } = sharedDirectoryTable();
    applyReportedSessionState(table, 'kilo_1', { state: 'active', idleForMs: 0 }, 1000);
    applyReportedSessionState(table, 'kilo_2', { state: 'idle', idleForMs: 20 }, 2000);

    expect(first).toMatchObject({ lastState: 'active', lastStateAt: 1000 });
    expect(second).toMatchObject({ lastState: 'idle', lastStateAt: 2000 });
    expect(hasActiveWork(table)).toBe(true);
    applyReportedSessionState(table, 'kilo_1', { state: 'idle', idleForMs: 0 }, 3000);
    expect(second.lastStateAt).toBe(2000);
    expect(hasActiveWork(table)).toBe(false);
  });

  it('detaches and reattaches one root without disturbing its sibling', () => {
    const { table, first, second } = groupedTable();

    expect(detachRoute(table, second.sessionId)).toEqual({ table, existed: true });
    expect(getRouteByDirectory(table, first.directory)).toBe(first);
    expect(getRouteByKiloSessionId(table, second.kiloSessionId)).toBeUndefined();

    const reattached = attachRoute(
      table,
      {
        sessionId: second.sessionId,
        kiloSessionId: second.kiloSessionId,
        directory: second.directory,
        ownerId: OWNER,
        worktreeId: WORKTREE_A,
      },
      OWNER
    );

    expect(reattached.changed).toBe(true);
    expect(getRouteBySessionId(table, first.sessionId)).toBe(first);
    expect(getRouteByDirectory(table, first.directory)).toBeUndefined();
  });

  it('applies a repeated session state without marking changed', () => {
    const { table } = attachedTable();
    const first = applyReportedSessionState(
      table,
      'kilo_1',
      { state: 'active', idleForMs: 10, waitingOn: 'model' },
      1000
    );
    expect(first.changed).toBe(true);
    const second = applyReportedSessionState(
      table,
      'kilo_1',
      { state: 'active', idleForMs: 40, waitingOn: 'model' },
      2000
    );
    expect(second.changed).toBe(false);
    expect(getRouteByKiloSessionId(table, 'kilo_1')).toMatchObject({
      lastState: 'active',
      lastStateAt: 2000,
      idleForMs: 40,
      waitingOn: 'model',
    });
  });

  it('applies a changed session state', () => {
    const { table } = attachedTable();
    applyReportedSessionState(table, 'kilo_1', { state: 'active', idleForMs: 0 }, 1000);
    const next = applyReportedSessionState(
      table,
      'kilo_1',
      { state: 'idle', idleForMs: 500 },
      1500
    );
    expect(next.changed).toBe(true);
    expect(getRouteByKiloSessionId(table, 'kilo_1')).toMatchObject({
      lastState: 'idle',
      lastStateAt: 1500,
      idleForMs: 500,
      waitingOn: null,
    });
  });

  it('counts preparation and deliberate input waits as active work', () => {
    const { table } = attachedTable();
    expect(hasActiveWork(table)).toBe(false);
    applyReportedSessionState(
      table,
      'kilo_1',
      { state: 'active', idleForMs: 360_000, waitingOn: 'preparation' },
      1000
    );
    expect(hasActiveWork(table)).toBe(true);
    applyReportedSessionState(
      table,
      'kilo_1',
      { state: 'active', idleForMs: 360_000, waitingOn: 'input' },
      2000
    );
    expect(hasActiveWork(table)).toBe(true);
    applyReportedSessionState(table, 'kilo_1', { state: 'idle', idleForMs: 0 }, 3000);
    expect(hasActiveWork(table)).toBe(false);
  });
});

describe('resolveSessionEventRoute', () => {
  it.each([
    { kiloSessionId: 'kilo_2' },
    { rootKiloSessionId: 'kilo_2' },
    { kiloSessionId: 'kilo_2', rootKiloSessionId: 'kilo_2' },
    { kiloSessionId: 'kilo_child', rootKiloSessionId: 'kilo_2' },
  ])('selects the exact shared-directory route for identity %j', identity => {
    const { table, second } = sharedDirectoryTable();
    expect(
      resolveSessionEventRoute(table, { directory: worktreeInput.directory, ...identity })
    ).toBe(second);
  });

  it.each([
    {},
    { kiloSessionId: 'kilo_child' },
    { rootKiloSessionId: 'kilo_unknown' },
    { kiloSessionId: 'kilo_1', rootKiloSessionId: 'kilo_unknown' },
    { kiloSessionId: 'kilo_1', rootKiloSessionId: 'kilo_2' },
    { kiloSessionId: 'kilo_2', rootKiloSessionId: 'kilo_1' },
  ])('rejects ambiguous or contradictory shared-directory identity %j', identity => {
    const { table } = sharedDirectoryTable();
    expect(
      resolveSessionEventRoute(table, { directory: worktreeInput.directory, ...identity })
    ).toBeNull();
  });

  it.each([
    { kiloSessionId: 'kilo_1' },
    { rootKiloSessionId: 'kilo_1' },
    { kiloSessionId: 'kilo_child', rootKiloSessionId: 'kilo_1' },
  ])('rejects late identity %j after its shared-worktree root detaches', identity => {
    const { table, second } = sharedDirectoryTable();
    detachRoute(table, 'ses_1');

    expect(getRouteByDirectory(table, worktreeInput.directory)).toBe(second);
    expect(
      resolveSessionEventRoute(table, { directory: worktreeInput.directory, ...identity })
    ).toBeNull();
    expect(
      resolveSessionEventRoute(table, {
        directory: worktreeInput.directory,
        kiloSessionId: 'kilo_child',
        rootKiloSessionId: second.kiloSessionId,
      })
    ).toBe(second);
  });

  it.each([
    { kiloSessionId: 'kilo_2' },
    { rootKiloSessionId: 'kilo_2' },
    { kiloSessionId: 'kilo_child', rootKiloSessionId: 'kilo_2' },
  ])('rejects explicit identity %j conflicting with a different attached directory', identity => {
    const { table } = attachedTable();
    const { route } = attachRoute(
      table,
      { ...attachInput, sessionId: 'ses_2', kiloSessionId: 'kilo_2', directory: '/workspace/b' },
      OWNER
    );
    expect(
      resolveSessionEventRoute(table, { directory: attachInput.directory, ...identity })
    ).toBeNull();
    expect(
      resolveSessionEventRoute(table, { directory: '/workspace/unclaimed-child', ...identity })
    ).toBe(route);
  });

  it('rejects conflicting explicit roots even when the directory has only one route', () => {
    const { table } = attachedTable();
    attachRoute(
      table,
      { ...attachInput, sessionId: 'ses_2', kiloSessionId: 'kilo_2', directory: '/workspace/b' },
      OWNER
    );
    expect(
      resolveSessionEventRoute(table, {
        directory: attachInput.directory,
        rootKiloSessionId: 'kilo_1',
        kiloSessionId: 'kilo_2',
      })
    ).toBeNull();
  });

  it('does not fall back to a known session or directory when an explicit root is unknown', () => {
    const { table } = attachedTable();
    expect(
      resolveSessionEventRoute(table, {
        directory: attachInput.directory,
        rootKiloSessionId: 'kilo_unknown',
        kiloSessionId: 'kilo_1',
      })
    ).toBeNull();
  });

  it('returns the route for a directory hit with no kilo ids', () => {
    const { table, route } = attachedTable();
    expect(resolveSessionEventRoute(table, { directory: '/workspace/a' })).toBe(route);
  });

  it('returns the route when rootKiloSessionId matches', () => {
    const { table, route } = attachedTable();
    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        rootKiloSessionId: 'kilo_1',
      })
    ).toBe(route);
  });

  it('returns null when rootKiloSessionId mismatches', () => {
    const { table } = attachedTable();
    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        rootKiloSessionId: 'kilo_other',
      })
    ).toBeNull();
  });

  it.each(['kilo_child', 'kilo_unknown', ''])(
    'rejects unknown explicit kiloSessionId %j without a known root even for a unique directory',
    kiloSessionId => {
      const { table } = attachedTable();
      expect(
        resolveSessionEventRoute(table, {
          directory: '/workspace/a',
          kiloSessionId,
        })
      ).toBeNull();
    }
  );

  it('routes a child kiloSessionId when rootKiloSessionId matches', () => {
    const { table, route } = attachedTable();
    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: 'kilo_child',
        rootKiloSessionId: 'kilo_1',
      })
    ).toBe(route);
  });

  it('rejects ambiguous directory-only events from grouped siblings', () => {
    const { table } = groupedTable();

    expect(resolveSessionEventRoute(table, { directory: '/workspace/a' })).toBeNull();
    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: 'kilo_unknown_child',
      })
    ).toBeNull();
  });

  it('resolves the exact root before an ambiguous shared directory', () => {
    const { table, second } = groupedTable();

    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: 'kilo_child',
        rootKiloSessionId: second.kiloSessionId,
      })
    ).toBe(second);
  });

  it('resolves an exact root kiloSessionId when root lineage is absent', () => {
    const { table, second } = groupedTable();

    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: second.kiloSessionId,
      })
    ).toBe(second);
  });

  it('rejects contradictory root and exact root-session identities', () => {
    const { table, first, second } = groupedTable();

    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: second.kiloSessionId,
        rootKiloSessionId: first.kiloSessionId,
      })
    ).toBeNull();
  });

  it('rejects an unknown root even when the kiloSessionId identifies an attached root', () => {
    const { table, first } = groupedTable();

    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: first.kiloSessionId,
        rootKiloSessionId: 'kilo_unknown',
      })
    ).toBeNull();
  });

  it('rejects exact identities contradicted by a different attached directory', () => {
    const { table } = attachedTable();
    attachRoute(
      table,
      {
        sessionId: 'ses_2',
        kiloSessionId: 'kilo_2',
        directory: '/workspace/b',
        ownerId: OWNER,
      },
      OWNER
    );

    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/b',
        rootKiloSessionId: 'kilo_1',
      })
    ).toBeNull();
  });

  it('returns null for an unknown directory', () => {
    const { table } = attachedTable();
    expect(resolveSessionEventRoute(table, { directory: '/workspace/missing' })).toBeNull();
  });

  it('looks up an empty directory without throwing', () => {
    const { table } = attachedTable();
    expect(resolveSessionEventRoute(table, { directory: '' })).toBeNull();
  });

  it('falls back to kiloSessionId when directory does not match', () => {
    const { table, route } = attachedTable();
    expect(
      resolveSessionEventRoute(table, {
        directory: '/',
        kiloSessionId: 'kilo_1',
        rootKiloSessionId: 'kilo_1',
      })
    ).toBe(route);
  });
});
