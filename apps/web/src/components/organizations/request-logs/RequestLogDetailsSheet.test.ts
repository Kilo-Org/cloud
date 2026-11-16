import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type {
  RequestLogDetails,
  RequestLogRow,
  RequestSummary as RequestSummaryComponent,
} from './RequestLogDetailsSheet';

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: jest.fn() }));

let RequestSummary: typeof RequestSummaryComponent;
const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React');

beforeAll(async () => {
  Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: React });
  ({ RequestSummary } = await import('./RequestLogDetailsSheet'));
});

afterAll(() => {
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact);
  else Reflect.deleteProperty(globalThis, 'React');
});

const row: RequestLogRow = {
  id: '00000000-0000-4000-8000-000000000001',
  created_at: '2026-01-01T00:00:00.000Z',
  user: { id: 'user-1', name: 'Example', email: 'user@example.com' },
  model: 'example/model',
  provider: 'Example',
  user_agent_name: 'Kilo Code',
  cost_microdollars: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_hit_tokens: 0,
  is_user_byok: false,
  has_error: false,
  project_id: null,
  feature: null,
  latency_ms: null,
  generation_time_ms: null,
};

function details(): RequestLogDetails {
  return {
    request: {
      model: 'example/model',
      requested_model: 'example/model',
      provider: null,
      inference_provider: null,
      cache_write_tokens: 0,
      status_code: 200,
      finish_reason: null,
      api_kind: null,
      streamed: true,
      auto_model: null,
      session_id: null,
      editor_name: null,
      mode: null,
      inference_region: null,
    },
    metadata: { status: 'not-configured' },
  };
}

function userAgentValue(userAgent: string, requestDetails?: RequestLogDetails) {
  const markup = renderToStaticMarkup(
    createElement(RequestSummary, {
      row: { ...row, user_agent_name: userAgent },
      details: requestDetails,
    })
  );
  const { document } = parseHTML(markup);
  const label = Array.from(document.querySelectorAll('dt')).find(
    element => element.textContent === 'User Agent'
  );
  expect(label).toBeDefined();
  return label?.nextElementSibling?.textContent;
}

describe('request-log user agent', () => {
  it('shows the human-readable name in the request details', () => {
    expect(userAgentValue('Kilo Code', details())).toBe('Kilo Code');
  });

  it('shows Unknown when no user agent was recorded', () => {
    expect(userAgentValue('Unknown', details())).toBe('Unknown');
  });

  it('shows the normalized list-row name before details load', () => {
    expect(userAgentValue('Kilo CLI')).toBe('Kilo CLI');
  });
});
