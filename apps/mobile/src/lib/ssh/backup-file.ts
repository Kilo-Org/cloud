import { File, Paths } from 'expo-file-system';

import { shareLocalFile } from '@/lib/share-remote-file';
import { registerTempFile } from '@/lib/temp-file-registry';

import { InvalidSshExportError, parseSshBackup, type SshBackup } from './backup-payload';
import { nativeErrorCode, sshPackage } from './native';

// The core rejects a decrypted payload above 16 MiB; an armored age file is
// base64 of the ciphertext plus headers, so ceil(16 MiB * 4/3) + 64 KiB is the
// largest file that can still decrypt.
export const MAX_SSH_BACKUP_BYTES = Math.ceil((16 * 1024 * 1024 * 4) / 3) + 64 * 1024;

const utf8 = new TextDecoder();

export type SshBackupFailure =
  | 'wrong_passphrase'
  | 'invalid_export'
  | 'file'
  | 'storage'
  | 'unavailable';

export function sshBackupFailure(error: unknown): SshBackupFailure {
  if (nativeErrorCode(error) === 'WrongPassphrase') {
    return 'wrong_passphrase';
  }
  if (error instanceof InvalidSshExportError || nativeErrorCode(error) === 'InvalidExport') {
    return 'invalid_export';
  }
  return 'unavailable';
}

export async function shareSshBackup(backup: SshBackup, passphrase: string): Promise<void> {
  const ssh = await sshPackage();
  const armored = await ssh.encryptExport(JSON.stringify(backup), passphrase);
  const file = new File(Paths.cache, `kilo-ssh-${new Date().toISOString().slice(0, 10)}.age`);
  try {
    await file.write(armored);
    await shareLocalFile(file.uri, { mimeType: 'application/octet-stream' });
  } catch (error) {
    if (file.exists) {
      file.delete();
    }
    throw error;
  }
  registerTempFile(file.uri);
}

export async function openSshBackup(armored: string, passphrase: string): Promise<SshBackup> {
  const ssh = await sshPackage();
  return parseSshBackup(await ssh.decryptExport(armored, passphrase));
}

/**
 * Reads a picked backup file without loading more than [`MAX_SSH_BACKUP_BYTES`].
 *
 * `size` is the picker's asset size, which only short-circuits a reported
 * overflow: the file's own content decides, so an under-reported size cannot
 * put more than one byte past the limit in memory.
 */
export async function readSshBackupFile(file: File, size?: number): Promise<string> {
  if (size !== undefined && size > MAX_SSH_BACKUP_BYTES) {
    throw new Error(`the backup file is ${size} bytes; the limit is ${MAX_SSH_BACKUP_BYTES}`);
  }
  const handle = file.open();
  try {
    const head = await handle.readBytes(MAX_SSH_BACKUP_BYTES + 1);
    if (head.length > MAX_SSH_BACKUP_BYTES) {
      throw new Error(`the backup file exceeds the ${MAX_SSH_BACKUP_BYTES} byte limit`);
    }
    return utf8.decode(head);
  } finally {
    handle.close();
  }
}
