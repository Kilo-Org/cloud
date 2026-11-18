import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCClientError } from '@trpc/client';

import {
  CloudAgentBillingError,
  InsufficientCreditsError,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { releaseRefusedSend, workerRefusalStatus } from './release-refused-send';

const mockRelease = jest.fn(
  async (_kiloUserId: string, _messageUuid: string, _objectKeys: string[]) => 1
);

const attachments = { path: 'f7c1f9a0-0000-4000-8000-000000000001', files: ['a.bin'] };
const linkedObjectKeys = ['user-1/cloud-agent/f7c1f9a0-0000-4000-8000-000000000001/a.bin'];

const refusal = (httpStatus: number) =>
  new TRPCClientError(`worker answered ${String(httpStatus)}`, {
    result: { error: { code: -32600, message: 'refused', data: { httpStatus } } },
  });

const dependencies = { release: mockRelease };

describe('releaseRefusedSend', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('returns the rows this dispatch linked when the worker refused the turn', async () => {
    await releaseRefusedSend(
      { attachments, error: refusal(400), kiloUserId: 'user-1', linkedObjectKeys },
      dependencies
    );

    expect(mockRelease).toHaveBeenCalledWith(
      'user-1',
      'f7c1f9a0-0000-4000-8000-000000000001',
      linkedObjectKeys
    );
  });

  it('keeps the rows when the worker answered with a server-side status', async () => {
    await releaseRefusedSend(
      { attachments, error: refusal(503), kiloUserId: 'user-1', linkedObjectKeys },
      dependencies
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('keeps the rows when the send timed out', async () => {
    await releaseRefusedSend(
      { attachments, error: refusal(408), kiloUserId: 'user-1', linkedObjectKeys },
      dependencies
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('keeps the rows when the caller closed the request', async () => {
    await releaseRefusedSend(
      { attachments, error: refusal(499), kiloUserId: 'user-1', linkedObjectKeys },
      dependencies
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it.each([
    [400, true],
    [401, true],
    [402, true],
    [403, true],
    [404, true],
    [405, true],
    [408, false],
    [409, true],
    [412, true],
    [413, true],
    [415, true],
    [422, true],
    [429, true],
    [499, false],
    [501, false],
    [503, false],
    [418, false],
    [700, false],
  ] as const)(
    'returns the rows for status %s only when it proves the worker refused',
    async (status, releases) => {
      await releaseRefusedSend(
        { attachments, error: refusal(status), kiloUserId: 'user-1', linkedObjectKeys },
        dependencies
      );

      expect(mockRelease).toHaveBeenCalledTimes(releases ? 1 : 0);
    }
  );

  it('returns the rows when the client rewrote a credits refusal', async () => {
    await releaseRefusedSend(
      {
        attachments,
        error: new InsufficientCreditsError(),
        kiloUserId: 'user-1',
        linkedObjectKeys,
      },
      dependencies
    );

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns the rows for a billing refusal but keeps them for a billing outage', async () => {
    await releaseRefusedSend(
      {
        attachments,
        error: new CloudAgentBillingError({ kind: 'billing' } as never, 402),
        kiloUserId: 'user-1',
        linkedObjectKeys,
      },
      dependencies
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);

    await releaseRefusedSend(
      {
        attachments,
        error: new CloudAgentBillingError({ kind: 'billing' } as never, 503),
        kiloUserId: 'user-1',
        linkedObjectKeys,
      },
      dependencies
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns the rows for a status the client kept only on the cause', async () => {
    const normalized = new Error('Cloud agent returned a non-JSON error response', {
      cause: refusal(413),
    });

    await releaseRefusedSend(
      { attachments, error: normalized, kiloUserId: 'user-1', linkedObjectKeys },
      dependencies
    );

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows when the send failed without a worker answer', async () => {
    await releaseRefusedSend(
      {
        attachments,
        error: new TRPCClientError('fetch failed'),
        kiloUserId: 'user-1',
        linkedObjectKeys,
      },
      dependencies
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('keeps the rows when this dispatch linked none of them', async () => {
    await releaseRefusedSend(
      { attachments, error: refusal(400), kiloUserId: 'user-1', linkedObjectKeys: [] },
      dependencies
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('does nothing for a send without attachments', async () => {
    await releaseRefusedSend(
      { attachments: undefined, error: refusal(400), kiloUserId: 'user-1', linkedObjectKeys },
      dependencies
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('stays silent when the ledger cannot return the rows', async () => {
    const release = jest.fn(async () => {
      throw new Error('database unavailable');
    });

    await expect(
      releaseRefusedSend(
        { attachments, error: refusal(400), kiloUserId: 'user-1', linkedObjectKeys },
        { release }
      )
    ).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(1);
    expect(jest.mocked(console.error)).toHaveBeenCalledWith(
      '[cloud-agent] Could not return the attachments of a refused send',
      expect.any(Error)
    );
  });
});

describe('workerRefusalStatus', () => {
  it('reads the status the worker answered with, and nothing else', () => {
    expect(workerRefusalStatus(refusal(400))).toBe(400);
    expect(workerRefusalStatus(new InsufficientCreditsError())).toBe(402);
    expect(workerRefusalStatus(new CloudAgentBillingError({ kind: 'billing' } as never, 409))).toBe(
      409
    );
    expect(workerRefusalStatus(new Error('non-JSON', { cause: refusal(429) }))).toBe(429);
    expect(
      workerRefusalStatus(new Error('non-JSON', { cause: new TRPCClientError('fetch failed') }))
    ).toBeUndefined();
    expect(workerRefusalStatus(new TRPCClientError('fetch failed'))).toBeUndefined();
    expect(workerRefusalStatus(new Error('boom'))).toBeUndefined();
    expect(workerRefusalStatus(undefined)).toBeUndefined();
  });
});
