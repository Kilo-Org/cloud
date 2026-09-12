import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_LIMIT } from './search';
import {
  MAX_CLIENT_HEADER_LENGTH,
  callArgsSchema,
  forwardedClientHeadersSchema,
  initializeParamsSchema,
  jsonRpcEnvelopeSchema,
  orgPickerFormSchema,
  orgPickerQuerySchema,
  pairingStatusQuerySchema,
  searchArgsSchema,
  toolsCallParamsSchema,
} from './schemas';

describe('jsonRpcEnvelopeSchema', () => {
  it('accepts a typical request with a string id', () => {
    const parsed = jsonRpcEnvelopeSchema.safeParse({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'tools/list',
      params: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a numeric id, a null id, and a missing id', () => {
    expect(jsonRpcEnvelopeSchema.safeParse({ id: 7, method: 'ping' }).success).toBe(true);
    expect(jsonRpcEnvelopeSchema.safeParse({ id: null, method: 'ping' }).success).toBe(true);
    expect(jsonRpcEnvelopeSchema.safeParse({ method: 'ping' }).success).toBe(true);
  });

  it('keeps unknown top-level fields', () => {
    const parsed = jsonRpcEnvelopeSchema.safeParse({ method: 'ping', extra: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data['extra']).toBe(true);
  });

  it('rejects a batch (array) request', () => {
    expect(jsonRpcEnvelopeSchema.safeParse([{ method: 'ping' }]).success).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(jsonRpcEnvelopeSchema.safeParse(null).success).toBe(false);
    expect(jsonRpcEnvelopeSchema.safeParse('ping').success).toBe(false);
  });

  it('rejects a missing, empty, whitespace-only, or non-string method', () => {
    expect(jsonRpcEnvelopeSchema.safeParse({}).success).toBe(false);
    expect(jsonRpcEnvelopeSchema.safeParse({ method: '' }).success).toBe(false);
    expect(jsonRpcEnvelopeSchema.safeParse({ method: '   ' }).success).toBe(false);
    expect(jsonRpcEnvelopeSchema.safeParse({ method: 42 }).success).toBe(false);
  });

  it('rejects an id that is an object or boolean', () => {
    expect(jsonRpcEnvelopeSchema.safeParse({ method: 'ping', id: {} }).success).toBe(false);
    expect(jsonRpcEnvelopeSchema.safeParse({ method: 'ping', id: true }).success).toBe(false);
  });
});

describe('initializeParamsSchema', () => {
  it('accepts empty params and the read fields', () => {
    expect(initializeParamsSchema.safeParse({}).success).toBe(true);
    expect(
      initializeParamsSchema.safeParse({
        protocolVersion: '2025-06-18',
        capabilities: { roots: {} },
        clientInfo: { name: 'claude-ai', version: '0.1.0' },
      }).success
    ).toBe(true);
  });

  it('rejects non-string protocolVersion and non-string clientInfo.name', () => {
    expect(initializeParamsSchema.safeParse({ protocolVersion: 2025 }).success).toBe(false);
    expect(initializeParamsSchema.safeParse({ clientInfo: { name: 1 } }).success).toBe(false);
  });

  it('rejects a non-object params value', () => {
    expect(initializeParamsSchema.safeParse('init').success).toBe(false);
    expect(initializeParamsSchema.safeParse([]).success).toBe(false);
  });
});

describe('toolsCallParamsSchema', () => {
  it('accepts a non-empty name with and without an arguments object', () => {
    expect(toolsCallParamsSchema.safeParse({ name: 'search' }).success).toBe(true);
    expect(
      toolsCallParamsSchema.safeParse({ name: 'call', arguments: { path: 'user.getBalance' } })
        .success
    ).toBe(true);
  });

  it('rejects a missing, empty, or whitespace-only name', () => {
    expect(toolsCallParamsSchema.safeParse({}).success).toBe(false);
    expect(toolsCallParamsSchema.safeParse({ name: '' }).success).toBe(false);
    expect(toolsCallParamsSchema.safeParse({ name: '  ' }).success).toBe(false);
  });

  it('rejects arguments that are not a plain object', () => {
    expect(toolsCallParamsSchema.safeParse({ name: 'search', arguments: [] }).success).toBe(false);
    expect(toolsCallParamsSchema.safeParse({ name: 'search', arguments: null }).success).toBe(
      false
    );
    expect(toolsCallParamsSchema.safeParse({ name: 'search', arguments: 'q' }).success).toBe(false);
  });
});

describe('searchArgsSchema', () => {
  it('accepts a query alone and a bounded integer limit', () => {
    expect(searchArgsSchema.safeParse({ query: 'balance' }).success).toBe(true);
    expect(searchArgsSchema.safeParse({ query: 'balance', limit: 1 }).success).toBe(true);
    expect(searchArgsSchema.safeParse({ query: 'balance', limit: MAX_SEARCH_LIMIT }).success).toBe(
      true
    );
  });

  it('rejects an empty or whitespace-only query', () => {
    expect(searchArgsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(searchArgsSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(searchArgsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a limit outside the range or not an integer', () => {
    expect(searchArgsSchema.safeParse({ query: 'q', limit: 0 }).success).toBe(false);
    expect(searchArgsSchema.safeParse({ query: 'q', limit: MAX_SEARCH_LIMIT + 1 }).success).toBe(
      false
    );
    expect(searchArgsSchema.safeParse({ query: 'q', limit: 2.5 }).success).toBe(false);
    expect(searchArgsSchema.safeParse({ query: 'q', limit: '5' }).success).toBe(false);
  });
});

describe('callArgsSchema', () => {
  it('accepts a path with and without an input object', () => {
    expect(callArgsSchema.safeParse({ path: 'organizations.list' }).success).toBe(true);
    expect(
      callArgsSchema.safeParse({ path: 'organizations.list', input: { query: 'x' } }).success
    ).toBe(true);
  });

  it('rejects an empty or whitespace-only path', () => {
    expect(callArgsSchema.safeParse({ path: '' }).success).toBe(false);
    expect(callArgsSchema.safeParse({ path: '   ' }).success).toBe(false);
    expect(callArgsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects input that is not a plain object', () => {
    expect(callArgsSchema.safeParse({ path: 'x', input: [] }).success).toBe(false);
    expect(callArgsSchema.safeParse({ path: 'x', input: null }).success).toBe(false);
    expect(callArgsSchema.safeParse({ path: 'x', input: 'q' }).success).toBe(false);
  });
});

describe('pairingStatusQuerySchema', () => {
  it('accepts a non-empty code (the /authorize/status query field)', () => {
    expect(pairingStatusQuerySchema.safeParse({ code: 'pair_123' }).success).toBe(true);
  });

  it('rejects a missing or empty code', () => {
    expect(pairingStatusQuerySchema.safeParse({}).success).toBe(false);
    expect(pairingStatusQuerySchema.safeParse({ code: '' }).success).toBe(false);
    expect(pairingStatusQuerySchema.safeParse({ code: 1 }).success).toBe(false);
  });
});

describe('orgPickerQuerySchema', () => {
  it('accepts a non-empty code', () => {
    expect(orgPickerQuerySchema.safeParse({ code: 'auth_code' }).success).toBe(true);
  });

  it('rejects a missing or empty code', () => {
    expect(orgPickerQuerySchema.safeParse({}).success).toBe(false);
    expect(orgPickerQuerySchema.safeParse({ code: '' }).success).toBe(false);
  });
});

describe('orgPickerFormSchema', () => {
  it('accepts a non-empty organization_id', () => {
    expect(orgPickerFormSchema.safeParse({ organization_id: 'personal' }).success).toBe(true);
  });

  it('rejects a missing or empty organization_id', () => {
    expect(orgPickerFormSchema.safeParse({}).success).toBe(false);
    expect(orgPickerFormSchema.safeParse({ organization_id: '' }).success).toBe(false);
    expect(orgPickerFormSchema.safeParse({ organization_id: null }).success).toBe(false);
  });
});

describe('forwardedClientHeadersSchema', () => {
  it('retains every header from the documented Object.fromEntries(headers) conversion', () => {
    // The Fetch Headers iterator lowercases names, so a caller following the
    // documented conversion hands the schema lowercase keys. Keying the schema
    // on the canonical `CF-Connecting-IP` spelling silently drops its
    // (optional) value.
    const parsed = forwardedClientHeadersSchema.safeParse(
      Object.fromEntries(
        new Headers({
          'CF-Connecting-IP': '203.0.113.7',
          'x-forwarded-for': '203.0.113.7, 198.51.100.2',
          'user-agent': 'claude-ai/0.1.0',
        })
      )
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data['cf-connecting-ip']).toBe('203.0.113.7');
      expect(parsed.data['x-forwarded-for']).toBe('203.0.113.7, 198.51.100.2');
      expect(parsed.data['user-agent']).toBe('claude-ai/0.1.0');
    }
  });

  it('accepts the lowercase header keys directly', () => {
    expect(
      forwardedClientHeadersSchema.safeParse({
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '203.0.113.7, 198.51.100.2',
        'user-agent': 'claude-ai/0.1.0',
      }).success
    ).toBe(true);
  });

  it('accepts an empty object (no client headers present)', () => {
    expect(forwardedClientHeadersSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a value at the length bound and rejects one over it', () => {
    expect(
      forwardedClientHeadersSchema.safeParse({
        'user-agent': 'a'.repeat(MAX_CLIENT_HEADER_LENGTH),
      }).success
    ).toBe(true);
    expect(
      forwardedClientHeadersSchema.safeParse({
        'user-agent': 'a'.repeat(MAX_CLIENT_HEADER_LENGTH + 1),
      }).success
    ).toBe(false);
  });

  it('rejects CR/LF header injection', () => {
    expect(
      forwardedClientHeadersSchema.safeParse({ 'x-forwarded-for': '1.2.3.4\r\nX-Evil: 1' }).success
    ).toBe(false);
    expect(
      forwardedClientHeadersSchema.safeParse({ 'user-agent': 'agent\ninjected' }).success
    ).toBe(false);
  });

  it('rejects a non-string header value', () => {
    expect(forwardedClientHeadersSchema.safeParse({ 'user-agent': 1 }).success).toBe(false);
  });
});
