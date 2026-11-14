import { beforeEach, expect, it, vi } from 'vitest';

import { type File } from 'expo-file-system';

import {
  MAX_SSH_BACKUP_BYTES,
  openSshBackup,
  readSshBackupFile,
  shareSshBackup,
  sshBackupFailure,
} from './backup-file';
import { InvalidSshExportError, type SshBackup } from './backup-payload';

const state = vi.hoisted(() => ({
  encrypt: vi.fn<(json: string, passphrase: string) => Promise<string>>(),
  decrypt: vi.fn<(armored: string, passphrase: string) => Promise<string>>(),
  write: vi.fn(),
  delete: vi.fn(),
  share: vi.fn(),
  registerTempFile: vi.fn(),
}));
vi.mock('./native', () => ({
  sshPackage: () => Promise.resolve({ encryptExport: state.encrypt, decryptExport: state.decrypt }),
  nativeErrorCode: (error: { code?: string } | null) => error?.code ?? null,
}));
vi.mock('@/lib/share-remote-file', () => ({ shareLocalFile: state.share }));
vi.mock('@/lib/temp-file-registry', () => ({ registerTempFile: state.registerTempFile }));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri: string;
    exists = true;
    constructor(directory: string, filename: string) {
      this.uri = `${directory}/${filename}`;
    }
    write = state.write;
    delete = state.delete;
  },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }));

const backup: SshBackup = {
  format: 'kilo-ssh',
  version: 1,
  hosts: [],
  keys: [],
  knownHosts: [],
  snippets: [],
  forwards: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.encrypt.mockResolvedValue('age-armored-ciphertext');
  state.decrypt.mockResolvedValue(JSON.stringify(backup));
  state.share.mockResolvedValue(undefined);
});

it('encrypts the versioned JSON with the module and shares only armored ciphertext under the age filename', async () => {
  await shareSshBackup(backup, 'long-test-passphrase');
  expect(state.encrypt).toHaveBeenCalledWith(JSON.stringify(backup), 'long-test-passphrase');
  expect(state.write).toHaveBeenCalledWith('age-armored-ciphertext');
  expect(state.share).toHaveBeenCalledWith(
    expect.stringMatching(/kilo-ssh-\d{4}-\d{2}-\d{2}\.age$/),
    { mimeType: 'application/octet-stream' }
  );
  expect(state.registerTempFile).toHaveBeenCalledWith(
    expect.stringMatching(/kilo-ssh-\d{4}-\d{2}-\d{2}\.age$/)
  );
  expect(state.delete).not.toHaveBeenCalled();
});

it('removes the encrypted cache file when sharing fails', async () => {
  state.share.mockRejectedValueOnce(new Error('share unavailable'));
  await expect(shareSshBackup(backup, 'long-test-passphrase')).rejects.toThrow('share unavailable');
  expect(state.delete).toHaveBeenCalledOnce();
  expect(state.registerTempFile).not.toHaveBeenCalled();
});

it('decrypts with the module and validates its resulting JSON', async () => {
  await expect(openSshBackup('armored', 'passphrase')).resolves.toEqual(backup);
  expect(state.decrypt).toHaveBeenCalledWith('armored', 'passphrase');
  state.decrypt.mockResolvedValueOnce('{"version":99}');
  await expect(openSshBackup('armored', 'passphrase')).rejects.toThrow(InvalidSshExportError);
});

it('distinguishes retryable wrong passphrases from invalid exports without exposing native messages', () => {
  expect(sshBackupFailure({ code: 'WrongPassphrase', message: 'private details' })).toBe(
    'wrong_passphrase'
  );
  expect(sshBackupFailure({ code: 'InvalidExport' })).toBe('invalid_export');
  expect(sshBackupFailure(new InvalidSshExportError())).toBe('invalid_export');
  expect(sshBackupFailure(new Error('private details'))).toBe('unavailable');
});

it('rejects an oversized backup without reading its contents', async () => {
  const text = vi.fn<() => Promise<string>>();
  const open = vi.fn();
  const file = { size: MAX_SSH_BACKUP_BYTES + 1, text, open } as unknown as File;
  await expect(readSshBackupFile(file, MAX_SSH_BACKUP_BYTES + 1)).rejects.toThrow(
    `${MAX_SSH_BACKUP_BYTES}`
  );
  await expect(readSshBackupFile(file)).rejects.toThrow(`${MAX_SSH_BACKUP_BYTES}`);
  expect(text).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it('reads a backup at the size limit', async () => {
  const text = vi.fn<() => Promise<string>>().mockResolvedValue('age-armored');
  const file = { size: MAX_SSH_BACKUP_BYTES, text, open: vi.fn() } as unknown as File;
  await expect(readSshBackupFile(file)).resolves.toBe('age-armored');
  expect(text).toHaveBeenCalledOnce();
});

it('reads only the limit plus one byte when no size is known', async () => {
  const readBytes = vi
    .fn<(length: number) => Promise<Uint8Array>>()
    .mockResolvedValue(new Uint8Array([65]));
  const close = vi.fn();
  const text = vi.fn<() => Promise<string>>();
  const file = {
    size: 0,
    text,
    open: () => ({ readBytes, close }),
  } as unknown as File;
  await expect(readSshBackupFile(file, undefined)).resolves.toBe('A');
  expect(readBytes).toHaveBeenCalledWith(MAX_SSH_BACKUP_BYTES + 1);
  expect(close).toHaveBeenCalledOnce();
  expect(text).not.toHaveBeenCalled();
});
