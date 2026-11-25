import { describe, expect, it } from 'vitest';
import { ingestAuditEvents } from '../src/relay/axiom';
import { auditBatch, recordingFetch } from './helpers';

const CONFIG = { url: 'https://api.axiom.co', dataset: 'kilo-audit-test', token: 'token' };

async function ingestAnswering(status: number) {
  const http = recordingFetch(() => new Response(null, { status }));
  return ingestAuditEvents(CONFIG, auditBatch(1, 1).events, http.impl);
}

describe('ingestAuditEvents', () => {
  it.each([401, 403, 408, 429, 500, 503])('treats HTTP %i as transient', async status => {
    expect(await ingestAnswering(status)).toEqual({
      kind: 'unavailable',
      detail: `http_${status}`,
    });
  });

  it.each([400, 413, 422])('reports HTTP %i as a payload rejection', async status => {
    expect(await ingestAnswering(status)).toEqual({ kind: 'payload_rejected', status });
  });

  it.each([404, 405, 409, 410])('reports HTTP %i as a refused destination', async status => {
    expect(await ingestAnswering(status)).toEqual({ kind: 'refused', status });
  });

  it('treats a network failure as transient', async () => {
    const result = await ingestAuditEvents(CONFIG, auditBatch(1, 1).events, async () => {
      throw new TypeError('network');
    });
    expect(result).toEqual({ kind: 'unavailable', detail: 'TypeError' });
  });
});
