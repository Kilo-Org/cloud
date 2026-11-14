import { File, Paths } from 'expo-file-system';

import { shareLocalFile } from '@/lib/share-remote-file';

import { InvalidSshExportError, parseSshBackup, type SshBackup } from './backup-payload';
import { nativeErrorCode, sshPackage } from './native';

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
  } finally {
    if (file.exists) {
      file.delete();
    }
  }
}

export async function openSshBackup(armored: string, passphrase: string): Promise<SshBackup> {
  const ssh = await sshPackage();
  return parseSshBackup(await ssh.decryptExport(armored, passphrase));
}
