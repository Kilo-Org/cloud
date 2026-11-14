import { expect, it, vi } from 'vitest';

import { mergeSshBackup, planSshBackupMerge } from './backup-merge';
import {
  BACKUP_COLLECTIONS,
  InvalidSshExportError,
  parseSshBackup,
  readSshBackup,
} from './backup-payload';
import { createSshTestDatabase } from './database.test-helpers';
import { createForward } from './forwards';
import { createHost, listHosts, updateHost } from './hosts';
import { createKey } from './keys';
import { trustHostKey } from './known-hosts';
import { createSnippet } from './snippets';

vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));

function populatedDatabase() {
  const db = createSshTestDatabase();
  const key = createKey(
    db,
    {
      label: 'fixture key',
      algorithm: 'ed25519',
      source: 'imported',
      privateKeyOpenssh: 'test-only-private-key',
      publicKeyOpenssh: 'ssh-ed25519 fixture',
      fingerprintSha256: 'SHA256:fixture',
      passphrase: 'key-passphrase',
    },
    100
  );
  const jump = createHost(
    db,
    {
      label: 'jump',
      hostname: 'jump.test',
      username: 'test',
      authMethod: 'password',
      password: 'test-password',
    },
    101
  );
  const host = createHost(
    db,
    {
      label: 'target',
      hostname: 'target.test',
      username: 'test',
      authMethod: 'key',
      keyId: key.id,
      jumpHostId: jump.id,
      tmuxAttach: true,
      tmuxSessionName: 'work',
      port: 2222,
    },
    102
  );
  trustHostKey(
    db,
    {
      hostPattern: '[target.test]:2222',
      keyAlgorithm: 'ssh-ed25519',
      publicKeyBase64: 'fixture',
      fingerprintSha256: 'SHA256:host',
    },
    103
  );
  createSnippet(db, { label: 'global', command: 'pwd', appendNewline: false }, 104);
  createSnippet(db, { label: 'local', command: 'ls', hostId: host.id, sortOrder: 4 }, 105);
  createForward(db, {
    hostId: host.id,
    direction: 'local',
    bindPort: 8080,
    destinationHost: 'localhost',
    destinationPort: 80,
    autoStart: true,
    label: 'web',
  });
  return db;
}

it('round trips every collection and remaps private keys, jump hosts, snippets and forwards', () => {
  const source = populatedDatabase();
  const backup = parseSshBackup(JSON.stringify(readSshBackup(source)));
  const destination = createSshTestDatabase();
  mergeSshBackup(destination, backup);
  const restored = readSshBackup(destination);
  const target = restored.hosts.find(host => host.label === 'target');
  const jump = restored.hosts.find(host => host.label === 'jump');
  expect(target).toMatchObject({
    hostname: 'target.test',
    port: 2222,
    tmuxAttach: true,
    tmuxSessionName: 'work',
    keyId: restored.keys[0]?.id,
    jumpHostId: jump?.id,
  });
  expect(restored.keys[0]).toMatchObject({
    privateKeyOpenssh: 'test-only-private-key',
    passphrase: 'key-passphrase',
    createdAt: 100,
  });
  expect(restored.hosts.find(host => host.label === 'jump')?.password).toBe('test-password');
  expect(restored.snippets.find(snippet => snippet.label === 'local')).toMatchObject({
    hostId: target?.id,
    sortOrder: 4,
    createdAt: 105,
    updatedAt: 105,
  });
  expect(restored.forwards[0]).toMatchObject({
    hostId: target?.id,
    autoStart: true,
    destinationPort: 80,
  });
  expect(restored.knownHosts[0]).toMatchObject({ hostPattern: '[target.test]:2222', addedAt: 103 });
  for (const collection of BACKUP_COLLECTIONS) {
    expect(restored[collection]).toHaveLength(backup[collection].length);
  }
  expect(target?.id).not.toBe(backup.hosts.find(host => host.label === 'target')?.id);
});

it('skips duplicates by natural identity, reports conflicts and does not overwrite existing secrets', () => {
  const db = populatedDatabase();
  const backup = readSshBackup(db);
  const incoming = {
    ...backup,
    hosts: backup.hosts.map(host => ({ ...host, password: 'do-not-overwrite' })),
    keys: backup.keys.map(key => ({
      ...key,
      label: 'different label',
      privateKeyOpenssh: 'do-not-overwrite',
    })),
    knownHosts: backup.knownHosts.map(host => ({
      ...host,
      keyAlgorithm: 'ssh-rsa',
      fingerprintSha256: 'changed',
    })),
  };
  const plan = mergeSshBackup(db, incoming);
  for (const collection of BACKUP_COLLECTIONS) {
    expect(plan.additions[collection]).toHaveLength(0);
  }
  expect(plan.conflicts).toHaveLength(7);
  expect(readSshBackup(db)).toEqual(backup);
});

it('remaps duplicate key and host references to the rows already on this device', () => {
  const source = populatedDatabase();
  const backup = readSshBackup(source);
  const destination = createSshTestDatabase();
  const existingJump = createHost(destination, {
    label: 'jump',
    hostname: 'keep.test',
    username: 'keep',
    authMethod: 'password',
  });
  const key = backup.keys[0];
  if (key === undefined) {
    throw new Error('Missing test key');
  }
  const existingKey = createKey(destination, { ...key, label: 'keep' });
  mergeSshBackup(destination, backup);
  expect(listHosts(destination).find(host => host.label === 'target')).toMatchObject({
    keyId: existingKey.id,
    jumpHostId: existingJump.id,
  });
  expect(listHosts(destination).find(host => host.id === existingJump.id)?.hostname).toBe(
    'keep.test'
  );
});

it('does not confuse overlapping source and destination IDs when matching scoped records', () => {
  const existing = readSshBackup(populatedDatabase());
  const incoming = structuredClone(existing);
  const first = incoming.hosts[0];
  const second = incoming.hosts[1];
  if (first === undefined || second === undefined) {
    throw new Error('Missing fixture hosts');
  }
  first.label = 'new-jump';
  second.label = 'new-target';
  const plan = planSshBackupMerge(incoming, existing);
  expect(plan.additions.hosts).toHaveLength(2);
  expect(plan.additions.snippets.map(snippet => snippet.label)).toEqual(['local']);
  expect(plan.additions.forwards).toHaveLength(1);
});

it.each(['not-json', '{}', '{"format":"kilo-ssh","version":2}'])(
  'rejects malformed and unsupported exports: %s',
  value => {
    expect(() => parseSshBackup(value)).toThrow(InvalidSshExportError);
  }
);

it('rejects missing references, duplicate IDs, invalid ports, unknown fields and jump cycles before writes', () => {
  const backup = readSshBackup(populatedDatabase());
  const host = backup.hosts[0];
  if (host === undefined) {
    throw new Error('Missing fixture host');
  }
  for (const invalid of [
    { ...backup, hosts: [{ ...host, keyId: 'missing' }] },
    { ...backup, hosts: [{ ...host, port: 65536 }] },
    { ...backup, hosts: [{ ...host, jumpHostId: host.id }] },
    { ...backup, keys: [...backup.keys, ...backup.keys] },
    { ...backup, extra: true },
  ]) {
    expect(() => parseSshBackup(JSON.stringify(invalid))).toThrow(InvalidSshExportError);
  }
});

it('rolls back every collection when a later write fails', () => {
  const source = populatedDatabase();
  const destination = createSshTestDatabase();
  const incoming = readSshBackup(source);
  const failingDatabase: typeof destination = {
    ...destination,
    runSync: (sql, params) => {
      if (sql.includes('insert into ssh_forwards')) {
        throw new Error('storage refused');
      }
      destination.runSync(sql, params);
    },
  };
  expect(() => mergeSshBackup(failingDatabase, incoming)).toThrow('storage refused');
  for (const collection of BACKUP_COLLECTIONS) {
    expect(readSshBackup(destination)[collection]).toHaveLength(0);
  }
});

it('preserves updated timestamps after wiring imported jumps', () => {
  const source = populatedDatabase();
  const target = listHosts(source).find(host => host.label === 'target');
  if (target === undefined) {
    throw new Error('Missing fixture target');
  }
  updateHost(source, target.id, { username: 'changed' });
  const backup = readSshBackup(source);
  const destination = createSshTestDatabase();
  mergeSshBackup(destination, backup);
  expect(listHosts(destination).find(host => host.label === 'target')?.updatedAt).toBe(
    backup.hosts.find(host => host.id === target.id)?.updatedAt
  );
});

it('rejects jump cycles introduced by collapsing duplicate host labels before writing', () => {
  const backup = readSshBackup(populatedDatabase());
  const jump = backup.hosts.find(host => host.label === 'jump');
  const target = backup.hosts.find(host => host.label === 'target');
  if (jump === undefined || target === undefined) {
    throw new Error('Missing fixture hosts');
  }
  const incoming = {
    ...backup,
    hosts: [
      { ...target, label: 'same' },
      { ...jump, label: 'same' },
    ],
  };
  const destination = createSshTestDatabase();
  expect(() => mergeSshBackup(destination, incoming)).toThrow(InvalidSshExportError);
  expect(readSshBackup(destination).hosts).toEqual([]);
});
