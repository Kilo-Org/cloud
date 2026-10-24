import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { DispatchAttachments } from '@/lib/r2/cloud-agent-pending-uploads';

import { releaseUnadmittedSend } from './release-unadmitted-send';

const mockReleaseUnadmittedUploads = jest.fn(
  async (_kiloUserId: string, _attachments: DispatchAttachments) => 1
);

const messageId = 'msg_0123456789abABCDEFGHIJKLMN';
const attachments = { path: 'f7c1f9a0-0000-4000-8000-000000000001', files: ['a.bin'] };

const sessionId = 'workspace_00000000-0000-4000-8000-000000000002';

function admittedResult() {
  return { cloudAgentSessionId: sessionId, messageId, status: 'queued' as const };
}

function buildLookup(results: readonly (Error | null | 'admitted')[]) {
  let calls = 0;
  const getMessageResult = jest.fn(
    async (_input: { cloudAgentSessionId: string; messageId: string }) => {
      const result = results[Math.min(calls, results.length - 1)];
      calls += 1;
      if (result instanceof Error) throw result;
      return result === null ? null : admittedResult();
    }
  );
  return { getMessageResult };
}

const dependencies = { delay: async () => {}, release: mockReleaseUnadmittedUploads };

describe('releaseUnadmittedSend', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('returns the rows when both lookups report no such message', async () => {
    const client = buildLookup([null, null]);

    await releaseUnadmittedSend(
      {
        attachments,
        client,
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
        kiloUserId: 'user-1',
        messageId,
      },
      dependencies
    );

    expect(client.getMessageResult).toHaveBeenCalledTimes(2);
    expect(client.getMessageResult).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
      messageId,
    });
    expect(mockReleaseUnadmittedUploads).toHaveBeenCalledWith('user-1', attachments);
  });

  it('keeps the rows when the message exists at either lookup', async () => {
    const admittedFirst = buildLookup(['admitted']);
    await releaseUnadmittedSend(
      {
        attachments,
        client: admittedFirst,
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
        kiloUserId: 'user-1',
        messageId,
      },
      dependencies
    );
    expect(admittedFirst.getMessageResult).toHaveBeenCalledTimes(1);

    const admittedLater = buildLookup([null, 'admitted']);
    await releaseUnadmittedSend(
      {
        attachments,
        client: admittedLater,
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
        kiloUserId: 'user-1',
        messageId,
      },
      dependencies
    );
    expect(admittedLater.getMessageResult).toHaveBeenCalledTimes(2);
    expect(mockReleaseUnadmittedUploads).not.toHaveBeenCalled();
  });

  it('keeps the rows when a lookup fails', async () => {
    const unavailable = buildLookup([new Error('worker unavailable')]);

    await expect(
      releaseUnadmittedSend(
        {
          attachments,
          client: unavailable,
          cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
          kiloUserId: 'user-1',
          messageId,
        },
        dependencies
      )
    ).resolves.toBeUndefined();

    expect(jest.mocked(console.error)).toHaveBeenCalledWith(
      '[cloud-agent] Could not confirm a failed send was not admitted',
      expect.any(Error)
    );
    expect(mockReleaseUnadmittedUploads).not.toHaveBeenCalled();
  });

  it('keeps the rows when the second lookup is the one that fails', async () => {
    const secondFails = buildLookup([null, new Error('worker unavailable')]);

    await releaseUnadmittedSend(
      {
        attachments,
        client: secondFails,
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
        kiloUserId: 'user-1',
        messageId,
      },
      dependencies
    );

    expect(secondFails.getMessageResult).toHaveBeenCalledTimes(2);
    expect(mockReleaseUnadmittedUploads).not.toHaveBeenCalled();
  });

  it('stays silent when the ledger cannot return the rows', async () => {
    const client = buildLookup([null, null]);
    const release = jest.fn(async () => {
      throw new Error('database unavailable');
    });

    await expect(
      releaseUnadmittedSend(
        {
          attachments,
          client,
          cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
          kiloUserId: 'user-1',
          messageId,
        },
        { delay: async () => {}, release }
      )
    ).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(1);
    expect(jest.mocked(console.error)).toHaveBeenCalledWith(
      '[cloud-agent] Could not return the attachments of an unadmitted send',
      expect.any(Error)
    );
  });

  it('does nothing for a send without attachments', async () => {
    const client = buildLookup([null]);

    await releaseUnadmittedSend(
      {
        attachments: undefined,
        client,
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
        kiloUserId: 'user-1',
        messageId,
      },
      dependencies
    );

    expect(client.getMessageResult).not.toHaveBeenCalled();
    expect(mockReleaseUnadmittedUploads).not.toHaveBeenCalled();
  });
});
