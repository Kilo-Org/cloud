import { z } from 'zod';

import { type SshDatabase } from './database';
import { forwardInputSchema, listForwards } from './forwards';
import { hostInputSchema, listHosts } from './hosts';
import { keyInputSchema, listKeys } from './keys';
import { hostKeySchema, listKnownHosts } from './known-hosts';
import { listSnippets, snippetInputSchema } from './snippets';

const identity = { id: z.string().min(1) };
const created = { createdAt: z.number().finite() };
const updated = { ...created, updatedAt: z.number().finite() };

const backupSchema = z.strictObject({
  format: z.literal('kilo-ssh'),
  version: z.literal(1),
  hosts: z.array(hostInputSchema.extend({ ...identity, ...updated }).strict()),
  keys: z.array(keyInputSchema.extend({ ...identity, ...created }).strict()),
  knownHosts: z.array(hostKeySchema.extend({ ...identity, addedAt: z.number().finite() }).strict()),
  snippets: z.array(snippetInputSchema.extend({ ...identity, ...updated }).strict()),
  forwards: z.array(forwardInputSchema.extend(identity).strict()),
});

export type SshBackup = z.infer<typeof backupSchema>;
export type SshBackupCollection = 'hosts' | 'keys' | 'knownHosts' | 'snippets' | 'forwards';
export const BACKUP_COLLECTIONS = ['hosts', 'keys', 'knownHosts', 'snippets', 'forwards'] as const;

export class InvalidSshExportError extends Error {
  override readonly name = 'InvalidExport';
}

export function readSshBackup(db: SshDatabase): SshBackup {
  return {
    format: 'kilo-ssh',
    version: 1,
    hosts: listHosts(db),
    keys: listKeys(db),
    knownHosts: listKnownHosts(db),
    snippets: listSnippets(db),
    forwards: listForwards(db),
  };
}

export function parseSshBackup(json: string): SshBackup {
  try {
    const backup = backupSchema.parse(JSON.parse(json));
    const hosts = new Map(backup.hosts.map(host => [host.id, host]));
    const keys = new Set(backup.keys.map(key => key.id));
    for (const collection of BACKUP_COLLECTIONS) {
      const rows = backup[collection];
      if (new Set(rows.map(row => row.id)).size !== rows.length) {
        throw new InvalidSshExportError();
      }
    }
    for (const host of backup.hosts) {
      if (host.keyId !== null && !keys.has(host.keyId)) {
        throw new InvalidSshExportError();
      }
      if (host.authMethod === 'key' && host.keyId === null) {
        throw new InvalidSshExportError();
      }
      const seen = new Set([host.id]);
      let jump = host.jumpHostId;
      while (jump !== null) {
        const next = hosts.get(jump);
        if (seen.has(jump) || next === undefined) {
          throw new InvalidSshExportError();
        }
        seen.add(jump);
        jump = next.jumpHostId;
      }
    }
    for (const row of [...backup.snippets, ...backup.forwards]) {
      if (row.hostId !== null && !hosts.has(row.hostId)) {
        throw new InvalidSshExportError();
      }
    }
    return backup;
  } catch {
    throw new InvalidSshExportError();
  }
}
