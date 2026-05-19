import { describe, expect, it } from 'vitest';
import type { BotStatusEvent, BotStatusRecord } from '@kilocode/kilo-chat';

import { reduceBotStatusOnEvent } from './use-bot-status';

function event(overrides: Partial<BotStatusEvent>): BotStatusEvent {
  return {
    sandboxId: 'sb-1',
    online: true,
    at: 1000,
    capabilities: undefined,
    ...overrides,
  } as BotStatusEvent;
}

describe('reduceBotStatusOnEvent', () => {
  it('writes the event into an empty cache, preserving capabilities', () => {
    const next = reduceBotStatusOnEvent(
      undefined,
      event({ at: 1000, capabilities: ['attachments'] })
    );
    expect(next).toEqual({
      online: true,
      at: 1000,
      updatedAt: 1000,
      capabilities: ['attachments'],
    });
  });

  it('keeps the previous record when the event is older', () => {
    const prev: BotStatusRecord = {
      online: true,
      at: 2000,
      updatedAt: 2000,
      capabilities: ['attachments'],
    };
    const next = reduceBotStatusOnEvent(prev, event({ at: 1000, capabilities: undefined }));
    expect(next).toBe(prev);
  });

  it('updates online + at and preserves previous capabilities when the event omits them', () => {
    const prev: BotStatusRecord = {
      online: true,
      at: 1000,
      updatedAt: 1000,
      capabilities: ['attachments'],
    };
    const next = reduceBotStatusOnEvent(
      prev,
      event({ at: 2000, online: false, capabilities: undefined })
    );
    expect(next).toEqual({
      online: false,
      at: 2000,
      updatedAt: 2000,
      capabilities: ['attachments'],
    });
  });

  it('overwrites capabilities when the event includes a new list', () => {
    const prev: BotStatusRecord = {
      online: true,
      at: 1000,
      updatedAt: 1000,
      capabilities: ['attachments'],
    };
    const next = reduceBotStatusOnEvent(prev, event({ at: 2000, capabilities: [] }));
    expect(next).toEqual({
      online: true,
      at: 2000,
      updatedAt: 2000,
      capabilities: [],
    });
  });
});
