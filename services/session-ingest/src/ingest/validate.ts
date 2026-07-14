import { SessionItemSchema, type SessionDataItem } from '../types/session-sync';
import { MAX_SINGLE_ITEM_BYTES } from '../util/ingest-limits';
import { createItemExtractor } from './item-extractor';

type DataArrayState = 'present' | 'missing' | 'wrong_type';

export type IngestPayloadValidationResult =
  | {
      ok: true;
      items: SessionDataItem[];
      dataArray: DataArrayState;
      validItemCount: number;
      skippedItemCount: number;
      totalValidItemBytes: number;
      maxValidItemBytes: number;
    }
  | { ok: false; error: 'malformed_json' };

export function validateAndParseIngestPayload(bytes: Uint8Array): IngestPayloadValidationResult {
  const extractor = createItemExtractor('buffered-ingest-validation', {
    logErrors: false,
    logOversizedItems: false,
    validateStructure: true,
  });
  extractor.tokenizer.write(bytes);
  extractor.tokenizer.end();

  if (extractor.getParseError() || !extractor.isComplete()) {
    return { ok: false, error: 'malformed_json' };
  }

  const encoder = new TextEncoder();
  const items: SessionDataItem[] = [];
  let skippedItemCount = extractor.getSkippedItemCount();
  let totalValidItemBytes = 0;
  let maxValidItemBytes = 0;

  for (const rawItem of extractor.pending) {
    const parsed = SessionItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      skippedItemCount += 1;
      continue;
    }

    const itemBytes = encoder.encode(JSON.stringify(parsed.data.data)).byteLength;
    items.push(parsed.data);
    totalValidItemBytes += itemBytes;
    maxValidItemBytes = Math.max(maxValidItemBytes, itemBytes);
  }

  return {
    ok: true,
    items,
    dataArray: extractor.getDataArray(),
    validItemCount: items.length,
    skippedItemCount,
    totalValidItemBytes,
    maxValidItemBytes:
      extractor.getOversizedItemCount() > 0 ? MAX_SINGLE_ITEM_BYTES + 1 : maxValidItemBytes,
  };
}
