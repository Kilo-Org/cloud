import { beforeEach, describe, expect, it, vi } from 'vitest';

import { importSshConfig, planSshConfigImport } from './config-import';
import { type SshDatabase } from './database';
import { createSshTestDatabase } from './database.test-helpers';
import {
  createForward,
  getForward,
  listForwards,
  listForwardsForHost,
  SshForwardConflictError,
  updateForward,
} from './forwards';
import { createHost, getHost, listHosts, SshJumpHostCycleError, updateHost } from './hosts';

const ids = vi.hoisted(() => {
  let next = 0;
  return {
    nextId: () => {
      next += 1;
      return `id-${next}`;
    },
  };
});

vi.mock('expo-crypto', () => ({ randomUUID: ids.nextId }));

let db: SshDatabase = createSshTestDatabase();

beforeEach(() => {
  db = createSshTestDatabase();
});

const host = (label: string, extra: Record<string, unknown> = {}) =>
  createHost(db, {
    label,
    hostname: `${label}.test`,
    username: 'igor',
    authMethod: 'password',
    ...extra,
  } as unknown as Parameters<typeof createHost>[1]);

describe('jump hosts', () => {
  it('accepts a chain of jumps', () => {
    const outer = host('outer');
    const inner = host('inner', { jumpHostId: outer.id });
    const target = host('target', { jumpHostId: inner.id });

    expect(getHost(db, target.id)?.jumpHostId).toBe(inner.id);
  });

  it('refuses a host that jumps through itself', () => {
    const created = host('web');

    expect(() => updateHost(db, created.id, { jumpHostId: created.id })).toThrow(
      SshJumpHostCycleError
    );
    expect(getHost(db, created.id)?.jumpHostId).toBeNull();
  });

  it('refuses a jump that would close a loop through another host', () => {
    const outer = host('outer');
    const inner = host('inner', { jumpHostId: outer.id });

    expect(() => updateHost(db, outer.id, { jumpHostId: inner.id })).toThrow(SshJumpHostCycleError);
    expect(getHost(db, outer.id)?.jumpHostId).toBeNull();
  });
});

describe('forward bind addresses', () => {
  const forward = (hostId: string, bindPort: number, direction: 'local' | 'remote' = 'local') => ({
    hostId,
    direction,
    bindHost: '127.0.0.1',
    bindPort,
    destinationHost: 'dep',
    destinationPort: 80,
    autoStart: false,
    label: null,
  });

  it('ships the unique index the store relies on', () => {
    const indexes = db.getAllSync<{ name: string }>(
      "select name from sqlite_master where type = 'index' and name = 'ssh_forwards_bind'",
      []
    );

    expect(indexes).toEqual([{ name: 'ssh_forwards_bind' }]);
  });

  it('refuses a second forward on the same address', () => {
    const target = host('target');
    createForward(db, forward(target.id, 18080));

    expect(() => createForward(db, forward(target.id, 18080))).toThrow(SshForwardConflictError);
    expect(listForwardsForHost(db, target.id)).toHaveLength(1);
  });

  it('refuses a second forward on the same port for the same direction only', () => {
    const target = host('target');
    createForward(db, forward(target.id, 18080));

    expect(() => createForward(db, forward(target.id, 18080, 'remote'))).not.toThrow();
    expect(listForwardsForHost(db, target.id)).toHaveLength(2);
  });

  it('lets one forward move to another port and leaves its own address available', () => {
    const target = host('target');
    const stored = createForward(db, forward(target.id, 18080));

    const moved = updateForward(db, stored.id, { ...forward(target.id, 18081) });

    expect(moved.bindPort).toBe(18081);
  });

  it('refuses an edit onto an address another forward holds', () => {
    const target = host('target');
    createForward(db, forward(target.id, 18080));
    const second = createForward(db, forward(target.id, 18081));

    expect(() => updateForward(db, second.id, forward(target.id, 18080))).toThrow(
      SshForwardConflictError
    );
    expect(getForward(db, second.id)?.bindPort).toBe(18081);
  });
});

describe('ssh config import', () => {
  const CONFIG = `
Host bastion
  User jump
Host internal
  User igor
  HostName internal.example.com
  Port 2222
  ProxyJump bastion
  LocalForward 8080 localhost:80
`;

  it('writes the hosts, their jump and their forwards in one call', () => {
    const result = importSshConfig(db, planSshConfigImport(CONFIG, []));

    expect(result.hosts.map(row => row.label)).toEqual(['bastion', 'internal']);
    expect(result.forwardCount).toBe(1);
    const [bastion, internal] = result.hosts;
    expect(internal).toMatchObject({ port: 2222, hostname: 'internal.example.com' });
    expect(internal?.jumpHostId).toBe(bastion?.id);
    expect(listForwards(db)).toMatchObject([{ hostId: internal?.id, bindPort: 8080 }]);
  });

  it('resolves a jump to a host that was already stored', () => {
    const stored = host('bastion');

    const result = importSshConfig(
      db,
      planSshConfigImport('Host internal\n  User igor\n  ProxyJump bastion\n', listHosts(db))
    );

    expect(result.hosts[0]?.jumpHostId).toBe(stored.id);
  });

  it('leaves the store untouched when a host in the batch is refused', () => {
    const plan = planSshConfigImport(CONFIG, []);
    const first = plan.hosts[0];
    if (first === undefined) {
      throw new Error('the fixture config produced no host');
    }
    const hosts = [...plan.hosts, { ...first, alias: 'broken', username: '' }];

    expect(() => importSshConfig(db, { ...plan, hosts })).toThrow();
    expect(listHosts(db)).toEqual([]);
    expect(listForwards(db)).toEqual([]);
  });
});
