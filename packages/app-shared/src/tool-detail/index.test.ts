import { describe, expect, it, vi } from 'vitest';

import { buildToolDetail, buildToolDetailSummary, formatToolDetailOutput } from './index';
import type { ToolPart } from '../opencode.gen';

type ToolState = ToolPart['state'];

function pending(input: Record<string, unknown>): ToolState {
  return { status: 'pending', input, raw: '' };
}

function completed(input: Record<string, unknown>, output: string): ToolState {
  return {
    status: 'completed',
    input,
    output,
    title: '',
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function errored(input: Record<string, unknown>, error: string): ToolState {
  return { status: 'error', input, error, time: { start: 0, end: 1 } };
}

function detail(tool: string, state: ToolState, options?: { valueMaxLength?: number }) {
  return buildToolDetail({ tool, state }, options);
}

describe('buildToolDetail name resolution', () => {
  it('unwraps the mcp envelope and resolves a known server/tool name', () => {
    const result = detail(
      'mcp',
      completed(
        {
          server_name: 'app-builder-images',
          tool_name: 'transfer_image',
          arguments: { url: 'https://example.com/image.png', quality: 'high' },
        },
        'Published'
      )
    );

    expect(result.name).toBe('Publish Image');
    expect(result.arguments).toEqual({ url: 'https://example.com/image.png', quality: 'high' });
    expect(result.summary).toBe('https://example.com/image.png · quality=high');
    expect(result.fields.map(field => field.key)).toEqual(['url', 'quality']);
  });

  it('names an unknown mcp tool as server/tool', () => {
    const result = detail(
      'mcp',
      pending({ server_name: 'other-server', tool_name: 'do_thing', arguments: { query: 'hello' } })
    );

    expect(result.name).toBe('other-server/do_thing');
    expect(result.arguments).toEqual({ query: 'hello' });
    expect(result.summary).toBe('hello');
  });

  it('falls back to mcp when the envelope is incomplete', () => {
    const result = detail('mcp', pending({ server_name: 'other-server' }));

    expect(result.name).toBe('mcp');
  });

  it('does not summarize the incomplete mcp envelope', () => {
    // The envelope names the call; it is not the payload. An incomplete
    // envelope must not surface as `server_name=github` in place of `mcp`.
    const result = detail('mcp', pending({ server_name: 'github' }));

    expect(result.name).toBe('mcp');
    expect(result.summary).toBeUndefined();
  });

  it('falls back to the raw input when mcp arguments is not a record', () => {
    const input = { server_name: 'other-server', tool_name: 'do_thing', arguments: 'nope' };
    const result = detail('mcp', pending(input));

    expect(result.name).toBe('other-server/do_thing');
    expect(result.arguments).toEqual(input);
  });

  it('resolves the known display names for direct tool ids', () => {
    expect(detail('app-builder-images_transfer_image', pending({})).name).toBe('Publish Image');
    expect(detail('app-builder-images_get_image', pending({})).name).toBe('Analyze Image');
    expect(detail('unrecognized_tool', pending({})).name).toBe('unrecognized_tool');
  });
});

describe('buildToolDetail summary', () => {
  it('uses the label-key order and appends one key=value for the first other scalar', () => {
    const result = detail(
      'lookup',
      pending({
        description: 'Find matching records',
        query: 'other label',
        nested: {},
        count: 0,
        verbose: false,
      })
    );

    expect(result.summary).toBe('Find matching records · count=0');
  });

  it('prefers the label key order over insertion order', () => {
    const result = detail('lookup', pending({ name: 'z', description: 'a' }));

    expect(result.summary).toBe('a');
  });

  it('falls back to the first scalar key=value', () => {
    const result = detail('lookup', pending({ count: 5, verbose: true }));

    expect(result.summary).toBe('count=5');
  });

  it('collapses whitespace runs and trims the summary', () => {
    const result = detail('lookup', pending({ description: '  Find   matching\nrecords  ' }));

    expect(result.summary).toBe('Find matching records');
  });

  it('has no summary without a label or scalar', () => {
    const result = detail('lookup', pending({ nested: { a: 1 }, empty: '   ' }));

    expect(result.summary).toBeUndefined();
  });
});

describe('buildToolDetail question fields', () => {
  it('emits header, question and options rows per question', () => {
    const result = detail(
      'question',
      pending({
        questions: [
          {
            header: 'Pick one',
            question: 'Which one?',
            options: [
              { label: 'Alpha', description: 'first choice' },
              { label: 'Beta', description: '' },
              { label: 'Gamma' },
            ],
          },
        ],
      })
    );

    expect(result.summary).toBe('Which one?');
    expect(result.fields).toEqual([
      { key: 'header', value: 'Pick one' },
      { key: 'question', value: 'Which one?' },
      { key: 'options', value: 'Alpha — first choice\nBeta\nGamma' },
    ]);
  });

  it('numbers each question field so two questions cannot be confused', () => {
    const result = detail(
      'question',
      pending({
        questions: [
          {
            header: 'Pick one',
            question: 'Which one?',
            options: [{ label: 'Alpha', description: 'first choice' }, { label: 'Beta' }],
          },
          {
            header: 'Pick two',
            question: 'Which two?',
            options: [{ label: 'Gamma' }],
          },
        ],
      })
    );

    expect(result.fields).toEqual([
      { key: 'header 1', value: 'Pick one' },
      { key: 'question 1', value: 'Which one?' },
      { key: 'options 1', value: 'Alpha — first choice\nBeta' },
      { key: 'header 2', value: 'Pick two' },
      { key: 'question 2', value: 'Which two?' },
      { key: 'options 2', value: 'Gamma' },
    ]);
  });

  it('omits an empty header and handles the input.question string shape', () => {
    const result = detail(
      'question',
      pending({ question: 'Pick a color', options: [{ label: 'Red' }] })
    );

    expect(result.summary).toBe('Pick a color');
    expect(result.fields).toEqual([
      { key: 'question', value: 'Pick a color' },
      { key: 'options', value: 'Red' },
    ]);
  });
});

describe('buildToolDetail fields', () => {
  it('renders nested objects as indented JSON', () => {
    const result = detail('custom', pending({ nested: { a: 1 } }));

    expect(result.fields).toEqual([{ key: 'nested', value: '{\n  "a": 1\n}' }]);
  });

  it('caps every value at valueMaxLength with a trailing ellipsis', () => {
    const result = detail('custom', pending({ big: 'abcdefghij' }), { valueMaxLength: 4 });

    expect(result.fields).toEqual([{ key: 'big', value: 'abcd…' }]);
  });

  it('leaves a value at the cap unchanged', () => {
    const result = detail('custom', pending({ big: 'abcd' }), { valueMaxLength: 4 });

    expect(result.fields).toEqual([{ key: 'big', value: 'abcd' }]);
  });
});

describe('buildToolDetail empty projection fallback', () => {
  it('falls back to the raw envelope when the mcp arguments record is empty', () => {
    const result = detail(
      'mcp',
      completed(
        { server_name: 'app-builder-images', tool_name: 'transfer_image', arguments: {} },
        ''
      )
    );

    expect(result.arguments).toEqual({});
    expect(result.fields).toEqual([
      { key: 'server_name', value: 'app-builder-images' },
      { key: 'tool_name', value: 'transfer_image' },
      { key: 'arguments', value: '{}' },
    ]);
  });

  it('falls back to the raw input when question has an empty questions array', () => {
    const result = detail('question', completed({ questions: [] }, ''));

    expect(result.fields).toEqual([{ key: 'questions', value: '[]' }]);
  });

  it('keeps an empty projection for empty input', () => {
    const result = detail('custom', completed({}, ''));

    expect(result.fields).toEqual([]);
  });

  it('does not fall back when the projection produced fields', () => {
    const result = detail(
      'mcp',
      completed({ server_name: 's', tool_name: 't', arguments: { query: 'hi' } }, '')
    );

    expect(result.fields).toEqual([{ key: 'query', value: 'hi' }]);
  });
});

describe('buildToolDetailSummary', () => {
  it('returns the same name and summary as buildToolDetail', () => {
    const part = {
      tool: 'lookup',
      state: pending({ description: 'Find matching records', count: 0 }),
    };
    const full = detail('lookup', part.state);

    expect(buildToolDetailSummary(part)).toEqual({ name: full.name, summary: full.summary });
    expect(full.name).toBe('lookup');
    expect(full.summary).toBe('Find matching records · count=0');
  });

  it('uses the question text for a question part', () => {
    const part = {
      tool: 'question',
      state: pending({ questions: [{ question: 'Which one?' }] }),
    };

    expect(buildToolDetailSummary(part)).toEqual({ name: 'question', summary: 'Which one?' });
  });

  it('does not parse or pretty-print the completed output', () => {
    const output = '{"b":2}';
    const part = { tool: 'lookup', state: completed({ a: 1 }, output) };
    const parse = vi.spyOn(JSON, 'parse');

    try {
      expect(buildToolDetailSummary(part)).toEqual({ name: 'lookup', summary: 'a=1' });
      expect(parse.mock.calls.some(([text]) => text === output)).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('formatToolDetailOutput', () => {
  it('pretty-prints a JSON object', () => {
    expect(formatToolDetailOutput('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', isJson: true });
  });

  it('pretty-prints a JSON array', () => {
    expect(formatToolDetailOutput('[1,2]')).toEqual({ text: '[\n  1,\n  2\n]', isJson: true });
  });

  it('returns non-JSON text raw', () => {
    expect(formatToolDetailOutput('not json')).toEqual({ text: 'not json', isJson: false });
  });

  it('returns a JSON scalar raw', () => {
    expect(formatToolDetailOutput('123')).toEqual({ text: '123', isJson: false });
  });

  it('returns pretty text over the size cap raw', () => {
    const raw = JSON.stringify({ s: 'x'.repeat(25000) });
    expect(formatToolDetailOutput(raw)).toEqual({ text: raw, isJson: false });
  });

  it('returns a number literal that cannot round-trip raw', () => {
    const raw = '{"id":12345678901234567890}';
    expect(formatToolDetailOutput(raw)).toEqual({ text: raw, isJson: false });
  });

  it('keeps a number literal that round-trips pretty-printed', () => {
    expect(formatToolDetailOutput('{"id":42}')).toEqual({ text: '{\n  "id": 42\n}', isJson: true });
  });
});

describe('buildToolDetail output and error', () => {
  it('formats completed output', () => {
    const result = detail('custom', completed({ a: 1 }, '{"b":2}'));

    expect(result.output).toEqual({ text: '{\n  "b": 2\n}', isJson: true });
  });

  it('has no output when completed output is blank', () => {
    const result = detail('custom', completed({ a: 1 }, '   '));

    expect(result.output).toBeUndefined();
  });

  it('surfaces the error state', () => {
    const result = detail('custom', errored({ a: 1 }, 'boom'));

    expect(result.status).toBe('error');
    expect(result.error).toBe('boom');
    expect(result.output).toBeUndefined();
  });

  it('has no error on a completed part', () => {
    const result = detail('custom', completed({ a: 1 }, 'done'));

    expect(result.error).toBeUndefined();
  });

  it('returns an empty projection for empty input', () => {
    const result = detail('custom', pending({}));

    expect(result).toEqual({
      status: 'pending',
      name: 'custom',
      arguments: {},
      fields: [],
    });
  });
});
