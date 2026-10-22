import { describe, expect, it } from 'vitest';

import {
  readWrapperLogsWithinBudget,
  WRAPPER_LOG_LIMITS,
  type WrapperLogCandidate,
  type WrapperLogReadRequest,
} from './wrapper-log-budget.js';

const KIB = 1024;

function candidate(path: string, size: number, ageMinutes: number): WrapperLogCandidate {
  return { path, size, modifiedAtMs: 1_000_000 - ageMinutes * 60_000 };
}

/** Content that names the request it answered, so ordering is observable. */
async function recordReads(
  requests: WrapperLogReadRequest[],
  options?: { fail?: (request: WrapperLogReadRequest) => boolean }
) {
  return async (request: WrapperLogReadRequest): Promise<string | undefined> => {
    requests.push(request);
    if (options?.fail?.(request)) return undefined;
    return `<${request.path}:${request.bytesToRead}>`;
  };
}

describe('readWrapperLogsWithinBudget', () => {
  it('returns a small log set whole, newest first, with empty metadata', async () => {
    const requests: WrapperLogReadRequest[] = [];
    const readout = await readWrapperLogsWithinBudget({
      candidates: [
        candidate('/tmp/kilocode-wrapper-a-old.log', 2 * KIB, 30),
        candidate('/tmp/kilocode-wrapper-a-new.log', 5 * KIB, 1),
        candidate('/home/agent/.local/share/kilo/log/cli.log', 1 * KIB, 10),
      ],
      read: await recordReads(requests),
    });

    expect(Object.keys(readout.files)).toEqual([
      '/tmp/kilocode-wrapper-a-new.log',
      '/home/agent/.local/share/kilo/log/cli.log',
      '/tmp/kilocode-wrapper-a-old.log',
    ]);
    expect(requests.map(request => request.bytesToRead)).toEqual([5 * KIB, 1 * KIB, 2 * KIB]);
    expect(readout.truncated).toEqual({});
    expect(readout.skipped).toEqual({});
    expect(readout.omittedFileCount).toBe(0);
  });

  it('requests only the newest bytes of a file above the per-file cap', async () => {
    const requests: WrapperLogReadRequest[] = [];
    const oversized = WRAPPER_LOG_LIMITS.maxFileBytes * 4;
    const readout = await readWrapperLogsWithinBudget({
      candidates: [candidate('/tmp/kilocode-wrapper-a-1.log', oversized, 1)],
      read: await recordReads(requests),
    });

    expect(requests).toEqual([
      {
        path: '/tmp/kilocode-wrapper-a-1.log',
        bytesToRead: WRAPPER_LOG_LIMITS.maxFileBytes,
        sizeBytes: oversized,
      },
    ]);
    expect(readout.truncated).toEqual({
      '/tmp/kilocode-wrapper-a-1.log': {
        returnedBytes: WRAPPER_LOG_LIMITS.maxFileBytes,
        omittedBytes: oversized - WRAPPER_LOG_LIMITS.maxFileBytes,
      },
    });
  });

  it('reads at most maxFiles files and names the rest as file-limit', async () => {
    const requests: WrapperLogReadRequest[] = [];
    const candidates = Array.from({ length: WRAPPER_LOG_LIMITS.maxFiles + 5 }, (_, index) =>
      candidate(`/tmp/kilocode-wrapper-a-${index}.log`, 100, index)
    );

    const readout = await readWrapperLogsWithinBudget({
      candidates,
      read: await recordReads(requests),
    });

    expect(requests).toHaveLength(WRAPPER_LOG_LIMITS.maxFiles);
    expect(Object.keys(readout.files)).toHaveLength(WRAPPER_LOG_LIMITS.maxFiles);
    expect(Object.values(readout.skipped)).toEqual(Array.from({ length: 5 }, () => 'file-limit'));
    expect(readout.omittedFileCount).toBe(0);
  });

  it('stops at the total byte budget and names the remainder as byte-limit', async () => {
    const requests: WrapperLogReadRequest[] = [];
    const half = WRAPPER_LOG_LIMITS.maxTotalBytes / 2;
    const candidates = [
      candidate('/tmp/kilocode-wrapper-a-0.log', half, 1),
      candidate('/tmp/kilocode-wrapper-a-1.log', half, 2),
      candidate('/tmp/kilocode-wrapper-a-2.log', half, 3),
    ];

    const readout = await readWrapperLogsWithinBudget({
      candidates,
      read: await recordReads(requests),
    });

    expect(requests.map(request => request.bytesToRead)).toEqual([half, half]);
    expect(readout.skipped).toEqual({ '/tmp/kilocode-wrapper-a-2.log': 'byte-limit' });
    expect(readout.truncated).toEqual({});
  });

  it('counts candidates beyond the selection window without reading them', async () => {
    const requests: WrapperLogReadRequest[] = [];
    const candidates = Array.from({ length: WRAPPER_LOG_LIMITS.maxCandidates + 7 }, (_, index) =>
      candidate(`/tmp/kilocode-wrapper-a-${index}.log`, 10, index)
    );

    const readout = await readWrapperLogsWithinBudget({
      candidates,
      read: await recordReads(requests),
    });

    expect(readout.omittedFileCount).toBe(7);
    expect(requests).toHaveLength(WRAPPER_LOG_LIMITS.maxFiles);
  });

  it('keeps going after a failed read and leaves the byte budget unspent', async () => {
    const requests: WrapperLogReadRequest[] = [];
    const readout = await readWrapperLogsWithinBudget({
      candidates: [
        candidate('/tmp/kilocode-wrapper-a-0.log', KIB, 1),
        candidate('/tmp/kilocode-wrapper-a-1.log', KIB, 2),
      ],
      read: await recordReads(requests, {
        fail: request => request.path === '/tmp/kilocode-wrapper-a-0.log',
      }),
    });

    expect(requests).toHaveLength(2);
    expect(readout.files).toEqual({
      '/tmp/kilocode-wrapper-a-1.log': '</tmp/kilocode-wrapper-a-1.log:1024>',
    });
    expect(readout.skipped).toEqual({ '/tmp/kilocode-wrapper-a-0.log': 'read-failed' });
  });

  it('returns an empty file as empty content', async () => {
    const readout = await readWrapperLogsWithinBudget({
      candidates: [candidate('/tmp/kilocode-wrapper-a-0.log', 0, 1)],
      read: async () => '',
    });

    expect(readout.files).toEqual({ '/tmp/kilocode-wrapper-a-0.log': '' });
    expect(readout.truncated).toEqual({});
  });
});
