import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type {
  RequestLogByokFailoverAttempt,
  RequestLogRoutingDetails,
} from '@/lib/request-logs/routing-details';
import type { RoutingSections as RoutingSectionsComponent } from './RequestLogDetailsSheet';

let RoutingSections: typeof RoutingSectionsComponent;
const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React');

beforeAll(async () => {
  Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: React });
  ({ RoutingSections } = await import('./RequestLogDetailsSheet'));
});

afterAll(() => {
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact);
  else Reflect.deleteProperty(globalThis, 'React');
});

function routing(attempts: RequestLogByokFailoverAttempt[]): RequestLogRoutingDetails {
  return {
    requested_model: 'openai/gpt-5',
    api_kind: 'chat_completions',
    owner_type: 'user',
    steps: [{ step: 'byok-key', outcome: 'selected', route: 'vercel-byok', provider_id: 'openai' }],
    byok_candidates: [
      { route: 'vercel-byok', provider_id: 'openai', route_order: 0, outcome: 'selected' },
      { route: 'gateway-byok', provider_id: 'openrouter', route_order: 1, outcome: 'unreached' },
    ],
    result: {
      kind: 'provider',
      route: 'vercel-byok',
      provider_type: 'vercel',
      byok_provider_ids: ['openai'],
      payer: 'owner-byok-key',
      is_free: false,
    },
    enkrypt: null,
    enkrypt_output: null,
    byok_failover_attempts: attempts,
  };
}

function render(details: RequestLogRoutingDetails) {
  const html = renderToStaticMarkup(
    createElement(RoutingSections, { metadata: { status: 'available', routing: details } })
  );
  return parseHTML(`<html><body>${html}</body></html>`).document;
}

function candidateRows(document: Document) {
  return [...document.querySelectorAll('[aria-label="BYOK keys in route order"] li')].map(
    row => row.textContent
  );
}

const openAiFailed: RequestLogByokFailoverAttempt = {
  provider_type: 'vercel',
  byok_provider_ids: ['openai'],
  status: 429,
  error_code: 'insufficient_quota',
  duration_ms: 412,
  outcome: 'failed-over',
};

describe('RoutingSections BYOK failover', () => {
  it('shows no failover section when the first key served the request', () => {
    const document = render(routing([]));

    expect(document.querySelector('[aria-label="BYOK failover attempts"]')).toBeNull();
    expect(document.body.textContent).toContain('Served with the OpenAI API key');
  });

  it('reports the key that served the request after failover', () => {
    const document = render(
      routing([
        openAiFailed,
        {
          provider_type: 'openrouter',
          byok_provider_ids: ['openrouter'],
          status: 200,
          duration_ms: 1_200,
          outcome: 'served',
        },
      ])
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('Tried the OpenAI API key through Vercel AI Gateway first');
    expect(text).toContain('Sent to OpenRouter');
    expect(text).toContain('1 BYOK key failed before this attempt');
    expect(candidateRows(document)).toEqual([
      expect.stringContaining('Failed'),
      expect.stringContaining('Selected'),
    ]);
    const attempts = [...document.querySelectorAll('[aria-label="BYOK failover attempts"] li')].map(
      row => row.textContent
    );
    expect(attempts).toEqual([
      expect.stringMatching(/HTTP 429.*insufficient_quota/),
      expect.stringContaining('HTTP 200'),
    ]);
  });

  it('says every key failed when the last attempt failed too', () => {
    const document = render(
      routing([
        openAiFailed,
        {
          provider_type: 'openrouter',
          byok_provider_ids: ['openrouter'],
          status: 503,
          error_code: 'upstream_disconnect',
          duration_ms: 30_000,
          outcome: 'failed',
          stop_reason: 'no-keys-left',
        },
      ])
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('Every BYOK key that could serve the request failed');
    expect(text).toContain('Kilo credits were not used');
    expect(text).not.toContain('Sent to');
    expect(candidateRows(document)).toEqual([
      expect.stringContaining('Failed'),
      expect.stringContaining('Failed'),
    ]);
  });

  it.each([
    ['budget-exhausted', 'BYOK failover ran out of time'],
    ['client-disconnected', 'The client disconnected during BYOK failover'],
    ['model-unavailable', 'BYOK failover reached a gateway that does not list this model'],
  ])('does not claim every key failed when failover stopped because of %s', (stopReason, title) => {
    const text =
      render(
        routing([openAiFailed, { ...openAiFailed, outcome: 'failed', stop_reason: stopReason }])
      ).body.textContent ?? '';

    expect(text).toContain(title);
    expect(text).not.toContain('Every BYOK key');
  });

  it('does not say the Vercel AI Gateway key went through Vercel AI Gateway', () => {
    const document = render(
      routing([
        openAiFailed,
        {
          provider_type: 'vercel',
          byok_provider_ids: ['vercel-ai-gateway'],
          status: 200,
          duration_ms: 700,
          outcome: 'served',
        },
      ])
    );

    const attempts = [...document.querySelectorAll('[aria-label="BYOK failover attempts"] li')].map(
      row => row.textContent ?? ''
    );
    expect(attempts[0]).toContain('via Vercel AI Gateway');
    expect(attempts[1]).not.toContain('via Vercel AI Gateway');
  });
});
