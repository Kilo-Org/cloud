import { describe, expect, it, vi } from 'vitest';
import type * as IngestLimits from '../util/ingest-limits';

vi.mock('../util/ingest-limits', async importOriginal => {
  const actual = await importOriginal<typeof IngestLimits>();
  return { ...actual, MAX_SINGLE_ITEM_BYTES: 64 };
});

import { MAX_SINGLE_ITEM_BYTES } from '../util/ingest-limits';
import { validateAndParseIngestPayload } from './validate';

const encoder = new TextEncoder();

describe('validateAndParseIngestPayload oversized items', () => {
  it('reports parser-skipped oversized items as ineligible', () => {
    // Mock the 50MiB production cap down to 64 bytes so this proves the skip
    // path without tokenizing a payload that exceeds the default 5s timeout.
    const prefix = '{"data":[{"type":"message","data":{"id":"msg_huge","content":"';
    const suffix = '"}}]}';
    const prefixBytes = encoder.encode(prefix);
    const suffixBytes = encoder.encode(suffix);
    const bytes = new Uint8Array(prefixBytes.length + MAX_SINGLE_ITEM_BYTES + suffixBytes.length);
    bytes.set(prefixBytes, 0);
    bytes.fill(0x78, prefixBytes.length, prefixBytes.length + MAX_SINGLE_ITEM_BYTES);
    bytes.set(suffixBytes, prefixBytes.length + MAX_SINGLE_ITEM_BYTES);

    expect(validateAndParseIngestPayload(bytes)).toMatchObject({
      ok: true,
      validItemCount: 0,
      skippedItemCount: 1,
      maxValidItemBytes: MAX_SINGLE_ITEM_BYTES + 1,
    });
  });
});
