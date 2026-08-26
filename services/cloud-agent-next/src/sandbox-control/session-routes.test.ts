import { describe, expect, it } from 'vitest';
import {
  applyReportedSessionState,
  attachRoute,
  clearNeedsSync,
  detachRoute,
  emptyRouteTable,
  getRouteByDirectory,
  getRouteByKiloSessionId,
  getRouteBySessionId,
  hasActiveWork,
  markNeedsSync,
  markStalled,
  resolveSessionEventRoute,
} from './session-routes.js';

const OWNER = 'owner_1';

const attachInput = {
  sessionId: 'ses_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace/a',
  ownerId: OWNER,
};

function attachedTable() {
  return attachRoute(emptyRouteTable(), attachInput, OWNER);
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
      needsSync: false,
      stalled: false,
    });
    expect(getRouteBySessionId(table, 'ses_1')).toBe(route);
    expect(getRouteByDirectory(table, '/workspace/a')).toBe(route);
    expect(getRouteByKiloSessionId(table, 'kilo_1')).toBe(route);
  });

  it('reattaches the same tuple idempotently', () => {
    const { table, route } = attachedTable();
    const again = attachRoute(table, attachInput, OWNER);
    expect(again.changed).toBe(false);
    expect(again.route).toBe(route);
    expect(table.size).toBe(1);
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

  it('detaches a route', () => {
    const { table } = attachedTable();
    expect(detachRoute(table, 'ses_1')).toEqual({ table, existed: true });
    expect(getRouteBySessionId(table, 'ses_1')).toBeUndefined();
    expect(getRouteByDirectory(table, '/workspace/a')).toBeUndefined();
    expect(detachRoute(table, 'ses_1')).toEqual({ table, existed: false });
  });

  it('sets and clears needsSync', () => {
    const { table } = attachedTable();
    markNeedsSync(table, 'ses_1');
    expect(getRouteBySessionId(table, 'ses_1')?.needsSync).toBe(true);
    clearNeedsSync(table, 'ses_1');
    expect(getRouteBySessionId(table, 'ses_1')?.needsSync).toBe(false);
    expect(markNeedsSync(table, 'missing').size).toBe(1);
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

  it('marks a route stalled', () => {
    const { table } = attachedTable();
    markStalled(table, 'ses_1');
    expect(getRouteBySessionId(table, 'ses_1')?.stalled).toBe(true);
    expect(markStalled(table, 'missing').size).toBe(1);
  });

  it('does not count a stalled session as active work', () => {
    const { table } = attachedTable();
    expect(hasActiveWork(table)).toBe(false);
    applyReportedSessionState(table, 'kilo_1', { state: 'active', idleForMs: 0 }, 1000);
    expect(hasActiveWork(table)).toBe(true);
    markStalled(table, 'ses_1');
    expect(hasActiveWork(table)).toBe(false);
  });
});

describe('resolveSessionEventRoute', () => {
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

  it('still routes when kiloSessionId is a child and rootKiloSessionId is absent', () => {
    const { table, route } = attachedTable();
    expect(
      resolveSessionEventRoute(table, {
        directory: '/workspace/a',
        kiloSessionId: 'kilo_child',
      })
    ).toBe(route);
  });

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
