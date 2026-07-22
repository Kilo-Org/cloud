import { describe, expect, it } from 'vitest';

import { SessionItemSchema } from './session-sync';

describe('SessionItemSchema agent_notification validation', () => {
  it('parses a valid agent_notification item', () => {
    const result = SessionItemSchema.safeParse({
      type: 'agent_notification',
      data: { id: 'note_1', message: 'Build done' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'agent_notification',
      data: { id: 'note_1', message: 'Build done' },
    });
  });

  it('rejects an oversized message', () => {
    const result = SessionItemSchema.safeParse({
      type: 'agent_notification',
      data: { id: 'note_big', message: 'x'.repeat(501) },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note_empty', message: '' },
      }).success
    ).toBe(false);
  });

  it('rejects a whitespace-only message after trim', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note_ws', message: '   ' },
      }).success
    ).toBe(false);
  });

  it('rejects slash-bearing notification IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note/parent', message: 'Bad' },
      }).success
    ).toBe(false);
  });

  it('rejects NUL-bearing notification IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note\u0000bad', message: 'Bad' },
      }).success
    ).toBe(false);
  });

  it('rejects notification IDs longer than 64 characters', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'n'.repeat(65), message: 'Bad' },
      }).success
    ).toBe(false);
  });

  it('accepts notification IDs exactly 64 characters', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'n'.repeat(64), message: 'OK' },
      }).success
    ).toBe(true);
  });
});

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
