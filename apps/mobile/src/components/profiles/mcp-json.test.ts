import { describe, expect, it } from 'vitest';

import { formatRecord, MASKED_MCP_VALUE, parseRecord } from '@/components/profiles/mcp-json';

describe('MASKED_MCP_VALUE', () => {
  it('is the four-bullet placeholder the server round-trips', () => {
    expect(MASKED_MCP_VALUE).toBe('\u2022\u2022\u2022\u2022');
  });
});

describe('parseRecord', () => {
  it('treats blank text as an empty fragment', () => {
    expect(parseRecord('')).toEqual({ ok: true, value: undefined });
    expect(parseRecord('   \n ')).toEqual({ ok: true, value: undefined });
  });

  it('parses a JSON object of strings', () => {
    expect(parseRecord('{"API_KEY":"sk-1","NODE_ENV":"production"}')).toEqual({
      ok: true,
      value: { API_KEY: 'sk-1', NODE_ENV: 'production' },
    });
  });

  it('treats an empty object as an empty fragment', () => {
    expect(parseRecord('{}')).toEqual({ ok: true, value: undefined });
  });

  it('refuses invalid JSON', () => {
    const result = parseRecord('{');
    expect(result.ok).toBe(false);
  });

  it('refuses a non-object', () => {
    expect(parseRecord('"secret"').ok).toBe(false);
    expect(parseRecord('[1,2]').ok).toBe(false);
    expect(parseRecord('null').ok).toBe(false);
  });

  it('refuses a non-string value', () => {
    const result = parseRecord('{"PORT":8080}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PORT');
    }
  });
});

describe('formatRecord', () => {
  it('renders an empty fragment as blank text', () => {
    expect(formatRecord(undefined)).toBe('');
    expect(formatRecord({})).toBe('');
  });

  it('pretty-prints the record keys and masked values', () => {
    expect(formatRecord({ API_KEY: MASKED_MCP_VALUE })).toBe(
      JSON.stringify({ API_KEY: MASKED_MCP_VALUE }, null, 2)
    );
  });

  it('round-trips through parseRecord unchanged', () => {
    const record = { API_KEY: MASKED_MCP_VALUE, NODE_ENV: 'production' };
    const parsed = parseRecord(formatRecord(record));
    expect(parsed).toEqual({ ok: true, value: record });
  });
});
