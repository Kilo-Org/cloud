import { describe, it, expect } from 'vitest';

import { trimIngestEvent } from './connection.js';

describe('trimIngestEvent', () => {
  it('trims top-level file parts before ingest serialization', () => {
    const rawDataUrl = 'data:image/png;base64,wrapper-private-image';
    const rawSourceText = 'wrapper private source text';

    const event = trimIngestEvent({
      streamEventType: 'kilocode',
      data: {
        event: 'message.part.updated',
        type: 'message.part.updated',
        part: {
          type: 'file',
          url: rawDataUrl,
          source: { text: { value: rawSourceText } },
        },
      },
      timestamp: '2026-04-14T08:00:00.000Z',
    });

    const payload = event.data as {
      part: { url: string; source: { text: { value: string } } };
    };

    expect(payload.part.url).toBe('');
    expect(payload.part.source.text.value).toBe('');
    expect(JSON.stringify(event)).not.toContain(rawDataUrl);
    expect(JSON.stringify(event)).not.toContain(rawSourceText);
  });
});
