import { afterEach, expect, it, vi } from 'vitest';
import { clearFinishedTransfers, retryTransfer, startUpload, transfersSnapshot } from './transfers';
const ssh = vi.hoisted(() => ({
  upload: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../native', () => ({
  sshPackage: () => Promise.resolve(ssh),
  nativeErrorCode: () => 'Protocol',
}));
vi.mock('expo-file-system', () => ({ Directory: vi.fn(), File: vi.fn(), Paths: {} }));
vi.mock('@/lib/share-remote-file', () => ({ getSafeCacheFilename: () => 'file' }));
afterEach(() => {
  clearFinishedTransfers();
  vi.clearAllMocks();
});
it('replays a failed transfer after its active job has ended', async () => {
  ssh.upload.mockRejectedValueOnce(new Error('offline'));
  const id = startUpload({
    sessionId: 'session',
    sftpId: 'channel',
    localUri: 'file://upload',
    remotePath: '/file',
    name: 'file',
  });
  await vi.waitFor(() => {
    expect(transfersSnapshot().find(row => row.id === id)?.status).toBe('failed');
  });
  retryTransfer(id, 'reconnected');
  await vi.waitFor(() => {
    expect(transfersSnapshot().find(row => row.id === id)?.status).toBe('done');
  });
  expect(ssh.upload).toHaveBeenCalledTimes(2);
  expect(ssh.upload.mock.calls[1]?.slice(0, 3)).toEqual(['reconnected', 'file://upload', '/file']);
  clearFinishedTransfers();
  retryTransfer(id);
  expect(ssh.upload).toHaveBeenCalledTimes(2);
});
