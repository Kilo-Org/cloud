import { describe, expect, it } from 'vitest';
import { ingestAuditEvents } from '../src/relay/axiom';
import { auditBatch, recordingFetch } from './helpers';

const CONFIG = { url: 'https://api.axiom.co', dataset: 'kilo-audit-test', token: 'token' };

async function ingestAnswering(status: number) {
  const http = recordingFetch(() => new Response(null, { status }));
  return ingestAuditEvents(CONFIG, auditBatch(1, 1).events, http.impl);
}

describe('ingestAuditEvents', () => {
  it.each([401, 403, 408, 429, 500, 503])('retries HTTP %i', async status => {
    expect(await ingestAnswering(status)).toEqual({
      kind: 'retryable',
      detail: `http_${status}`,
    });
  });

  it.each([400, 413, 422])('rejects HTTP %i', async status => {
    expect(await ingestAnswering(status)).toEqual({ kind: 'rejected', status });
  });

  it('retries a network failure', async () => {
    const result = await ingestAuditEvents(CONFIG, auditBatch(1, 1).events, async () => {
      throw new TypeError('network');
    });
    expect(result).toEqual({ kind: 'retryable', detail: 'TypeError' });
  });
});
