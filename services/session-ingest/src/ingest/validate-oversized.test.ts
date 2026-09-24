import { describe, expect, it, vi } from 'vitest';

// Production MAX_SINGLE_ITEM_BYTES is 50MiB. Tokenizing a JSON string that
// large exceeds vitest's 5s default timeout even in isolation, which is what
// failed the backend gate. Mirror queue-consumer.test.ts: shrink the skip
// threshold so the extractor path is exercised without a 50MiB payload.
vi.mock('../util/ingest-limits', () => ({
  INGEST_CHUNK_MAX_BYTES: 4 * 1024 * 1024,
  INGEST_CHUNK_MAX_ITEMS: 128,
  MAX_INGEST_ITEM_BYTES: 100,
  MAX_SINGLE_ITEM_BYTES: 500,
}));

import { MAX_SINGLE_ITEM_BYTES } from '../util/ingest-limits';
import { validateAndParseIngestPayload } from './validate';

const encoder = new TextEncoder();

describe('validateAndParseIngestPayload oversized items', () => {
  it('reports parser-skipped oversized items as ineligible', () => {
    const result = validateAndParseIngestPayload(
      encoder.encode(
        JSON.stringify({
          data: [
            {
              type: 'message',
              data: { id: 'msg_huge', content: 'x'.repeat(MAX_SINGLE_ITEM_BYTES) },
            },
          ],
        })
      )
    );

    expect(result).toMatchObject({
      ok: true,
      validItemCount: 0,
      skippedItemCount: 1,
      maxValidItemBytes: MAX_SINGLE_ITEM_BYTES + 1,
    });
  });
});
