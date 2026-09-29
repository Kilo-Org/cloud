import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';

import { retryFailedMessage } from './retry-failed-message';

const owner = 'ses-owner' as KiloSessionId;
const other = 'ses-other' as KiloSessionId;

function fakeRecovery() {
  const calls: string[] = [];
  return {
    calls,
    markMessageSuperseded: (messageId: string, ownerSessionId: KiloSessionId) => {
      calls.push(`mark:${messageId}:${ownerSessionId}`);
    },
    unmarkMessageSuperseded: (messageId: string, ownerSessionId: KiloSessionId) => {
      calls.push(`unmark:${messageId}:${ownerSessionId}`);
    },
    clearFailedMessage: (messageId: string, ownerSessionId?: KiloSessionId) => {
      calls.push(`clear:${messageId}:${ownerSessionId ?? 'active'}`);
    },
  };
}

describe('retryFailedMessage', () => {
  it('supersedes in the same tap and clears the failure once the re-send is accepted', async () => {
    const recovery = fakeRecovery();
    const order: string[] = [];

    const accepted = await retryFailedMessage({
      messageId: 'msg-1',
      ownerSessionId: owner,
      recovery,
      send: async onOptimisticSend => {
        onOptimisticSend();
        order.push(...recovery.calls);
        return true;
      },
    });

    expect(accepted).toBe(true);
    expect(order).toEqual([`mark:msg-1:${owner}`]);
    expect(recovery.calls).toEqual([`mark:msg-1:${owner}`, `clear:msg-1:${owner}`]);
  });

  it('restores the failed row when the re-send is refused', async () => {
    const recovery = fakeRecovery();

    const accepted = await retryFailedMessage({
      messageId: 'msg-2',
      ownerSessionId: owner,
      recovery,
      send: async onOptimisticSend => {
        onOptimisticSend();
        return false;
      },
    });

    expect(accepted).toBe(false);
    expect(recovery.calls).toEqual([`mark:msg-2:${owner}`, `unmark:msg-2:${owner}`]);
  });

  it('restores the failed row and rethrows when the re-send throws', async () => {
    const recovery = fakeRecovery();

    await expect(
      retryFailedMessage({
        messageId: 'msg-3',
        ownerSessionId: owner,
        recovery,
        send: async onOptimisticSend => {
          onOptimisticSend();
          throw new Error('transport down');
        },
      })
    ).rejects.toThrow('transport down');

    expect(recovery.calls).toEqual([`mark:msg-3:${owner}`, `unmark:msg-3:${owner}`]);
  });

  it('records the resolution against the owning session, not the active one', async () => {
    const recovery = fakeRecovery();

    await retryFailedMessage({
      messageId: 'msg-4',
      ownerSessionId: other,
      recovery,
      send: async () => true,
    });

    // Nothing was ever superseded, so a plain accepted re-send still resolves.
    expect(recovery.calls).toEqual([`clear:msg-4:${other}`]);
  });
});
