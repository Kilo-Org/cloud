import { describe, expect, it } from 'vitest';

import {
  INGEST_CHUNK_MAX_BYTES,
  INGEST_CHUNK_MAX_ITEMS,
  MAX_SINGLE_ITEM_BYTES,
} from '../util/ingest-limits';
import { validateAndParseIngestPayload } from './validate';

const encoder = new TextEncoder();

function validate(value: unknown) {
  return validateAndParseIngestPayload(encoder.encode(JSON.stringify(value)));
}

describe('validateAndParseIngestPayload', () => {
  it('returns parsed valid items and their serialized data sizes', () => {
    const items = [
      { type: 'session', data: { title: 'Hello' } },
      { type: 'message', data: { id: 'msg_1', text: 'hi' } },
    ];

    expect(validate({ data: items })).toEqual({
      ok: true,
      items,
      dataArray: 'present',
      validItemCount: 2,
      skippedItemCount: 0,
      totalValidItemBytes:
        encoder.encode(JSON.stringify(items[0].data)).byteLength +
        encoder.encode(JSON.stringify(items[1].data)).byteLength,
      maxValidItemBytes: encoder.encode(JSON.stringify(items[1].data)).byteLength,
    });
  });

  it.each([
    [
      'valid prefix with malformed tail',
      '{"data":[{"type":"message","data":{"id":"msg_1"}},broken',
    ],
    ['truncated body', '{"data":[{"type":"message","data":{"id":"msg_1"}}'],
  ])('rejects %s', (_name, body) => {
    expect(validateAndParseIngestPayload(encoder.encode(body))).toEqual({
      ok: false,
      error: 'malformed_json',
    });
  });

  it.each(['', '   ', '{]', '[}', '{}{}', '{"data":[]} null'])(
    'rejects structurally invalid JSON %j',
    body => {
      expect(validateAndParseIngestPayload(encoder.encode(body))).toEqual({
        ok: false,
        error: 'malformed_json',
      });
    }
  );

  it.each([
    ['missing', {}, 'missing'],
    ['wrong-shaped', { data: {} }, 'wrong_type'],
    ['empty', { data: [] }, 'present'],
  ] as const)('distinguishes %s data arrays', (_name, payload, dataArray) => {
    expect(validate(payload)).toEqual({
      ok: true,
      items: [],
      dataArray,
      validItemCount: 0,
      skippedItemCount: 0,
      totalValidItemBytes: 0,
      maxValidItemBytes: 0,
    });
  });

  it('skips invalid items without charging count or byte budgets', () => {
    const validItem = { type: 'message', data: { id: 'msg_valid' } };
    const result = validate({
      data: [
        validItem,
        { type: 'message', data: {} },
        { type: 'unknown', data: { content: 'x'.repeat(1000) } },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      items: [validItem],
      validItemCount: 1,
      skippedItemCount: 2,
      totalValidItemBytes: encoder.encode(JSON.stringify(validItem.data)).byteLength,
    });
  });

  it('counts non-object data array entries as skipped', () => {
    expect(
      validate({
        data: [null, 42, 'invalid', true, [], { type: 'message', data: { id: 'msg_valid' } }],
      })
    ).toMatchObject({
      ok: true,
      validItemCount: 1,
      skippedItemCount: 5,
    });
  });

  it('counts only valid items when raw item count exceeds the RPC item budget', () => {
    const validItems = Array.from({ length: INGEST_CHUNK_MAX_ITEMS }, (_, index) => ({
      type: 'message',
      data: { id: `msg_${index}` },
    }));
    const result = validate({ data: [{ type: 'message', data: {} }, ...validItems] });

    expect(result).toMatchObject({
      ok: true,
      validItemCount: INGEST_CHUNK_MAX_ITEMS,
      skippedItemCount: 1,
    });
  });

  it('reports more than one RPC chunk worth of valid items', () => {
    const items = Array.from({ length: INGEST_CHUNK_MAX_ITEMS + 1 }, (_, index) => ({
      type: 'message',
      data: { id: `msg_${index}` },
    }));

    expect(validate({ data: items })).toMatchObject({
      ok: true,
      validItemCount: INGEST_CHUNK_MAX_ITEMS + 1,
      skippedItemCount: 0,
    });
  });

  it('reports an oversized valid item', () => {
    const data = { id: 'msg_large', content: 'x'.repeat(2 * 1024 * 1024) };
    const dataBytes = encoder.encode(JSON.stringify(data)).byteLength;

    expect(validate({ data: [{ type: 'message', data }] })).toMatchObject({
      ok: true,
      validItemCount: 1,
      totalValidItemBytes: dataBytes,
      maxValidItemBytes: dataBytes,
    });
  });

  it('reports parser-skipped oversized items as ineligible', () => {
    const result = validate({
      data: [
        { type: 'message', data: { id: 'msg_huge', content: 'x'.repeat(MAX_SINGLE_ITEM_BYTES) } },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      validItemCount: 0,
      skippedItemCount: 1,
      maxValidItemBytes: MAX_SINGLE_ITEM_BYTES + 1,
    });
  });

  it.each([
    ['at', INGEST_CHUNK_MAX_BYTES],
    ['over', INGEST_CHUNK_MAX_BYTES + 1],
  ])('reports valid-item totals %s the RPC byte budget', (_name, expectedBytes) => {
    const prefix = encoder.encode(JSON.stringify({ id: 'msg_boundary', content: '' })).byteLength;
    const data = { id: 'msg_boundary', content: 'x'.repeat(expectedBytes - prefix) };

    expect(validate({ data: [{ type: 'message', data }] })).toMatchObject({
      ok: true,
      validItemCount: 1,
      totalValidItemBytes: expectedBytes,
      maxValidItemBytes: expectedBytes,
    });
  });
});
