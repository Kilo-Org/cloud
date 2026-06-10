import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

import {
  KILO_SDK_HISTORY_CANDIDATE_OVERHEAD_BYTES,
  createKiloSdkHistoryReadBudget,
  readKiloSdkHistoryCandidate,
  readKiloSdkHistoryItem,
  readKiloSdkSessionItem,
} from './kilo-sdk-materialization';

function r2Body(value: Record<string, unknown>) {
  const data = JSON.stringify(value);
  return {
    size: new TextEncoder().encode(data).byteLength,
    text: vi.fn(async () => data),
    body: new ReadableStream<Uint8Array>(),
  };
}

describe('Kilo SDK session snapshot materialization', () => {
  it('returns invalid_data for malformed snapshots instead of throwing parse errors', async () => {
    await expect(
      readKiloSdkSessionItem(
        { item_data: 'not-json', item_data_r2_key: null },
        () => undefined,
        {} as R2Bucket,
        32
      )
    ).resolves.toEqual({ kind: 'invalid_data' });
  });

  it('rejects oversized inline snapshots before parsing', async () => {
    await expect(
      readKiloSdkSessionItem(
        { item_data: JSON.stringify({ title: 'x'.repeat(40) }), item_data_r2_key: null },
        () => undefined,
        {} as R2Bucket,
        32
      )
    ).resolves.toEqual({ kind: 'too_large', maximumBytes: 32 });
  });

  it('re-reads a replaced R2-backed snapshot once under the same maximum', async () => {
    const replacement = { id: 'ses_new', title: 'latest' };
    const resolveCurrent = vi.fn(() => ({ item_data: '{}', item_data_r2_key: 'snapshot-new' }));
    const head = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        size: new TextEncoder().encode(JSON.stringify(replacement)).byteLength,
      });
    const get = vi.fn(async () => r2Body(replacement));
    const bucket = { head, get } as unknown as R2Bucket;

    await expect(
      readKiloSdkSessionItem(
        { item_data: '{}', item_data_r2_key: 'snapshot-old' },
        resolveCurrent,
        bucket,
        4096
      )
    ).resolves.toEqual({
      kind: 'value',
      info: replacement,
      byteLength: new TextEncoder().encode(JSON.stringify(replacement)).byteLength,
    });
    expect(resolveCurrent).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('snapshot-new');
  });

  it('fails deliberately after one unresolved R2 snapshot attempt', async () => {
    const resolveCurrent = vi.fn(() => ({ item_data: '{}', item_data_r2_key: 'snapshot-new' }));
    const head = vi.fn(async () => null);
    const get = vi.fn();
    const bucket = { head, get } as unknown as R2Bucket;

    await expect(
      readKiloSdkSessionItem(
        { item_data: '{}', item_data_r2_key: 'snapshot-old' },
        resolveCurrent,
        bucket,
        4096
      )
    ).resolves.toEqual({ kind: 'retryable_failure' });
    expect(resolveCurrent).toHaveBeenCalledTimes(1);
    expect(head).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('Kilo SDK history materialization budget', () => {
  it('rejects an inline item that exceeds the remaining cumulative budget', async () => {
    const budget = createKiloSdkHistoryReadBudget(32);

    await expect(
      readKiloSdkHistoryItem(
        { item_data: JSON.stringify({ text: 'x'.repeat(40) }), item_data_r2_key: null },
        {} as R2Bucket,
        budget,
        'message_scan'
      )
    ).resolves.toEqual({ kind: 'intrinsically_too_large' });
  });

  it('applies one cumulative budget across separately materialized items', async () => {
    const budget = createKiloSdkHistoryReadBudget(40);
    const first = JSON.stringify({ id: 'first', text: 'one' });
    const second = JSON.stringify({ id: 'second', text: 'two' });

    await expect(
      readKiloSdkHistoryItem(
        { item_data: first, item_data_r2_key: null },
        {} as R2Bucket,
        budget,
        'message_scan'
      )
    ).resolves.toMatchObject({ kind: 'value' });
    await expect(
      readKiloSdkHistoryItem(
        { item_data: second, item_data_r2_key: null },
        {} as R2Bucket,
        budget,
        'page_parts'
      )
    ).resolves.toEqual({
      kind: 'too_large',
      maximumBytes: 40,
      phase: 'page_parts',
    });
  });

  it('rejects candidate growth before resolving more tiny persisted bodies', async () => {
    const budget = createKiloSdkHistoryReadBudget(
      KILO_SDK_HISTORY_CANDIDATE_OVERHEAD_BYTES + new TextEncoder().encode('{}').byteLength
    );
    const resolveItem = vi.fn(() => ({ item_data: '{}', item_data_r2_key: null }));

    await expect(
      readKiloSdkHistoryCandidate(1, resolveItem, {} as R2Bucket, budget, 'message_scan')
    ).resolves.toMatchObject({ kind: 'value' });
    await expect(
      readKiloSdkHistoryCandidate(2, resolveItem, {} as R2Bucket, budget, 'message_scan')
    ).resolves.toEqual({
      kind: 'too_large',
      maximumBytes:
        KILO_SDK_HISTORY_CANDIDATE_OVERHEAD_BYTES + new TextEncoder().encode('{}').byteLength,
      phase: 'message_scan',
    });
    expect(resolveItem).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized R2-backed part using metadata without consuming its body', async () => {
    const head = vi.fn(async () => ({ size: 33 }));
    const get = vi.fn(async () => {
      throw new Error('oversized R2 body must not be requested');
    });
    const bucket = { head, get } as unknown as R2Bucket;

    await expect(
      readKiloSdkHistoryItem(
        { item_data: '{}', item_data_r2_key: 'large-part' },
        bucket,
        createKiloSdkHistoryReadBudget(32),
        'page_parts'
      )
    ).resolves.toEqual({ kind: 'intrinsically_too_large' });
    expect(head).toHaveBeenCalledWith('large-part');
    expect(get).not.toHaveBeenCalled();
  });

  it('re-reads a replaced R2-backed message once instead of returning empty data', async () => {
    const replacement = { id: 'msg_new', time: { created: 100 } };
    const resolveItem = vi
      .fn<(_rowId: number) => { item_data: string; item_data_r2_key: string }>()
      .mockReturnValueOnce({ item_data: '{}', item_data_r2_key: 'missing-old' })
      .mockReturnValueOnce({ item_data: '{}', item_data_r2_key: 'current-new' });
    const head = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        size: new TextEncoder().encode(JSON.stringify(replacement)).byteLength,
      });
    const get = vi.fn(async () => r2Body(replacement));
    const bucket = { head, get } as unknown as R2Bucket;

    await expect(
      readKiloSdkHistoryCandidate(
        1,
        resolveItem,
        bucket,
        createKiloSdkHistoryReadBudget(4096),
        'message_scan'
      )
    ).resolves.toEqual({ kind: 'value', value: replacement });
    expect(resolveItem).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('current-new');
  });

  it('returns a retryable failure when an R2-backed part still has no materialized object', async () => {
    const resolveItem = vi.fn(() => ({ item_data: '{}', item_data_r2_key: 'missing-part' }));
    const head = vi.fn(async () => null);
    const get = vi.fn();
    const bucket = { head, get } as unknown as R2Bucket;

    await expect(
      readKiloSdkHistoryCandidate(
        2,
        resolveItem,
        bucket,
        createKiloSdkHistoryReadBudget(4096),
        'page_parts'
      )
    ).resolves.toEqual({ kind: 'retryable_failure', phase: 'page_parts' });
    expect(resolveItem).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
  });
});
