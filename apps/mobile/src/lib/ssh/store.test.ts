import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import migrations from '../../../drizzle/migrations';
import { enableForeignKeys } from '../persist/foreign-keys';
import { type SqlValue, type SshDatabase } from './database';
import { createForward, getForward, listForwards, type SshForwardInput } from './forwards';
import { createHost, deleteHost, getHost, listHosts, type SshHostInput, updateHost } from './hosts';
import { createKey, deleteKey, getKey, listKeys, type SshKeyInput, updateKey } from './keys';
import {
  findKnownHost,
  getKnownHost,
  listKnownHosts,
  removeKnownHost,
  replaceHostKey,
  trustHostKey,
} from './known-hosts';
import { createSnippet, getSnippet, listSnippets } from './snippets';

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

/**
 * The tables run against the migrations the app ships: this is the same
 * `drizzle/migrations` bundle `encrypted-kv.ts` hands to the migrator, so a
 * migration that moves breaks this suite rather than passing against a copy.
 */
const migrationBundle = z
  .object({
    journal: z.object({ entries: z.array(z.object({ idx: z.number().int(), tag: z.string() })) }),
    migrations: z.record(z.string(), z.string()),
  })
  .parse(migrations);

const MIGRATIONS = migrationBundle.journal.entries.flatMap(entry => {
  const sql = migrationBundle.migrations[`m${String(entry.idx).padStart(4, '0')}`];
  if (!sql) {
    throw new Error(`Missing migration: ${entry.tag}`);
  }
  return sql
    .split('--> statement-breakpoint')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
});

const sshDatabase = (database: DatabaseSync): SshDatabase => ({
  getAllSync: <T>(source: string, params: SqlValue[]): T[] =>
    database.prepare(source).all(...params) as T[],
  runSync: (source: string, params: SqlValue[]) => {
    database.prepare(source).run(...params);
  },
});

let database = new DatabaseSync(':memory:');
let db: SshDatabase = sshDatabase(database);

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  // The same order as the app's open path: migrations first, on a connection
  // with enforcement off, then `enableForeignKeys`.
  for (const statement of MIGRATIONS) {
    database.exec(statement);
  }
  enableForeignKeys({
    execSync: statement => {
      database.exec(statement);
    },
  });
  db = sshDatabase(database);
});

/** Fixture casts cover the rejection paths, which deliberately pass values the input type forbids. */
const hostInput = (label: string, extra: Record<string, unknown> = {}): SshHostInput =>
  ({
    label,
    hostname: `${label}.example.com`,
    username: 'igor',
    authMethod: 'password',
    ...extra,
  }) as unknown as SshHostInput;

const keyInput = (label: string, extra: Record<string, unknown> = {}): SshKeyInput =>
  ({
    label,
    algorithm: 'ed25519',
    source: 'generated',
    privateKeyOpenssh: `-----BEGIN OPENSSH PRIVATE KEY----- ${label}`,
    publicKeyOpenssh: `ssh-ed25519 AAAA ${label}`,
    fingerprintSha256: `SHA256:${label}`,
    ...extra,
  }) as unknown as SshKeyInput;

const host = (label: string, extra: Record<string, unknown> = {}) =>
  createHost(db, hostInput(label, extra));

const key = (label: string, extra: Record<string, unknown> = {}) =>
  createKey(db, keyInput(label, extra));

describe('the connection', () => {
  it('enforces foreign keys once the migrations have run', () => {
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
});

describe('hosts', () => {
  it('lists by sort order, then label', () => {
    host('zulu', { sortOrder: 1 });
    host('alpha', { sortOrder: 0 });
    host('bravo', { sortOrder: 0 });

    expect(listHosts(db).map(row => row.label)).toEqual(['alpha', 'bravo', 'zulu']);
  });

  it('defaults the port, tmux, sort order and references', () => {
    const created = host('web');

    expect(created).toMatchObject({
      port: 22,
      tmuxAttach: false,
      sortOrder: 0,
      lastConnectedAt: null,
      keyId: null,
      jumpHostId: null,
    });
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it('rejects a port outside 1-65535 and an unknown auth method on create', () => {
    expect(() => host('zero', { port: 0 })).toThrow();
    expect(() => host('high', { port: 65536 })).toThrow();
    expect(() => host('agent', { authMethod: 'agent' })).toThrow();
    expect(listHosts(db)).toEqual([]);
  });

  it('rejects a port outside 1-65535 on update', () => {
    const created = host('web');

    expect(() => updateHost(db, created.id, { port: 70000 })).toThrow();
    expect(getHost(db, created.id)?.port).toBe(22);
  });

  it('keeps the fields a patch does not name', () => {
    const created = host('web', { password: 'hunter2', tmuxAttach: true, tmuxSessionName: 'work' });

    const renamed = updateHost(db, created.id, { label: 'prod', lastConnectedAt: 500 });

    expect(renamed).toMatchObject({
      label: 'prod',
      password: 'hunter2',
      tmuxAttach: true,
      tmuxSessionName: 'work',
      lastConnectedAt: 500,
    });
  });

  it('nulls a host key reference when its key is deleted', () => {
    const created = key('laptop');
    const withKey = host('secure', { keyId: created.id, authMethod: 'key' });

    deleteKey(db, created.id);

    expect(getHost(db, withKey.id)?.keyId).toBeNull();
  });

  it('nulls a jump host reference when the jump host is deleted', () => {
    const jump = host('bastion');
    const behind = host('internal', { jumpHostId: jump.id });

    deleteHost(db, jump.id);

    expect(getHost(db, behind.id)?.jumpHostId).toBeNull();
  });

  it('deletes its snippets and forwards with it', () => {
    const doomed = host('doomed');
    const kept = host('kept');
    createSnippet(db, { label: 'deploy', command: 'make deploy', hostId: doomed.id });
    createSnippet(db, { label: 'global', command: 'uptime' });
    createForward(db, {
      hostId: doomed.id,
      direction: 'local',
      bindPort: 8080,
      destinationHost: 'db.internal',
      destinationPort: 5432,
    });
    createForward(db, {
      hostId: kept.id,
      direction: 'remote',
      bindPort: 9000,
      destinationHost: 'localhost',
      destinationPort: 3000,
    });

    deleteHost(db, doomed.id);

    expect(listSnippets(db).map(row => row.label)).toEqual(['global']);
    expect(listForwards(db).map(row => row.hostId)).toEqual([kept.id]);
  });
});

describe('keys', () => {
  it('creates, lists, reads and deletes one key', () => {
    const zulu = key('zulu');
    key('alpha');

    expect(listKeys(db).map(row => row.label)).toEqual(['alpha', 'zulu']);
    expect(getKey(db, zulu.id)).toEqual(zulu);

    deleteKey(db, zulu.id);

    expect(listKeys(db).map(row => row.label)).toEqual(['alpha']);
    expect(getKey(db, zulu.id)).toBeNull();
  });

  it('defaults the passphrase to null and rejects an unknown algorithm', () => {
    expect(key('laptop').passphrase).toBeNull();
    expect(() => key('bad', { algorithm: 'dsa' })).toThrow();
    expect(listKeys(db).map(row => row.label)).toEqual(['laptop']);
  });

  it('keeps the passphrase when a patch does not name it', () => {
    const created = key('laptop', { algorithm: 'rsa', passphrase: 'phrase' });

    const renamed = updateKey(db, created.id, { label: 'desktop' });

    expect(renamed).toMatchObject({ label: 'desktop', passphrase: 'phrase', algorithm: 'rsa' });
  });
});

describe('known hosts', () => {
  const hostKey = {
    hostPattern: '[example.com]:2222',
    keyAlgorithm: 'ssh-ed25519',
    publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5',
    fingerprintSha256: 'SHA256:first',
  };

  it('finds a trusted key by pattern and algorithm only', () => {
    const trusted = trustHostKey(db, hostKey);

    expect(findKnownHost(db, hostKey.hostPattern, hostKey.keyAlgorithm)).toEqual(trusted);
    expect(findKnownHost(db, hostKey.hostPattern, 'ssh-rsa')).toBeNull();
    expect(findKnownHost(db, 'example.com', hostKey.keyAlgorithm)).toBeNull();
  });

  it('rejects a second key for the same pattern and algorithm', () => {
    trustHostKey(db, hostKey);

    expect(() =>
      trustHostKey(db, {
        ...hostKey,
        publicKeyBase64: 'AAAAC3NzaC1yc2E',
        fingerprintSha256: 'SHA256:second',
      })
    ).toThrow();
    expect(listKnownHosts(db)).toHaveLength(1);
  });

  it('replaces a stored key in place, keeping one row and the unique pair', () => {
    const trusted = trustHostKey(db, hostKey);

    const replaced = replaceHostKey(db, trusted.id, {
      keyAlgorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAB',
      fingerprintSha256: 'SHA256:rotated',
    });

    expect(replaced).toMatchObject({
      id: trusted.id,
      fingerprintSha256: 'SHA256:rotated',
      publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAB',
    });
    expect(listKnownHosts(db)).toHaveLength(1);
    expect(getKnownHost(db, trusted.id)?.fingerprintSha256).toBe('SHA256:rotated');
  });

  it('removes one entry', () => {
    const trusted = trustHostKey(db, hostKey);

    removeKnownHost(db, trusted.id);

    expect(listKnownHosts(db)).toEqual([]);
    expect(findKnownHost(db, hostKey.hostPattern, hostKey.keyAlgorithm)).toBeNull();
  });

  it('refuses an empty pattern or key', () => {
    expect(() => trustHostKey(db, { ...hostKey, hostPattern: '' })).toThrow();
    expect(() => trustHostKey(db, { ...hostKey, publicKeyBase64: '' })).toThrow();
    expect(listKnownHosts(db)).toEqual([]);
  });
});

describe('snippets', () => {
  it('orders by sort order then label, and defaults the newline', () => {
    createSnippet(db, { label: 'zulu', command: 'z', sortOrder: 1 });
    createSnippet(db, { label: 'bravo', command: 'b' });
    const saved = createSnippet(db, { label: 'alpha', command: 'a' });

    expect(listSnippets(db).map(row => row.label)).toEqual(['alpha', 'bravo', 'zulu']);
    expect(saved.appendNewline).toBe(true);
    expect(getSnippet(db, saved.id)).toEqual(saved);
  });
});

describe('forwards', () => {
  it('defaults the bind host and auto start and rejects a bad port or direction', () => {
    const owner = host('owner');
    const created = createForward(db, {
      hostId: owner.id,
      direction: 'local',
      bindPort: 8080,
      destinationHost: 'db.internal',
      destinationPort: 5432,
    });

    expect(created).toMatchObject({ bindHost: '127.0.0.1', autoStart: false, label: null });
    expect(getForward(db, created.id)).toEqual(created);
    expect(() =>
      createForward(db, {
        hostId: owner.id,
        direction: 'local',
        bindPort: 0,
        destinationHost: 'db.internal',
        destinationPort: 5432,
      })
    ).toThrow();
    expect(() =>
      createForward(db, {
        hostId: owner.id,
        direction: 'dynamic',
        bindPort: 1080,
        destinationHost: 'db.internal',
        destinationPort: 5432,
      } as unknown as SshForwardInput)
    ).toThrow();
    expect(listForwards(db)).toHaveLength(1);
  });
});
