import { describe, expect, it, vi } from 'vitest';

vi.mock('../dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

import { getSessionIngestDO } from '../dos/SessionIngestDO';
import type { Env } from '../env';
import { INGEST_CHUNK_MAX_BYTES } from '../util/ingest-limits';
import { stageAndEnqueue, toRpcBody } from './stage-and-enqueue';

const encoder = new TextEncoder();

function makeEnv() {
  return {
    INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    SESSION_INGEST_R2: { delete: vi.fn(async () => undefined) },
  } as unknown as Env;
}

const params = {
  r2Key: 'ingest/usr_1/ses_1/req_1',
  kiloUserId: 'usr_1',
  sessionId: 'ses_1',
  ingestVersion: 2,
};

describe('toRpcBody', () => {
  it('reads a measured small stream into bytes so it can cross the local DO RPC', async () => {
    const body = new Blob([encoder.encode('{"data":[]}')]).stream();
    expect(await toRpcBody(body, 11)).toBeInstanceOf(Uint8Array);
  });

  it('keeps a body larger than the direct-ingest budget as a stream', async () => {
    const body = new Blob(['x']).stream();
    expect(await toRpcBody(body, INGEST_CHUNK_MAX_BYTES + 1)).toBe(body);
  });

  it('keeps an unmeasured body as a stream', async () => {
    const body = new Blob(['x']).stream();
    expect(await toRpcBody(body, undefined)).toBe(body);
  });

  it('passes small bytes through unchanged', () => {
    const bytes = encoder.encode('{"data":[1]}');
    return expect(toRpcBody(bytes, bytes.byteLength)).resolves.toBe(bytes);
  });

  it('streams bytes larger than the budget to respect the RPC payload limit', async () => {
    const bytes = new Uint8Array(INGEST_CHUNK_MAX_BYTES + 1);
    expect(await toRpcBody(bytes, bytes.byteLength)).toBeInstanceOf(ReadableStream);
  });

  it('keeps bytes exactly at the budget by value', async () => {
    const bytes = new Uint8Array(INGEST_CHUNK_MAX_BYTES);
    expect(await toRpcBody(bytes, bytes.byteLength)).toBe(bytes);
  });

  it('rejects a body larger than the staging byte budget', async () => {
    const body = new Blob([new Uint8Array(INGEST_CHUNK_MAX_BYTES + 1)]).stream();
    await expect(toRpcBody(body, 1)).rejects.toThrow('Ingest body exceeds the staging byte budget');
  });
});

describe('stageAndEnqueue', () => {
  it('transfers a measured streamed body to the DO by value and enqueues the key', async () => {
    const stageR2Object = vi.fn(async (_params: { key: string }, _body: Uint8Array) => true);
    vi.mocked(getSessionIngestDO).mockReturnValue({ stageR2Object } as never);

    const accepted = await stageAndEnqueue(
      makeEnv(),
      params,
      new Blob([encoder.encode('{"data":[]}')]).stream(),
      11
    );

    expect(accepted).toBe(true);
    expect(stageR2Object).toHaveBeenCalledTimes(1);
    const body = stageR2Object.mock.calls[0]?.[1] as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(body)).toBe('{"data":[]}');
  });
});
