import { z } from 'zod';

import { readRow, readRows, type SshDatabase, updateRow } from './database';
import { newId } from './id';

const COLUMNS = `
  id, host_pattern as hostPattern, key_algorithm as keyAlgorithm,
  public_key_base64 as publicKeyBase64, fingerprint_sha256 as fingerprintSha256,
  added_at as addedAt
`;

const knownHostRowSchema = z.object({
  id: z.string(),
  hostPattern: z.string(),
  keyAlgorithm: z.string(),
  publicKeyBase64: z.string(),
  fingerprintSha256: z.string(),
  addedAt: z.number(),
});

export type SshKnownHost = z.infer<typeof knownHostRowSchema>;

const hostKeySchema = z.object({
  hostPattern: z.string().min(1),
  keyAlgorithm: z.string().min(1),
  publicKeyBase64: z.string().min(1),
  fingerprintSha256: z.string().min(1),
});

export type TrustedHostKey = z.input<typeof hostKeySchema>;

const replacementSchema = hostKeySchema.pick({
  keyAlgorithm: true,
  publicKeyBase64: true,
  fingerprintSha256: true,
});

export type HostKeyReplacement = z.input<typeof replacementSchema>;

export function listKnownHosts(db: SshDatabase): SshKnownHost[] {
  return readRows({
    db,
    source: `select ${COLUMNS} from ssh_known_hosts order by host_pattern, key_algorithm`,
    schema: knownHostRowSchema,
  });
}

export function getKnownHost(db: SshDatabase, id: string): SshKnownHost | null {
  return readRow({
    db,
    source: `select ${COLUMNS} from ssh_known_hosts where id = ?`,
    params: [id],
    schema: knownHostRowSchema,
  });
}

export function findKnownHost(
  db: SshDatabase,
  hostPattern: string,
  keyAlgorithm: string
): SshKnownHost | null {
  return readRow({
    db,
    source: `select ${COLUMNS} from ssh_known_hosts where host_pattern = ? and key_algorithm = ?`,
    params: [hostPattern, keyAlgorithm],
    schema: knownHostRowSchema,
  });
}

export function trustHostKey(
  db: SshDatabase,
  input: TrustedHostKey,
  at: number = Date.now()
): SshKnownHost {
  const key = hostKeySchema.parse(input);
  const id = newId();
  db.runSync(
    `insert into ssh_known_hosts (id, host_pattern, key_algorithm, public_key_base64,
       fingerprint_sha256, added_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, key.hostPattern, key.keyAlgorithm, key.publicKeyBase64, key.fingerprintSha256, at]
  );
  const trusted = getKnownHost(db, id);
  if (!trusted) {
    throw new Error(`ssh_known_hosts: row ${id} is missing after its own insert`);
  }
  return trusted;
}

export function replaceHostKey(
  db: SshDatabase,
  id: string,
  replacement: HostKeyReplacement
): SshKnownHost | null {
  const key = replacementSchema.parse(replacement);
  updateRow({
    db,
    table: 'ssh_known_hosts',
    id,
    updates: {
      key_algorithm: key.keyAlgorithm,
      public_key_base64: key.publicKeyBase64,
      fingerprint_sha256: key.fingerprintSha256,
      added_at: Date.now(),
    },
  });
  return getKnownHost(db, id);
}

export function removeKnownHost(db: SshDatabase, id: string): void {
  db.runSync('delete from ssh_known_hosts where id = ?', [id]);
}
