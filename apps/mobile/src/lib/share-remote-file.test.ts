/* eslint-disable max-lines -- one suite: the transfer's streaming, deadline, and failure boundaries plus the share naming contract read against one fake disk */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadRemoteFile,
  getSafeCacheFilename,
  getShareFailureKind,
  shareLocalFile,
  shareMaterializedRemoteFile,
  shareRemoteFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';
import { utf8ByteLength } from '@/lib/utf8-utils';

type FileRecord = {
  uri: string;
  exists: boolean;
  bytes: number[];
  deleted: boolean;
};

const fileSystem = vi.hoisted(() => {
  const records = new Map<string, FileRecord>();
  const behavior = { writeError: null as Error | null, moveError: null as Error | null };

  function recordFor(uri: string): FileRecord {
    const existing = records.get(uri);
    if (existing !== undefined) {
      return existing;
    }
    const created: FileRecord = { uri, exists: false, bytes: [], deleted: false };
    records.set(uri, created);
    return created;
  }

  const Directory = vi.fn(function DirectoryMock(base: string, name: string) {
    return {
      uri: `${base}/${name}`,
      create: vi.fn(),
    };
  });

  const File = vi.fn(function FileMock(base: { uri: string } | string, name?: string) {
    const uri = typeof base === 'string' ? base : `${base.uri}/${name ?? ''}`;
    const record = recordFor(uri);
    return {
      uri,
      get exists() {
        return record.exists;
      },
      create: vi.fn(() => {
        record.exists = true;
        record.bytes = [];
        record.deleted = false;
      }),
      writableStream: () =>
        new WritableStream<Uint8Array>({
          write(chunk) {
            if (behavior.writeError !== null) {
              throw behavior.writeError;
            }
            for (const byte of chunk) {
              record.bytes.push(byte);
            }
          },
        }),
      move: (destination: { uri: string }) => {
        if (behavior.moveError !== null) {
          return Promise.reject(behavior.moveError);
        }
        const target = recordFor(destination.uri);
        target.exists = true;
        target.bytes = [...record.bytes];
        target.deleted = false;
        record.exists = false;
        record.bytes = [];
        return Promise.resolve();
      },
      delete: () => {
        record.exists = false;
        record.bytes = [];
        record.deleted = true;
      },
    };
  });

  return {
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    records,
    recordFor,
    behavior,
    reset() {
      records.clear();
      behavior.writeError = null;
      behavior.moveError = null;
    },
  };
});

const expoSharingMock = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const expoFetchMock = vi.hoisted(() => vi.fn());

const tempFileRegistryMock = vi.hoisted(() => ({
  registerTempFile: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: fileSystem.Directory,
  File: fileSystem.File,
  FileMode: { WriteOnly: 'w' },
  Paths: fileSystem.Paths,
}));

vi.mock('expo/fetch', () => ({ fetch: expoFetchMock }));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: expoSharingMock.isAvailableAsync,
  shareAsync: expoSharingMock.shareAsync,
}));

vi.mock('@/lib/temp-file-registry', () => ({
  registerTempFile: tempFileRegistryMock.registerTempFile,
}));

function okResponse(bytes: Uint8Array<ArrayBuffer>): {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array>;
} {
  return { ok: true, status: 200, body: new Blob([bytes]).stream() };
}

function downloadInput(cacheFilename = 'shared-a.pdf') {
  return {
    url: 'https://example.com/a.pdf',
    cacheDirectoryName: 'invoices',
    cacheFilename,
  };
}

/** The rejection a transfer ended with. A transfer that resolves fails the case. */
async function transferFailure(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected the transfer to fail');
}

function survivingAttempts(): FileRecord[] {
  return [...fileSystem.records.values()].filter(
    record => record.uri.includes('.part-') && record.exists
  );
}

function shareInput() {
  return {
    url: 'https://example.com/a.pdf',
    cacheDirectoryName: 'invoices',
    cacheKey: 'in_1',
    filename: 'a.pdf',
  };
}

/** Every file the module left on disk, whether or not it is an attempt copy. */
function survivingRecords(): FileRecord[] {
  return [...fileSystem.records.values()].filter(record => record.exists);
}

beforeEach(() => {
  vi.clearAllMocks();
  fileSystem.reset();
  expoSharingMock.isAvailableAsync.mockResolvedValue(true);
  expoSharingMock.shareAsync.mockResolvedValue(undefined);
});

describe('getSafeCacheFilename', () => {
  it('bounds cache filenames and preserves the extension', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const filename = `${'a'.repeat(508)}.pdf`;
    const cacheFilename = getSafeCacheFilename({ id, filename });

    expect(utf8ByteLength(cacheFilename)).toBeLessThanOrEqual(255);
    expect(cacheFilename.startsWith(`${id}-`)).toBe(true);
    expect(cacheFilename.endsWith('.pdf')).toBe(true);
  });

  it('sanitizes unsafe path characters', () => {
    expect(getSafeCacheFilename({ id: 'inv/1', filename: 'a b.pdf' })).toBe('inv_1-a_b.pdf');
  });
});

describe('shareLocalFile', () => {
  it('throws sharing-unavailable when the platform cannot share', async () => {
    expoSharingMock.isAvailableAsync.mockResolvedValue(false);

    await expect(shareLocalFile('file:///tmp/a.pdf')).rejects.toMatchObject({
      reason: 'sharing-unavailable',
    });
    expect(expoSharingMock.shareAsync).not.toHaveBeenCalled();
  });

  it('presents the native share sheet when sharing is available', async () => {
    await shareLocalFile('file:///tmp/a.pdf');
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith('file:///tmp/a.pdf', undefined);
  });

  it('passes mimeType to shareAsync when provided', async () => {
    await shareLocalFile('file:///tmp/a.pdf', { mimeType: 'application/pdf' });
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith('file:///tmp/a.pdf', {
      mimeType: 'application/pdf',
    });
  });

  it('does not pass mimeType when omitted', async () => {
    await shareLocalFile('file:///tmp/b.png');
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith('file:///tmp/b.png', undefined);
  });
});

describe('shareMaterializedRemoteFile', () => {
  it('keeps the temp file for the TTL reap after a successful share', async () => {
    const deleted: string[] = [];
    await shareMaterializedRemoteFile(
      {
        uri: 'file:///cache/org-invoices/a.pdf',
        delete: () => {
          deleted.push('file:///cache/org-invoices/a.pdf');
        },
      },
      async () => {
        await Promise.resolve();
      }
    );
    expect(deleted).toEqual([]);
    expect(tempFileRegistryMock.registerTempFile).toHaveBeenCalledWith(
      'file:///cache/org-invoices/a.pdf'
    );
  });

  it('deletes the temp file after share failures', async () => {
    const deleted: string[] = [];
    await expect(
      shareMaterializedRemoteFile(
        {
          uri: 'file:///cache/org-invoices/a.pdf',
          delete: () => {
            deleted.push('file:///cache/org-invoices/a.pdf');
          },
        },
        async () => {
          await Promise.resolve();
          throw new Error('share failed');
        }
      )
    ).rejects.toThrow('share failed');
    expect(deleted).toEqual(['file:///cache/org-invoices/a.pdf']);
    expect(tempFileRegistryMock.registerTempFile).not.toHaveBeenCalled();
  });
});

describe('downloadRemoteFile', () => {
  it('streams the body into the final file and returns a deletable copy', async () => {
    expoFetchMock.mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));

    const result = await downloadRemoteFile(downloadInput());

    expect(result.uri).toBe('file:///cache/invoices/shared-a.pdf');
    expect(fileSystem.recordFor('file:///cache/invoices/shared-a.pdf').bytes).toEqual([1, 2, 3]);
    // The attempt copy is gone once the bytes are moved onto the final name.
    expect(survivingAttempts()).toEqual([]);

    result.delete();
    expect(fileSystem.recordFor('file:///cache/invoices/shared-a.pdf').exists).toBe(false);
  });

  it('bounds the request with the deadline signal', async () => {
    expoFetchMock.mockResolvedValue(okResponse(new Uint8Array([1])));

    await downloadRemoteFile(downloadInput());

    const [, init] = expoFetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a non-2xx response as download-http-status carrying the status', async () => {
    expoFetchMock.mockResolvedValue({ ok: false, status: 404, body: null });

    const failure = await transferFailure(downloadRemoteFile(downloadInput()));

    expect(failure).toBeInstanceOf(ShareRemoteFileError);
    expect(failure).toMatchObject({ reason: 'download-http-status', httpStatus: 404 });
    // A status is a fact about the response, not a wrapped failure.
    expect((failure as ShareRemoteFileError).cause).toBeUndefined();
    expect(survivingRecords()).toEqual([]);
  });

  it('classifies a rejected fetch as download-network and keeps the cause', async () => {
    const networkError = new Error('network down');
    expoFetchMock.mockRejectedValue(networkError);

    const failure = await transferFailure(downloadRemoteFile(downloadInput()));

    expect(failure).toMatchObject({ reason: 'download-network' });
    expect((failure as ShareRemoteFileError).cause).toBe(networkError);
    expect(survivingRecords()).toEqual([]);
  });

  it('classifies a body-stream rejection as download-network', async () => {
    const streamError = new Error('socket reset');
    expoFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw streamError;
        },
      }),
    });

    const failure = await transferFailure(downloadRemoteFile(downloadInput()));

    expect(failure).toMatchObject({ reason: 'download-network' });
    expect((failure as ShareRemoteFileError).cause).toBe(streamError);
    expect(survivingRecords()).toEqual([]);
  });

  it('rejects a transfer that never settles as download-timeout and leaves no attempt file', async () => {
    expoFetchMock.mockReturnValue(new Promise<never>(() => undefined));

    const failure = await transferFailure(
      downloadRemoteFile({ ...downloadInput(), deadlineMs: 10 })
    );

    expect(failure).toMatchObject({ reason: 'download-timeout' });
    expect(survivingAttempts()).toEqual([]);
    expect(survivingRecords()).toEqual([]);
  });

  it('reads an expo cancel with no caller abort as download-timeout', async () => {
    const canceled = Object.assign(new Error('Fetch request has been canceled'), {
      name: 'FetchRequestCanceledException',
    });
    expoFetchMock.mockRejectedValue(canceled);

    const failure = await transferFailure(downloadRemoteFile(downloadInput()));

    expect(failure).toMatchObject({ reason: 'download-timeout' });
    expect((failure as ShareRemoteFileError).cause).toBe(canceled);
  });

  it('classifies a local write failure as download-failed with the write error as cause', async () => {
    expoFetchMock.mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));
    fileSystem.behavior.writeError = new Error('disk full');

    const failure = await transferFailure(downloadRemoteFile(downloadInput()));

    expect(failure).toMatchObject({ reason: 'download-failed' });
    expect(((failure as ShareRemoteFileError).cause as Error).message).toBe('disk full');
    expect(survivingRecords()).toEqual([]);
  });

  it('surfaces a failed move and leaves the destination holding its old bytes', async () => {
    const destination = fileSystem.recordFor('file:///cache/invoices/shared-a.pdf');
    destination.exists = true;
    destination.bytes = [9, 9, 9];
    expoFetchMock.mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));
    fileSystem.behavior.moveError = new Error('no space left on device');

    const failure = await transferFailure(downloadRemoteFile(downloadInput()));

    expect(failure).toBeInstanceOf(ShareRemoteFileError);
    // A move is local work, not the transport: the surface retries, but the
    // reason says the file could not be placed.
    expect(failure).toMatchObject({ reason: 'download-failed' });
    expect(destination.exists).toBe(true);
    expect(destination.bytes).toEqual([9, 9, 9]);
    // The half-placed attempt copy is dropped rather than left on disk.
    expect(survivingAttempts()).toEqual([]);
  });

  it('keeps an existing copy when the transfer fails', async () => {
    const existing = fileSystem.recordFor('file:///cache/invoices/shared-a.pdf');
    existing.exists = true;
    existing.bytes = [9, 9, 9];
    expoFetchMock.mockRejectedValue(new Error('network down'));

    await expect(downloadRemoteFile(downloadInput())).rejects.toBeInstanceOf(ShareRemoteFileError);

    expect(existing.exists).toBe(true);
    expect(existing.bytes).toEqual([9, 9, 9]);
  });

  it('propagates a caller abort unchanged and leaves no attempt file', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    controller.abort(reason);

    const failure = await transferFailure(
      downloadRemoteFile({
        ...downloadInput(),
        signal: controller.signal,
      })
    );

    expect(failure).toBe(reason);
    expect(expoFetchMock).not.toHaveBeenCalled();
    expect(survivingAttempts()).toEqual([]);
  });
});

describe('shareRemoteFile', () => {
  it('downloads then shares a remote file', async () => {
    expoFetchMock.mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));

    await shareRemoteFile(shareInput());

    expect(expoSharingMock.shareAsync).toHaveBeenCalledTimes(1);
    const [sharedUri] = expoSharingMock.shareAsync.mock.calls[0] as [string, unknown];
    expect(sharedUri.startsWith('file:///cache/invoices/in_1-a')).toBe(true);
    expect(sharedUri.endsWith('.pdf')).toBe(true);
    expect(tempFileRegistryMock.registerTempFile).toHaveBeenCalledWith(sharedUri);
  });

  it('gives two shares of one key distinct copies, and keeps both when a third fails', async () => {
    expoFetchMock.mockResolvedValueOnce(okResponse(new Uint8Array([1, 2, 3])));
    await shareRemoteFile(shareInput());
    const [firstUri] = expoSharingMock.shareAsync.mock.calls[0] as [string, unknown];

    expoFetchMock.mockResolvedValueOnce(okResponse(new Uint8Array([4, 5, 6])));
    await shareRemoteFile(shareInput());
    const [secondUri] = expoSharingMock.shareAsync.mock.calls[1] as [string, unknown];

    // A second share must not land on the file the first one already handed over.
    expect(secondUri).not.toBe(firstUri);
    expect(fileSystem.recordFor(firstUri).bytes).toEqual([1, 2, 3]);
    expect(fileSystem.recordFor(secondUri).bytes).toEqual([4, 5, 6]);

    expoFetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(shareRemoteFile(shareInput())).rejects.toBeInstanceOf(ShareRemoteFileError);

    expect(expoSharingMock.shareAsync).toHaveBeenCalledTimes(2);
    expect(fileSystem.recordFor(firstUri).bytes).toEqual([1, 2, 3]);
    expect(fileSystem.recordFor(secondUri).bytes).toEqual([4, 5, 6]);
    // The failed attempt leaves nothing of its own behind.
    expect(survivingAttempts()).toEqual([]);
  });

  it('deletes only its own copy when the share step fails after a successful share', async () => {
    expoFetchMock.mockResolvedValueOnce(okResponse(new Uint8Array([1, 2, 3])));
    await shareRemoteFile(shareInput());
    const [firstUri] = expoSharingMock.shareAsync.mock.calls[0] as [string, unknown];

    expoFetchMock.mockResolvedValueOnce(okResponse(new Uint8Array([4, 5, 6])));
    expoSharingMock.shareAsync.mockRejectedValueOnce(new Error('chooser died'));

    await expect(shareRemoteFile(shareInput())).rejects.toThrow('chooser died');

    // The copy the first share handed to a receiving app is untouched.
    expect(fileSystem.recordFor(firstUri).exists).toBe(true);
    expect(fileSystem.recordFor(firstUri).bytes).toEqual([1, 2, 3]);
    // Nothing of the failed attempt survives.
    expect(survivingAttempts()).toEqual([]);
    expect(survivingRecords().map(record => record.uri)).toEqual([firstUri]);
  });

  it('bounds the share filename and keeps the extension', async () => {
    expoFetchMock.mockResolvedValue(okResponse(new Uint8Array([1])));

    await shareRemoteFile({ ...shareInput(), filename: `${'a'.repeat(400)}.pdf` });

    const [sharedUri] = expoSharingMock.shareAsync.mock.calls[0] as [string, unknown];
    const name = sharedUri.slice('file:///cache/invoices/'.length);
    expect(utf8ByteLength(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('getShareFailureKind', () => {
  it('reports a device that cannot share at all', () => {
    expect(getShareFailureKind(new ShareRemoteFileError('sharing-unavailable'))).toBe(
      'sharing-unavailable'
    );
  });

  it('reports a definitive 4xx as file-unavailable', () => {
    for (const httpStatus of [400, 404, 405, 409, 410, 418, 451]) {
      expect(
        getShareFailureKind(new ShareRemoteFileError('download-http-status', { httpStatus }))
      ).toBe('file-unavailable');
    }
  });

  it('reports a re-signed or transient status as retry', () => {
    // 401/403 are a presigned link a later tap re-signs; 408/429/5xx are the
    // origin's own bad moment.
    for (const httpStatus of [401, 403, 408, 429, 500, 503, 504, 200, 302]) {
      expect(
        getShareFailureKind(new ShareRemoteFileError('download-http-status', { httpStatus }))
      ).toBe('retry');
    }
  });

  it('reports a status-carrying failure with no number as retry', () => {
    expect(getShareFailureKind(new ShareRemoteFileError('download-http-status'))).toBe('retry');
  });

  it('reports a transport, deadline, or local failure as retry', () => {
    for (const reason of ['download-timeout', 'download-network', 'download-failed'] as const) {
      expect(getShareFailureKind(new ShareRemoteFileError(reason))).toBe('retry');
    }
  });

  it('reports an untyped error as general', () => {
    expect(getShareFailureKind(new Error('boom'))).toBe('general');
  });
});
