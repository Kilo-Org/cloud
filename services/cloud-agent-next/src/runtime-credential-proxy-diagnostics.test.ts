import { describe, expect, it } from 'vitest';
import { readUpstreamFailureEvidence } from './runtime-credential-proxy-diagnostics.js';

describe('readUpstreamFailureEvidence', () => {
  it('captures the application error reason from a JSON body', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'Access denied (R0)' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', Server: 'Vercel' },
    });

    await expect(readUpstreamFailureEvidence(response)).resolves.toEqual({
      upstreamServer: 'Vercel',
      upstreamContentType: 'application/json',
      upstreamErrorExcerpt: 'Access denied (R0)',
    });
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Access denied (R0)',
    });
  });

  it('captures a nested provider error message', async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'Model not available in your region', code: 403 } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );

    await expect(readUpstreamFailureEvidence(response)).resolves.toMatchObject({
      upstreamErrorExcerpt: 'Model not available in your region',
    });
  });

  it('captures Cloudflare edge evidence from a plain text body', async () => {
    const response = new Response('error code: 1020', {
      status: 403,
      headers: { 'Content-Type': 'text/plain', Server: 'cloudflare', 'CF-Ray': '8f-FRA' },
    });

    await expect(readUpstreamFailureEvidence(response)).resolves.toEqual({
      upstreamServer: 'cloudflare',
      upstreamContentType: 'text/plain',
      upstreamCfRay: '8f-FRA',
      upstreamErrorExcerpt: 'error code: 1020',
    });
  });

  it('redacts credential-shaped values and bounds the excerpt', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3IifQ.signature_part';
    const response = new Response(
      `Bearer abc.def rejected ${jwt} key ${'k'.repeat(40)} ${'x '.repeat(200)}`,
      { status: 401, headers: { 'Content-Type': 'text/plain' } }
    );

    const evidence = await readUpstreamFailureEvidence(response);

    expect(evidence.upstreamErrorExcerpt).toMatch(
      /^Bearer \[redacted\] rejected \[redacted\] key \[redacted\] x x/
    );
    expect(evidence.upstreamErrorExcerpt).not.toContain('eyJ');
    expect(evidence.upstreamErrorExcerpt?.length).toBeLessThanOrEqual(160);
  });

  it('redacts short provider keys and key-value secrets', async () => {
    const response = new Response(
      JSON.stringify({ error: 'invalid api key: sk-abc123 (token=short1; password: hunter2)' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );

    await expect(readUpstreamFailureEvidence(response)).resolves.toMatchObject({
      upstreamErrorExcerpt: 'invalid api key: [redacted] (token=[redacted]; password: [redacted])',
    });
  });

  it('falls back to visible text for HTML without a title', async () => {
    const response = new Response(
      '<html><head><style>body { color: red }</style></head><body><h1>Access denied</h1></body></html>',
      { status: 403, headers: { 'Content-Type': 'text/html' } }
    );

    await expect(readUpstreamFailureEvidence(response)).resolves.toMatchObject({
      upstreamErrorExcerpt: 'Access denied',
    });
  });

  it('keeps headers when the body cannot be read', async () => {
    const response = new Response('denied', {
      status: 403,
      headers: { 'Content-Type': 'text/plain', Server: 'Vercel' },
    });
    await response.text();

    await expect(readUpstreamFailureEvidence(response)).resolves.toEqual({
      upstreamServer: 'Vercel',
      upstreamContentType: 'text/plain',
    });
  });

  it('does not read the body for other failure statuses', async () => {
    const response = new Response('rate limited', {
      status: 429,
      headers: { 'Content-Type': 'text/plain' },
    });

    await expect(readUpstreamFailureEvidence(response)).resolves.toEqual({
      upstreamContentType: 'text/plain',
    });
    expect(response.bodyUsed).toBe(false);
  });

  it('stops waiting for a body that does not finish', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const response = new Response(stalled, { status: 403 });

    await expect(readUpstreamFailureEvidence(response)).resolves.toEqual({});
  });
});
