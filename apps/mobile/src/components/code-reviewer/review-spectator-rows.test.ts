import { describe, expect, it } from 'vitest';
import { type TFunction } from 'i18next';
import { type CloudAgentEvent } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import { appendSpectatorRows, type SpectatorRow, toSpectatorRow } from './review-spectator-rows';

const row = (message: string, key?: string): SpectatorRow => ({
  timestamp: 't',
  message,
  eventType: 'info',
  ...(key === undefined ? {} : { key }),
});

const t = i18n.t as TFunction;

function kilocodeEvent(properties: Record<string, unknown>): CloudAgentEvent {
  return {
    eventId: 1,
    executionId: 'exec-1',
    sessionId: 'ses-1',
    streamEventType: 'kilocode',
    timestamp: '2026-09-05T12:00:00.000Z',
    data: { type: 'message.part.updated', properties },
  };
}

describe('appendSpectatorRows', () => {
  it('replaces a keyed row and appends unkeyed rows', () => {
    const rows = appendSpectatorRows(
      [row('a', 'k1'), row('b')],
      [row('a2', 'k1'), row('c'), row('d', 'k2'), row('d2', 'k2')]
    );
    expect(rows.map(r => r.message)).toEqual(['a2', 'b', 'c', 'd2']);
  });

  it('keeps every unkeyed row in a batch', () => {
    const rows = appendSpectatorRows([], [row('connected'), row('snapshot'), row('queued')]);
    expect(rows).toHaveLength(3);
  });
});

describe('toSpectatorRow text parts', () => {
  it('renders a canonical live text part that carries no state', () => {
    // The cloud-agent stream emits text parts as { id, messageID, type, text,
    // time } with no `state` field while the review runs. Gating these on a
    // completed state drops every assistant row from the live transcript.
    const result = toSpectatorRow(
      kilocodeEvent({
        part: {
          id: 'prt_text',
          sessionID: 'ses-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Looking at the diff now.',
          time: { start: 1_787_054_400_000 },
        },
      }),
      t
    );
    expect(result).toEqual({
      timestamp: '2026-09-05T12:00:00.000Z',
      message: 'Looking at the diff now.',
      eventType: 'text',
      key: 'prt_text',
    });
  });

  it('renders a completed canonical text part (time.start + time.end, no state)', () => {
    const result = toSpectatorRow(
      kilocodeEvent({
        part: {
          id: 'prt_text',
          sessionID: 'ses-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Review summary',
          time: { start: 1_787_054_400_000, end: 1_787_054_401_000 },
        },
      }),
      t
    );
    expect(result).not.toBeNull();
    expect(result?.message).toBe('Review summary');
  });

  it.each(['', '   '])('skips an empty text part: %j', text => {
    const result = toSpectatorRow(
      kilocodeEvent({ part: { id: 'prt_text', type: 'text', text } }),
      t
    );
    expect(result).toBeNull();
  });

  it('updates a streamed text part in place via its part id', () => {
    const partial = toSpectatorRow(
      kilocodeEvent({ part: { id: 'prt_text', type: 'text', text: 'Looking at' } }),
      t
    );
    const updated = toSpectatorRow(
      kilocodeEvent({ part: { id: 'prt_text', type: 'text', text: 'Looking at the diff now.' } }),
      t
    );
    expect(partial).not.toBeNull();
    expect(updated).not.toBeNull();
    if (!partial || !updated) {
      return;
    }
    expect(appendSpectatorRows([partial], [updated])).toEqual([updated]);
  });

  it('still renders a text part that carries a legacy completed state', () => {
    const result = toSpectatorRow(
      kilocodeEvent({
        part: { id: 'prt_text', type: 'text', text: 'Done reading.', state: 'completed' },
      }),
      t
    );
    expect(result?.message).toBe('Done reading.');
  });
});
