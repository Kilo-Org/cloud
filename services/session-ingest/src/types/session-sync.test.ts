import { describe, expect, it } from 'vitest';

import { SessionItemSchema } from './session-sync';

describe('SessionItemSchema storage key identity', () => {
  it('rejects slash-bearing message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({ type: 'message', data: { id: 'msg_parent/child' } }).success
    ).toBe(false);
  });

  it('rejects slash-bearing part message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_child', messageID: 'msg_parent/child' },
      }).success
    ).toBe(false);
  });

  it('rejects slash-bearing part IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_parent/child', messageID: 'msg_parent' },
      }).success
    ).toBe(false);
  });

  it('rejects NUL-bearing message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({ type: 'message', data: { id: 'msg_parent\u0000child' } })
        .success
    ).toBe(false);
  });

  it('rejects NUL-bearing part message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_child', messageID: 'msg_parent\u0000child' },
      }).success
    ).toBe(false);
  });

  it('rejects NUL-bearing part IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_parent\u0000child', messageID: 'msg_parent' },
      }).success
    ).toBe(false);
  });
});
