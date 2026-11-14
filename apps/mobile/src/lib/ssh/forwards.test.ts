import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SshDatabase } from './database';
import { createSshTestDatabase } from './database.test-helpers';
import {
  createForward,
  deleteForward,
  forwardLabel,
  getForward,
  listForwards,
  listForwardsForHost,
  updateForward,
} from './forwards';
import { createHost } from './hosts';

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
const host = (label: string) =>
  createHost(db, {
    label,
    hostname: `${label}.test`,
    username: 'igor',
    authMethod: 'password',
  } as unknown as Parameters<typeof createHost>[1]);

beforeEach(() => {
  db = createSshTestDatabase();
});

describe('stored forwards', () => {
  it('updates every field of a stored forward', () => {
    const owner = host('web');
    const created = createForward(db, {
      hostId: owner.id,
      direction: 'local',
      bindPort: 8080,
      destinationHost: '127.0.0.1',
      destinationPort: 80,
      autoStart: true,
      label: 'Web app',
    });

    const updated = updateForward(db, created.id, {
      hostId: owner.id,
      direction: 'remote',
      bindHost: '0.0.0.0',
      bindPort: 9000,
      destinationHost: '10.0.0.5',
      destinationPort: 5432,
      autoStart: false,
      label: 'Database',
    });

    expect(updated).toMatchObject({
      id: created.id,
      direction: 'remote',
      bindHost: '0.0.0.0',
      bindPort: 9000,
      destinationHost: '10.0.0.5',
      destinationPort: 5432,
      autoStart: false,
      label: 'Database',
    });
    expect(getForward(db, created.id)).toEqual(updated);
  });

  it('deletes a forward without touching the host', () => {
    const owner = host('web');
    const created = createForward(db, {
      hostId: owner.id,
      direction: 'local',
      bindPort: 3000,
      destinationHost: '127.0.0.1',
      destinationPort: 3000,
      autoStart: false,
      label: null,
    });

    deleteForward(db, created.id);

    expect(getForward(db, created.id)).toBeNull();
    expect(listForwards(db)).toEqual([]);
  });

  it('lists one host forwards, local before remote', () => {
    const web = host('web');
    const db2 = host('db');
    const make = (hostId: string, direction: 'local' | 'remote', bindPort: number) =>
      createForward(db, {
        hostId,
        direction,
        bindPort,
        destinationHost: '127.0.0.1',
        destinationPort: 80,
        autoStart: false,
        label: null,
      });
    make(web.id, 'remote', 1000);
    make(web.id, 'local', 2000);
    make(db2.id, 'local', 3000);

    expect(listForwardsForHost(db, web.id).map(forward => forward.bindPort)).toEqual([2000, 1000]);
  });

  it('names a forward by its label, or by its mapping', () => {
    expect(
      forwardLabel({
        label: null,
        bindHost: '127.0.0.1',
        bindPort: 8080,
        destinationHost: 'localhost',
        destinationPort: 80,
      })
    ).toBe('127.0.0.1:8080 → localhost:80');
  });
});
