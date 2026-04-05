import { describe, it, expect } from 'vitest';
import { tryParseJson } from './streaming-helpers.js';

describe('tryParseJson', () => {
  const ansiLog = {
    type: 'log',
    message: 'Output: \u001b[32mSuccess\u001b[0m',
  };

  const successfulCases = [
    {
      name: 'standard JSON object',
      input: '{"type":"test","value":42}',
      expected: { type: 'test', value: 42 },
    },
    {
      name: 'JSON with nested objects',
      input: '{"type":"tool_use","input":{"path":"test.ts"}}',
      expected: {
        type: 'tool_use',
        input: { path: 'test.ts' },
      },
    },
    {
      name: 'JSON with ANSI prefix stripped',
      input: '\u001b[2K{"type":"status","message":"Starting"}',
      expected: { type: 'status', message: 'Starting' },
    },
    {
      name: 'JSON containing ANSI sequences inside strings',
      input: JSON.stringify(ansiLog),
      expected: ansiLog,
    },
    {
      name: 'ANSI-prefixed JSON containing ANSI strings',
      input: '\u001b[2K' + JSON.stringify(ansiLog),
      expected: ansiLog,
    },
  ] as const;

  const failureCases = [
    { name: 'invalid JSON', input: 'Not valid JSON' },
    { name: 'empty string', input: '' },
    { name: 'partial JSON', input: '{"type":"incomplete"' },
    { name: 'ANSI-only string', input: '\u001b[32m\u001b[1m\u001b[0m' },
  ] as const;

  it.each(successfulCases)('parses $name', ({ input, expected }) => {
    expect(tryParseJson(input)).toEqual(expected);
  });

  it.each(failureCases)('returns null for $name', ({ input }) => {
    expect(tryParseJson(input)).toBeNull();
  });

  it.each(['42', '"string"', 'true', 'null'])('returns null for JSON primitive %s', primitive => {
    expect(tryParseJson(primitive)).toBeNull();
  });
});
