import {
  InvalidSshExportError,
  readSshBackup,
  type SshBackup,
  type SshBackupCollection,
} from './backup-payload';
import { type SshDatabase } from './database';
import { createForward } from './forwards';
import { createHost, updateHost } from './hosts';
import { createKey } from './keys';
import { trustHostKey } from './known-hosts';
import { createSnippet } from './snippets';

type SshBackupConflict = { collection: SshBackupCollection; label: string };
export type SshBackupPlan = {
  incoming: SshBackup;
  additions: SshBackup;
  conflicts: SshBackupConflict[];
};

export function planSshBackupMerge(incoming: SshBackup, existing: SshBackup): SshBackupPlan {
  const conflicts: SshBackupConflict[] = [];
  function unique<T>({
    collection,
    rows,
    known,
    identity,
    label,
    existingIdentity = identity,
  }: {
    collection: SshBackupCollection;
    rows: T[];
    known: T[];
    identity: (row: T) => string;
    label: (row: T) => string;
    existingIdentity?: (row: T) => string;
  }): T[] {
    const seen = new Set(known.map(row => existingIdentity(row)));
    return rows.filter(row => {
      const key = identity(row);
      if (seen.has(key)) {
        conflicts.push({ collection, label: label(row) });
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  const labels = new Map(incoming.hosts.map(host => [host.id, host.label]));
  const existingLabels = new Map(existing.hosts.map(host => [host.id, host.label]));
  const scope = (id: string | null, source = labels) => (id === null ? null : source.get(id));
  const additions: SshBackup = {
    format: 'kilo-ssh',
    version: 1,
    keys: unique({
      collection: 'keys',
      rows: incoming.keys,
      known: existing.keys,
      identity: row => row.fingerprintSha256,
      label: row => row.label,
    }),
    hosts: unique({
      collection: 'hosts',
      rows: incoming.hosts,
      known: existing.hosts,
      identity: row => row.label,
      label: row => row.label,
    }),
    knownHosts: unique({
      collection: 'knownHosts',
      rows: incoming.knownHosts,
      known: existing.knownHosts,
      identity: row => row.hostPattern,
      label: row => row.hostPattern,
    }),
    snippets: unique({
      collection: 'snippets',
      rows: incoming.snippets,
      known: existing.snippets,
      identity: row => JSON.stringify([scope(row.hostId), row.label]),
      label: row => row.label,
      existingIdentity: row => JSON.stringify([scope(row.hostId, existingLabels), row.label]),
    }),
    forwards: unique({
      collection: 'forwards',
      rows: incoming.forwards,
      known: existing.forwards,
      identity: row =>
        JSON.stringify([scope(row.hostId), row.direction, row.bindHost, row.bindPort]),
      label: row => row.label ?? `${row.bindHost}:${row.bindPort}`,
      existingIdentity: row =>
        JSON.stringify([
          scope(row.hostId, existingLabels),
          row.direction,
          row.bindHost,
          row.bindPort,
        ]),
    }),
  };
  const incomingById = new Map(incoming.hosts.map(host => [host.id, host]));
  const addedByLabel = new Map(additions.hosts.map(host => [host.label, host]));
  const keptLabels = new Set(existing.hosts.map(host => host.label));
  for (const host of additions.hosts) {
    const seen = new Set([host.label]);
    let current = host;
    while (current.jumpHostId !== null) {
      const next = incomingById.get(current.jumpHostId);
      if (next === undefined) {
        throw new InvalidSshExportError();
      }
      if (keptLabels.has(next.label)) {
        break;
      }
      if (seen.has(next.label)) {
        throw new InvalidSshExportError();
      }
      seen.add(next.label);
      const added = addedByLabel.get(next.label);
      if (added === undefined) {
        throw new InvalidSshExportError();
      }
      current = added;
    }
  }
  return { incoming, additions, conflicts };
}

export function mergeSshBackup(db: SshDatabase, incoming: SshBackup): SshBackupPlan {
  const existing = readSshBackup(db);
  const plan = planSshBackupMerge(incoming, existing);
  db.withTransactionSync(() => {
    const keysByFingerprint = new Map(existing.keys.map(key => [key.fingerprintSha256, key.id]));
    for (const key of plan.additions.keys) {
      keysByFingerprint.set(key.fingerprintSha256, createKey(db, key, key.createdAt).id);
    }
    const keyIds = new Map(
      incoming.keys.map(key => [key.id, keysByFingerprint.get(key.fingerprintSha256)])
    );
    const hostsByLabel = new Map(existing.hosts.map(host => [host.label, host.id]));
    for (const host of plan.additions.hosts) {
      const created = createHost(
        db,
        {
          ...host,
          keyId: host.keyId === null ? null : requiredId(keyIds, host.keyId),
          jumpHostId: null,
        },
        host.createdAt
      );
      hostsByLabel.set(host.label, created.id);
    }
    const hostIds = new Map(incoming.hosts.map(host => [host.id, hostsByLabel.get(host.label)]));
    for (const host of plan.additions.hosts) {
      if (host.jumpHostId !== null) {
        updateHost(db, requiredId(hostIds, host.id), {
          jumpHostId: requiredId(hostIds, host.jumpHostId),
        });
      }
      db.runSync('update ssh_hosts set updated_at = ? where id = ?', [
        host.updatedAt,
        requiredId(hostIds, host.id),
      ]);
    }
    for (const host of plan.additions.knownHosts) {
      trustHostKey(db, host, host.addedAt);
    }
    for (const snippet of plan.additions.snippets) {
      const created = createSnippet(
        db,
        {
          ...snippet,
          hostId: snippet.hostId === null ? null : requiredId(hostIds, snippet.hostId),
        },
        snippet.createdAt
      );
      db.runSync('update ssh_snippets set updated_at = ? where id = ?', [
        snippet.updatedAt,
        created.id,
      ]);
    }
    for (const forward of plan.additions.forwards) {
      createForward(db, { ...forward, hostId: requiredId(hostIds, forward.hostId) });
    }
  });
  return plan;
}

function requiredId(ids: ReadonlyMap<string, string | undefined>, id: string): string {
  const resolved = ids.get(id);
  if (resolved === undefined) {
    throw new Error('Missing backup reference');
  }
  return resolved;
}
