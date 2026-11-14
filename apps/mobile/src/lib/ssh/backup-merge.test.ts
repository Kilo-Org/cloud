import { expect, it, vi } from 'vitest';

import { mergeSshBackup } from './backup-merge';
import { readSshBackup } from './backup-payload';
import { createSshTestDatabase } from './database.test-helpers';
import { createForward, listForwards } from './forwards';
import { createHost, listHosts } from './hosts';
import { listKnownHosts, trustHostKey } from './known-hosts';
import { createSnippet, listSnippets } from './snippets';

vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));

const targetPattern = '[target.test]:2222';

it('imports every key algorithm a host stores instead of treating the second as a conflict', () => {
  const source = createSshTestDatabase();
  const ed25519 = {
    hostPattern: targetPattern,
    keyAlgorithm: 'ssh-ed25519',
    publicKeyBase64: 'ed25519-fixture',
    fingerprintSha256: 'SHA256:host',
  };
  trustHostKey(source, ed25519, 103);
  trustHostKey(
    source,
    {
      hostPattern: targetPattern,
      keyAlgorithm: 'ssh-rsa',
      publicKeyBase64: 'rsa-fixture',
      fingerprintSha256: 'SHA256:host-rsa',
    },
    106
  );
  const backup = readSshBackup(source);

  const empty = mergeSshBackup(createSshTestDatabase(), backup);
  expect(empty.additions.knownHosts.map(row => row.keyAlgorithm)).toEqual([
    'ssh-ed25519',
    'ssh-rsa',
  ]);
  expect(empty.conflicts).toEqual([]);

  const partial = createSshTestDatabase();
  trustHostKey(partial, ed25519, 103);
  const partialPlan = mergeSshBackup(partial, backup);
  expect(partialPlan.additions.knownHosts.map(row => row.keyAlgorithm)).toEqual(['ssh-rsa']);
  expect(listKnownHosts(partial).map(row => row.keyAlgorithm)).toEqual(['ssh-ed25519', 'ssh-rsa']);
});

it('keeps hosts that share a label but not a machine apart with their own snippets', () => {
  const destination = createSshTestDatabase();
  const existing = createHost(
    destination,
    { label: 'linux', hostname: 'one.test', username: 'test', authMethod: 'password' },
    1
  );
  createSnippet(destination, { label: 'local', command: 'pwd', hostId: existing.id }, 2);
  const source = createSshTestDatabase();
  const other = createHost(
    source,
    { label: 'linux', hostname: 'two.test', username: 'test', authMethod: 'password' },
    3
  );
  createSnippet(source, { label: 'local', command: 'uptime', hostId: other.id }, 4);

  const plan = mergeSshBackup(destination, readSshBackup(source));

  expect(plan.conflicts).toEqual([]);
  expect(listHosts(destination).map(host => host.hostname)).toEqual(['one.test', 'two.test']);
  const imported = listHosts(destination).find(host => host.hostname === 'two.test');
  expect(listSnippets(destination).find(snippet => snippet.command === 'uptime')?.hostId).toBe(
    imported?.id
  );
  expect(listSnippets(destination).filter(snippet => snippet.hostId === existing.id)).toHaveLength(
    1
  );
});

it('attaches a skipped host children to the host with the same identity', () => {
  const source = createSshTestDatabase();
  const target = createHost(
    source,
    {
      label: 'target',
      hostname: 'target.test',
      username: 'test',
      port: 2222,
      authMethod: 'password',
    },
    300
  );
  createSnippet(source, { label: 'local', command: 'ls', hostId: target.id }, 301);
  createForward(source, {
    hostId: target.id,
    direction: 'local',
    bindPort: 8080,
    destinationHost: 'localhost',
    destinationPort: 80,
    autoStart: true,
    label: 'web',
  });

  const destination = createSshTestDatabase();
  const decoy = createHost(
    destination,
    { label: 'target', hostname: 'decoy.test', username: 'test', authMethod: 'password' },
    200
  );
  const sameMachine = createHost(
    destination,
    {
      label: 'target',
      hostname: 'target.test',
      username: 'test',
      port: 2222,
      authMethod: 'password',
    },
    201
  );

  const plan = mergeSshBackup(destination, readSshBackup(source));

  expect(plan.conflicts).toContainEqual({ collection: 'hosts', label: 'target' });
  expect(plan.additions.hosts).toEqual([]);
  expect(listSnippets(destination).find(snippet => snippet.label === 'local')?.hostId).toBe(
    sameMachine.id
  );
  expect(listForwards(destination).find(forward => forward.label === 'web')?.hostId).toBe(
    sameMachine.id
  );
  expect(listForwards(destination).find(forward => forward.label === 'web')?.hostId).not.toBe(
    decoy.id
  );
  expect(listHosts(destination)).toHaveLength(2);
});
