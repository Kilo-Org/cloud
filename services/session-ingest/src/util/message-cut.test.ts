import { describe, expect, it } from 'vitest';

import { isItemWithinMessageCut } from './message-cut';

describe('isItemWithinMessageCut', () => {
  const cut = 'msg_0002';

  it('always keeps the session row', () => {
    expect(isItemWithinMessageCut({ itemType: 'session', itemId: 'session' }, cut)).toBe(true);
  });

  it('keeps messages up to and including the cut and drops later ones', () => {
    expect(isItemWithinMessageCut({ itemType: 'message', itemId: 'message/msg_0001' }, cut)).toBe(
      true
    );
    expect(isItemWithinMessageCut({ itemType: 'message', itemId: 'message/msg_0002' }, cut)).toBe(
      true
    );
    expect(isItemWithinMessageCut({ itemType: 'message', itemId: 'message/msg_0003' }, cut)).toBe(
      false
    );
  });

  it('keeps parts by the message ID in their item identity', () => {
    expect(isItemWithinMessageCut({ itemType: 'part', itemId: 'msg_0002/prt_0009' }, cut)).toBe(
      true
    );
    expect(isItemWithinMessageCut({ itemType: 'part', itemId: 'msg_0003/prt_0001' }, cut)).toBe(
      false
    );
  });

  it('always drops the session diff and other item types', () => {
    expect(isItemWithinMessageCut({ itemType: 'session_diff', itemId: 'session_diff' }, cut)).toBe(
      false
    );
    expect(isItemWithinMessageCut({ itemType: 'kilo_meta', itemId: 'kilo_meta' }, cut)).toBe(false);
  });
});
