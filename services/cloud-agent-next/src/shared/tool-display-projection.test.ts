import { describe, expect, it } from 'vitest';
import {
  projectKilo2MessageForDisplay,
  projectKilocodeEventForDisplay,
  projectToolPartForDisplay,
  TOOL_FIELD_PREVIEW_BYTES,
  TOOL_OUTPUT_PREVIEW_BYTES,
  utf8Preview,
  type ToolDetailMarker,
} from './tool-display-projection.js';

const encoder = new TextEncoder();
const bytes = (value: unknown) =>
  encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;

function toolPart(input: {
  id?: string;
  tool?: string;
  status?: 'pending' | 'running' | 'completed' | 'error';
  output?: string;
  toolInput?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  const status = input.status ?? 'completed';
  return {
    id: input.id ?? 'prt_1',
    messageID: 'msg_1',
    sessionID: 'ses_1',
    type: 'tool',
    callID: 'call_1',
    tool: input.tool ?? 'bash',
    state: {
      status,
      input: input.toolInput ?? { command: 'ls' },
      ...(status === 'completed' ? { output: input.output ?? '', title: 'ls' } : {}),
      ...(status === 'error' ? { error: input.output ?? 'failed' } : {}),
      metadata: input.metadata ?? {},
      time: { start: 1, end: 2 },
    },
  };
}

function markerOf(value: unknown): ToolDetailMarker | undefined {
  return (value as { cloudDetail?: ToolDetailMarker }).cloudDetail;
}

describe('utf8Preview', () => {
  it('keeps strings that fit', () => {
    expect(utf8Preview('hello', 5)).toBeUndefined();
    expect(utf8Preview('é'.repeat(10), 20)).toBeUndefined();
  });

  it('cuts on code point boundaries', () => {
    expect(utf8Preview('aé', 2)).toBe('a');
    expect(utf8Preview('a😀b', 4)).toBe('a');
    expect(utf8Preview('a😀b', 5)).toBe('a😀');
    const preview = utf8Preview('你好'.repeat(2000), 1001);
    expect(preview).toBeDefined();
    expect(bytes(preview)).toBeLessThanOrEqual(1001);
    expect(bytes(preview)).toBeGreaterThan(997);
  });
});

describe('projectToolPartForDisplay', () => {
  it('leaves small completed tools untouched', () => {
    const part = toolPart({ output: 'small output' });
    expect(projectToolPartForDisplay(part, 7)).toBe(part);
  });

  it('leaves running, pending, failed and non-tool parts untouched', () => {
    const large = 'x'.repeat(TOOL_OUTPUT_PREVIEW_BYTES * 4);
    for (const status of ['pending', 'running', 'error'] as const) {
      const part = toolPart({ status, output: large, toolInput: { command: large } });
      expect(projectToolPartForDisplay(part, 1)).toBe(part);
    }
    const text = { id: 'prt_t', type: 'text', text: large };
    expect(projectToolPartForDisplay(text, 1)).toBe(text);
  });

  it('bounds output, input and metadata strings and marks every omission', () => {
    const output = 'line\n'.repeat(10_000);
    const content = 'c'.repeat(TOOL_FIELD_PREVIEW_BYTES + 1);
    const part = toolPart({
      tool: 'write',
      output,
      toolInput: { filePath: '/repo/a.ts', content, todos: [{ content: 'keep' }] },
      metadata: { sessionId: 'ses_child', filediff: { patch: content, additions: 3 } },
    });
    const projected = projectToolPartForDisplay(part, 42) as ReturnType<typeof toolPart>;
    expect(bytes(projected.state.output)).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_BYTES);
    expect(output.startsWith(projected.state.output ?? '')).toBe(true);
    expect(projected.state.input.filePath).toBe('/repo/a.ts');
    expect(projected.state.input.todos).toBe(part.state.input.todos);
    expect(bytes(projected.state.input.content)).toBe(TOOL_FIELD_PREVIEW_BYTES);
    expect(projected.state.metadata).toMatchObject({
      sessionId: 'ses_child',
      filediff: { additions: 3 },
    });
    expect(markerOf(projected)).toEqual({
      version: 1,
      revision: 42,
      omitted: ['output', 'input.content', 'metadata.filediff.patch'],
      omittedCount: 3,
      omittedBytes: bytes(output) + bytes(content) * 2,
    });
    // The stored part is not mutated.
    expect(part.state.output).toBe(output);
  });

  it('keeps apply_patch file paths for collapsed rows', () => {
    const body = '+'.repeat(TOOL_FIELD_PREVIEW_BYTES);
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      body,
      '*** Add File: src/b.ts',
      body,
      '*** Delete File: src/c.ts',
      '*** End Patch',
    ].join('\n');
    const projected = projectToolPartForDisplay(
      toolPart({ tool: 'apply_patch', toolInput: { patchText }, output: 'Done' }),
      3
    );
    expect(markerOf(projected)?.summary).toEqual({ paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  });

  it('bounds the omitted path list', () => {
    const large = 'x'.repeat(TOOL_FIELD_PREVIEW_BYTES + 1);
    const toolInput = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, large]));
    const marker = markerOf(projectToolPartForDisplay(toolPart({ toolInput }), 1));
    expect(marker?.omitted).toHaveLength(32);
    expect(marker?.omittedCount).toBe(40);
  });
});

describe('projectKilo2MessageForDisplay', () => {
  it('shares the output budget across text entries and marks the tool entry', () => {
    const first = 'a'.repeat(3000);
    const second = 'b'.repeat(3000);
    const message = {
      id: 'msg_1',
      type: 'assistant',
      time: { created: 1 },
      content: [
        { type: 'text', text: 'x'.repeat(TOOL_OUTPUT_PREVIEW_BYTES * 2) },
        {
          type: 'tool',
          id: 'call_1',
          name: 'shell',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            content: [
              { type: 'text', text: first },
              { type: 'file', uri: 'media:x', mime: 'image/png' },
              { type: 'text', text: second },
            ],
          },
        },
        {
          type: 'tool',
          id: 'call_2',
          name: 'shell',
          state: { status: 'running', input: { command: 'x'.repeat(10_000) } },
        },
      ],
    };
    const projected = projectKilo2MessageForDisplay(message, 9) as typeof message;
    // Assistant text is never shortened.
    expect(projected.content[0]).toBe(message.content[0]);
    expect(projected.content[2]).toBe(message.content[2]);
    const tool = projected.content[1] as (typeof message.content)[1] & {
      state: { content: Array<{ text?: string }> };
    };
    expect(tool.state.content[0]?.text).toBe(first);
    expect(tool.state.content[1]).toBe(message.content[1]?.state?.content?.[1]);
    expect(bytes(tool.state.content[2]?.text)).toBe(TOOL_OUTPUT_PREVIEW_BYTES - 3000);
    expect(markerOf(tool)).toMatchObject({ revision: 9, omitted: ['content.2.text'] });
  });

  it('returns the same message when nothing is shortened', () => {
    const message = { id: 'msg_1', type: 'assistant', time: { created: 1 }, content: [] };
    expect(projectKilo2MessageForDisplay(message, 1)).toBe(message);
  });
});

describe('projectKilocodeEventForDisplay', () => {
  it('projects part and native message events only', () => {
    const large = 'x'.repeat(TOOL_OUTPUT_PREVIEW_BYTES * 2);
    const partEvent = {
      type: 'message.part.updated',
      event: 'message.part.updated',
      properties: { part: toolPart({ output: large }) },
    };
    const projected = projectKilocodeEventForDisplay(partEvent, 5) as typeof partEvent;
    expect(markerOf(projected.properties.part)?.revision).toBe(5);
    const other = { type: 'session.updated', properties: { info: { title: large } } };
    expect(projectKilocodeEventForDisplay(other, 5)).toBe(other);
  });
});

/**
 * Payload-budget regression over representative fixtures. Byte totals are
 * logged with `TOOL_PAYLOAD_REPORT=1` for the measurement record.
 */
describe('tool display payload budget', () => {
  const page = (parts: unknown[]) => ({ messages: [{ info: { id: 'msg_1' }, parts }] });
  const project = (parts: unknown[]) => parts.map(part => projectToolPartForDisplay(part, 1));
  const fixtures: Record<string, unknown[]> = {
    'text only (20 x 1.5 KiB)': Array.from({ length: 20 }, (_, i) => ({
      id: `prt_${i}`,
      type: 'text',
      text: 'word '.repeat(300),
    })),
    'many small tools (60 x 400 B)': Array.from({ length: 60 }, (_, i) =>
      toolPart({ id: `prt_${i}`, output: 'o'.repeat(400) })
    ),
    'large reads (20 x 50 KiB)': Array.from({ length: 20 }, (_, i) =>
      toolPart({
        id: `prt_${i}`,
        tool: 'read',
        toolInput: { filePath: `/repo/file-${i}.ts` },
        output: `${i}: const value = compute();\n`.repeat(1800),
      })
    ),
    'large commands and patches (10 x 30 KiB out, 20 KiB patch)': Array.from(
      { length: 10 },
      (_, i) =>
        toolPart({
          id: `prt_${i}`,
          tool: 'apply_patch',
          toolInput: { patchText: `*** Update File: f${i}.ts\n${'+line\n'.repeat(3400)}` },
          output: 'test output line\n'.repeat(1800),
        })
    ),
  };

  it('keeps small payloads byte-identical and bounds large tool payloads', () => {
    const rows = Object.entries(fixtures).map(([name, parts]) => {
      const full = bytes(page(parts));
      const preview = bytes(page(project(parts)));
      return { name, full, preview, ratio: Number((preview / full).toFixed(3)) };
    });
    if (process.env.TOOL_PAYLOAD_REPORT === '1')
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    const [text, small, reads, patches] = rows;
    expect(text?.preview).toBe(text?.full);
    expect(small?.preview).toBe(small?.full);
    // Each large completed tool costs at most its previews plus a small marker.
    expect(reads?.preview).toBeLessThan(20 * (TOOL_OUTPUT_PREVIEW_BYTES + 1024));
    expect(patches?.preview).toBeLessThan(
      10 * (TOOL_OUTPUT_PREVIEW_BYTES + TOOL_FIELD_PREVIEW_BYTES + 1536)
    );
  });
});
