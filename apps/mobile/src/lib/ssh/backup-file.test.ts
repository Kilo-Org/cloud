import { beforeEach, expect, it, vi } from 'vitest';

import { openSshBackup, shareSshBackup, sshBackupFailure } from './backup-file';
import { InvalidSshExportError, type SshBackup } from './backup-payload';

const state = vi.hoisted(() => ({
  encrypt: vi.fn<(json: string, passphrase: string) => Promise<string>>(),
  decrypt: vi.fn<(armored: string, passphrase: string) => Promise<string>>(),
  write: vi.fn(),
  delete: vi.fn(),
  share: vi.fn(),
}));
vi.mock('./native', () => ({
  sshPackage: () => Promise.resolve({ encryptExport: state.encrypt, decryptExport: state.decrypt }),
  nativeErrorCode: (error: { code?: string } | null) => error?.code ?? null,
}));
vi.mock('@/lib/share-remote-file', () => ({ shareLocalFile: state.share }));
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
  expect(state.delete).toHaveBeenCalledOnce();
});

it('removes the encrypted cache file even when sharing fails', async () => {
  state.share.mockRejectedValueOnce(new Error('share unavailable'));
  await expect(shareSshBackup(backup, 'long-test-passphrase')).rejects.toThrow('share unavailable');
  expect(state.delete).toHaveBeenCalledOnce();
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
