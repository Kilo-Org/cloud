import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers before any imports that might pull in DO code
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

// Mock ingest-limits so we can use a small MAX_SINGLE_ITEM_BYTES in oversize tests
vi.mock('./util/ingest-limits', () => ({
  MAX_INGEST_ITEM_BYTES: 2 * 1024 * 1024,
  MAX_SINGLE_ITEM_BYTES: 50,
}));

import { createItemExtractor } from './queue-consumer';

const encoder = new TextEncoder();

function feedAll(extractor: ReturnType<typeof createItemExtractor>, json: string) {
  extractor.tokenizer.write(encoder.encode(json));
  extractor.tokenizer.end();
}

describe('createItemExtractor', () => {
  it('parses items from valid { data: [...] } payload', () => {
    const ext = createItemExtractor('test-key');
    const payload = JSON.stringify({
      data: [
        { type: 'session', data: { title: 'Hello' } },
        { type: 'message', data: { id: 'msg_1' } },
      ],
    });

    feedAll(ext, payload);

    expect(ext.pending).toHaveLength(2);
    expect(ext.pending[0]).toEqual({ type: 'session', data: { title: 'Hello' } });
    expect(ext.pending[1]).toEqual({ type: 'message', data: { id: 'msg_1' } });
    expect(ext.getParseError()).toBeNull();
  });

  it('handles empty data array', () => {
    const ext = createItemExtractor('test-key');
    feedAll(ext, JSON.stringify({ data: [] }));

    expect(ext.pending).toHaveLength(0);
    expect(ext.getParseError()).toBeNull();
  });

  it('skips oversized items (byte budget)', () => {
    // MAX_SINGLE_ITEM_BYTES is mocked to 50
    const ext = createItemExtractor('test-key');

    // Create an item that exceeds 50 bytes
    const bigValue = 'x'.repeat(60);
    const payload = JSON.stringify({
      data: [
        { type: 'big', data: { content: bigValue } },
        { type: 'small', data: { ok: true } },
      ],
    });

    feedAll(ext, payload);

    // The oversized item should be skipped, but the small one should parse
    expect(ext.pending).toHaveLength(1);
    expect(ext.pending[0]).toEqual({ type: 'small', data: { ok: true } });
  });

  it('clears skippingItem when oversize item ends on closing brace', () => {
    // MAX_SINGLE_ITEM_BYTES is mocked to 50
    const ext = createItemExtractor('test-key');

    // A flat object (no nested braces) that exceeds budget — the closing }
    // is the token that triggers the budget check AND ends the item at depth=2
    const bigValue = 'y'.repeat(60);
    const payload = JSON.stringify({
      data: [{ big: bigValue }, { type: 'after', ok: true }],
    });

    feedAll(ext, payload);

    // The first item is oversized and skipped; the second should parse fine
    expect(ext.pending).toHaveLength(1);
    expect(ext.pending[0]).toEqual({ type: 'after', ok: true });
  });

  it('sets parseError on malformed JSON', () => {
    const ext = createItemExtractor('test-key');

    // Feed invalid JSON
    ext.tokenizer.write(encoder.encode('{ data: ['));
    ext.tokenizer.end();

    expect(ext.getParseError()).toBeInstanceOf(Error);
  });

  it('ignores non-data top-level keys', () => {
    const ext = createItemExtractor('test-key');
    const payload = JSON.stringify({
      meta: { version: 1 },
      other: [{ type: 'ignored' }],
      data: [{ type: 'included', data: {} }],
    });

    feedAll(ext, payload);

    expect(ext.pending).toHaveLength(1);
    expect(ext.pending[0]).toEqual({ type: 'included', data: {} });
  });
});
