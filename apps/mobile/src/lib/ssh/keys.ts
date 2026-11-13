import { z } from 'zod';

import { SSH_KEY_ALGORITHMS, SSH_KEY_SOURCES } from '@/lib/persist/schema';

import { readRow, readRows, type SshDatabase, updateRow } from './database';
import { newId } from './id';

const COLUMNS = `
  id, label, algorithm, source,
  private_key_openssh as privateKeyOpenssh,
  public_key_openssh as publicKeyOpenssh,
  fingerprint_sha256 as fingerprintSha256,
  passphrase, created_at as createdAt
`;

const keyRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  algorithm: z.enum(SSH_KEY_ALGORITHMS),
  source: z.enum(SSH_KEY_SOURCES),
  privateKeyOpenssh: z.string(),
  publicKeyOpenssh: z.string(),
  fingerprintSha256: z.string(),
  passphrase: z.string().nullable(),
  createdAt: z.number(),
});

export type SshKey = z.infer<typeof keyRowSchema>;

const keyFields = {
  label: z.string().min(1),
  algorithm: z.enum(SSH_KEY_ALGORITHMS),
  source: z.enum(SSH_KEY_SOURCES),
  privateKeyOpenssh: z.string().min(1),
  publicKeyOpenssh: z.string().min(1),
  fingerprintSha256: z.string().min(1),
};

const keyInputSchema = z.object({
  ...keyFields,
  passphrase: z.string().nullable().default(null),
});

export type SshKeyInput = z.input<typeof keyInputSchema>;

const keyPatchSchema = z
  .object({
    ...keyFields,
    passphrase: z.string().nullable(),
  })
  .partial();

export type SshKeyPatch = z.input<typeof keyPatchSchema>;

export function listKeys(db: SshDatabase): SshKey[] {
  return readRows({
    db,
    source: `select ${COLUMNS} from ssh_keys order by label`,
    schema: keyRowSchema,
  });
}

export function getKey(db: SshDatabase, id: string): SshKey | null {
  return readRow({
    db,
    source: `select ${COLUMNS} from ssh_keys where id = ?`,
    params: [id],
    schema: keyRowSchema,
  });
}

export function createKey(db: SshDatabase, input: SshKeyInput, at: number = Date.now()): SshKey {
  const key = keyInputSchema.parse(input);
  const id = newId();
  db.runSync(
    `insert into ssh_keys (id, label, algorithm, source, private_key_openssh,
       public_key_openssh, fingerprint_sha256, passphrase, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      key.label,
      key.algorithm,
      key.source,
      key.privateKeyOpenssh,
      key.publicKeyOpenssh,
      key.fingerprintSha256,
      key.passphrase,
      at,
    ]
  );
  const created = getKey(db, id);
  if (!created) {
    throw new Error(`ssh_keys: row ${id} is missing after its own insert`);
  }
  return created;
}

export function updateKey(db: SshDatabase, id: string, patch: SshKeyPatch): SshKey | null {
  const key = keyPatchSchema.parse(patch);
  updateRow({
    db,
    table: 'ssh_keys',
    id,
    updates: {
      label: key.label,
      algorithm: key.algorithm,
      source: key.source,
      private_key_openssh: key.privateKeyOpenssh,
      public_key_openssh: key.publicKeyOpenssh,
      fingerprint_sha256: key.fingerprintSha256,
      passphrase: key.passphrase,
    },
  });
  return getKey(db, id);
}

export function deleteKey(db: SshDatabase, id: string): void {
  db.runSync('delete from ssh_keys where id = ?', [id]);
}
