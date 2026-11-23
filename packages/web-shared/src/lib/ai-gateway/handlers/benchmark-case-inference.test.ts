import { describe, it, expect } from '@jest/globals';

// First, so the server config module sees its placeholders before it loads.
import './benchmark-case-inference-test-env';

import { rebuildBenchmarkProxyRequest } from './benchmark-case-inference';

/**
 * The rebuilt-request boundary of the benchmark gateway handler.
 *
 * `handleBenchmarkCaseInference` authenticates a signed assignment, then hands the normal LLM
 * proxy a rebuilt `/api/v1/<api>` request. The proxy derives the client IP from
 * `x-forwarded-for` only and refuses before any admission work when it is absent, so these
 * cases pin exactly what the rebuild carries: the hop's own transport `x-forwarded-for`, and
 * nothing invented.
 */
const CASE_BODY = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('benchmark gateway rebuilt proxy request', () => {
  it('carries the hop x-forwarded-for so the proxy can pass its client-IP check', () => {
    const rebuilt = rebuildBenchmarkProxyRequest('chat/completions', CASE_BODY, '203.0.113.7');

    // The proxy reads exactly this header; without it the call never reaches admission.
    expect(rebuilt.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(rebuilt.url).toBe('https://ai-gateway.internal/api/v1/chat/completions');
    expect(rebuilt.method).toBe('POST');
  });

  it('does not invent an IP when the hop sent none', () => {
    const rebuilt = rebuildBenchmarkProxyRequest('chat/completions', CASE_BODY, null);

    // Nothing synthesized: the proxy's own missing-IP refusal still applies.
    expect(rebuilt.headers.get('x-forwarded-for')).toBeNull();
  });

  it('sends only the transport IP and the JSON content type as headers', () => {
    const rebuilt = rebuildBenchmarkProxyRequest('responses', CASE_BODY, '203.0.113.7');

    const names = [...rebuilt.headers.keys()].filter(
      name => !name.startsWith('sec-') && name !== 'accept'
    );
    expect(names.sort()).toEqual(['content-type', 'x-forwarded-for']);
    expect(rebuilt.headers.get('content-type')).toBe('application/json');
  });

  it('keeps the same x-forwarded-for value verbatim, including a proxy chain', () => {
    // `rawClientIp` reads the first entry, so a chain must survive the rebuild unchanged
    // rather than being rewritten to a single address.
    const rebuilt = rebuildBenchmarkProxyRequest(
      'chat/completions',
      CASE_BODY,
      '203.0.113.7, 70.41.3.18'
    );
    expect(rebuilt.headers.get('x-forwarded-for')).toBe('203.0.113.7, 70.41.3.18');
  });

  it('rebuilds the canonical proxy path for every inference API', () => {
    expect(rebuildBenchmarkProxyRequest('chat/completions', CASE_BODY, null).url).toBe(
      'https://ai-gateway.internal/api/v1/chat/completions'
    );
    expect(rebuildBenchmarkProxyRequest('responses', CASE_BODY, null).url).toBe(
      'https://ai-gateway.internal/api/v1/responses'
    );
    expect(rebuildBenchmarkProxyRequest('messages', CASE_BODY, null).url).toBe(
      'https://ai-gateway.internal/api/v1/messages'
    );
  });

  it('carries the caller body through unchanged', async () => {
    const rebuilt = rebuildBenchmarkProxyRequest('chat/completions', CASE_BODY, '203.0.113.7');
    // The signed request is what the proxy bills: the rebuild must not reshape it.
    expect(await rebuilt.text()).toBe(JSON.stringify(CASE_BODY));
  });
});
