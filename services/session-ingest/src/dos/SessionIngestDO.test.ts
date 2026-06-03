import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

import { ingestOrderCursor } from './SessionIngestDO';

describe('SessionIngestDO ingest ordering', () => {
  it('uses ingested_at with id only as a tie-breaker for cursor progression', () => {
    expect(ingestOrderCursor({ ingested_at: 100, id: 7 })).toEqual({ ingestedAt: 100, id: 7 });
    expect(ingestOrderCursor({ ingested_at: null, id: 3 })).toEqual({ ingestedAt: null, id: 3 });
  });
});
