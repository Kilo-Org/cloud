import { beforeEach, describe, expect, it, vi } from 'vitest';

import { download, upload } from './src/sftp';

const native = vi.hoisted(() => ({
  downloadIds: [] as string[],
  uploadIds: [] as string[],
  sftpDownload: vi.fn(),
  sftpUpload: vi.fn(),
  cancelTransfer: vi.fn(),
  addListener: vi.fn(),
}));

vi.mock('expo', () => ({
  NativeModule: class {},
  requireNativeModule: () => native,
}));

function startedId(ids: string[]): string {
  const [id] = ids;
  if (!id) {
    throw new Error('the transfer never reached the native module');
  }
  return id;
}

beforeEach(() => {
  vi.resetAllMocks();
  native.downloadIds.length = 0;
  native.uploadIds.length = 0;
  native.sftpDownload.mockImplementation(
    (_sftpId: string, _remote: string, _local: string, transferId: string) => {
      native.downloadIds.push(transferId);
      return Promise.resolve(42);
    }
  );
  native.sftpUpload.mockImplementation(
    (_sftpId: string, _local: string, _remote: string, transferId: string) => {
      native.uploadIds.push(transferId);
      return Promise.resolve(7);
    }
  );
  native.addListener.mockReturnValue({ remove: vi.fn() });
});

describe('sftp transfers', () => {
  it('rejects an already-aborted signal without starting the transfer', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      download('sftp-1', '/remote/a.txt', 'file:///a.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'SshError', code: 'Cancelled' });
    await expect(
      upload('sftp-1', 'file:///a.txt', '/remote/a.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'SshError', code: 'Cancelled' });

    expect(native.downloadIds).toHaveLength(0);
    expect(native.uploadIds).toHaveLength(0);
    expect(native.cancelTransfer).not.toHaveBeenCalled();
  });

  it('rejects a signal aborted while the listener is attached, before the native call', async () => {
    let aborted = false;
    const listeners = new Set<() => void>();
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener: (_type: 'abort', listener: () => void) => {
        listeners.add(listener);
        aborted = true;
      },
      removeEventListener: (_type: 'abort', listener: () => void) => {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;

    await expect(
      download('sftp-1', '/remote/a.txt', 'file:///a.txt', { signal })
    ).rejects.toMatchObject({ code: 'Cancelled' });
    expect(native.downloadIds).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });

  it('resolves the byte count and drops the abort listener once the transfer settles', async () => {
    const controller = new AbortController();

    await expect(
      download('sftp-1', '/remote/a.txt', 'file:///a.txt', { signal: controller.signal })
    ).resolves.toBe(42);
    expect(startedId(native.downloadIds)).toMatch(/^transfer-\d+$/);

    controller.abort();
    expect(native.cancelTransfer).not.toHaveBeenCalled();
  });

  it('cancels the running transfer when the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<number>();
    native.sftpDownload.mockImplementation(
      (_sftpId: string, _remote: string, _local: string, transferId: string) => {
        native.downloadIds.push(transferId);
        return pending.promise;
      }
    );

    const transfer = download('sftp-1', '/remote/a.txt', 'file:///a.txt', {
      signal: controller.signal,
    });

    controller.abort();
    expect(native.cancelTransfer).toHaveBeenCalledWith(startedId(native.downloadIds));

    pending.resolve(0);
    await expect(transfer).resolves.toBe(0);
    expect(native.cancelTransfer).toHaveBeenCalledTimes(1);
  });

  it('delivers progress for its own transfer only and removes the listener', async () => {
    const onProgress = vi.fn();
    const listeners: ((event: {
      transferId: string;
      transferred: number;
      total: number | null;
    }) => void)[] = [];
    const remove = vi.fn();
    native.addListener.mockImplementation(
      (_event: string, listener: (typeof listeners)[number]) => {
        listeners.push(listener);
        return { remove };
      }
    );

    await upload('sftp-1', 'file:///a.txt', '/remote/a.txt', { onProgress });
    const transferId = startedId(native.uploadIds);

    const [emit] = listeners;
    if (!emit) {
      throw new Error('the progress listener was never attached');
    }
    emit({ transferId: 'transfer-other', transferred: 1, total: 2 });
    emit({ transferId, transferred: 3, total: 4 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ transferred: 3, total: 4 });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
