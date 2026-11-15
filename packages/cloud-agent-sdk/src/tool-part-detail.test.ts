import type { Part } from './types';
import { upsertPartDroppingStaleSyntheticParts } from './storage/helpers';
import { cloudSessionMessagesPageSchema } from './cloud-conversation-schemas';
import {
  isPreviewOfStoredTool,
  readToolDetailMarker,
  readToolPartDetail,
  toolPartDetailRequest,
} from './tool-part-detail';

const marker = {
  version: 1,
  revision: 12,
  omitted: ['output'],
  omittedCount: 1,
  omittedBytes: 50_000,
};

function tool(overrides: { output?: string; cloudDetail?: unknown; end?: number } = {}): Part {
  return {
    id: 'prt_1',
    messageID: 'msg_1',
    sessionID: 'ses_1',
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'ls' },
      output: overrides.output ?? 'complete output',
      title: 'ls',
      metadata: {},
      time: { start: 1, end: overrides.end ?? 2 },
    },
    ...(overrides.cloudDetail === undefined ? {} : { cloudDetail: overrides.cloudDetail }),
  } as Part;
}

const preview = tool({ output: 'comp', cloudDetail: marker });

describe('tool detail markers', () => {
  test('reads only valid markers', () => {
    expect(readToolDetailMarker(preview)).toEqual(marker);
    expect(readToolDetailMarker(tool())).toBeUndefined();
    expect(readToolDetailMarker(tool({ cloudDetail: { version: 2 } }))).toBeUndefined();
  });

  test('builds detail requests only for previews', () => {
    expect(toolPartDetailRequest(preview)).toEqual({
      messageId: 'msg_1',
      partId: 'prt_1',
      callId: 'call_1',
    });
    expect(toolPartDetailRequest(tool())).toBeUndefined();
  });
});

describe('readToolPartDetail', () => {
  test('returns the complete v1 part for the requested preview', () => {
    expect(
      readToolPartDetail(
        { kind: 'found', source: { version: 'v1' }, revision: 12, part: tool() },
        preview
      )
    ).toEqual({ kind: 'found', revision: 12, part: tool() });
  });

  test('treats another part, a preview, or a missing row as absent rather than empty', () => {
    const other = { ...tool(), id: 'prt_2' };
    for (const part of [other, preview]) {
      expect(
        readToolPartDetail({ kind: 'found', source: { version: 'v1' }, revision: 1, part }, preview)
      ).toEqual({ kind: 'not_found' });
    }
    expect(readToolPartDetail({ kind: 'not_found' }, preview)).toEqual({ kind: 'not_found' });
    expect(readToolPartDetail({ kind: 'too_large', bytes: 9 }, preview)).toEqual({
      kind: 'too_large',
      bytes: 9,
    });
    expect(() => readToolPartDetail({ kind: 'unexpected' }, preview)).toThrow();
  });

  test('projects native v2 details with the same part identity as history', () => {
    const source = {
      version: 'v2' as const,
      session: {
        id: 'ses_native',
        location: { directory: '/workspace/app' },
        time: { created: 1, updated: 2 },
      },
    };
    const entry = (text: string, cloudDetail?: unknown) => ({
      type: 'tool',
      id: 'call_native',
      name: 'shell',
      state: { status: 'completed', input: { command: 'cat' }, content: [{ type: 'text', text }] },
      time: { created: 1, completed: 2 },
      ...(cloudDetail === undefined ? {} : { cloudDetail }),
    });
    const message = (content: unknown[]) => ({
      id: 'msg_native',
      type: 'assistant',
      time: { created: 1 },
      content,
    });
    const page = cloudSessionMessagesPageSchema.parse({
      kind: 'success',
      source,
      info: { id: 'ses_native' },
      messages: [{ message: message([{ type: 'text', text: 'hi' }, entry('pre', marker)]) }],
      nextCursor: null,
      omittedItemCount: 0,
      updateCursor: 12,
      totalCostMicrodollars: 0,
    });
    const projected = page?.messages[0]?.parts.find(part => part.type === 'tool');
    expect(projected && readToolDetailMarker(projected)).toEqual(marker);
    if (!projected) throw new Error('missing projected tool');
    const detail = readToolPartDetail(
      {
        kind: 'found',
        source,
        revision: 12,
        message: message([{ type: 'text', text: 'hi' }, entry('complete native output')]),
      },
      projected
    );
    expect(detail).toMatchObject({
      kind: 'found',
      part: { id: projected.id, state: { output: 'complete native output' } },
    });
  });
});

describe('preview merge guard', () => {
  test('keeps a complete stored call when a preview of the same call arrives', () => {
    expect(isPreviewOfStoredTool(tool(), preview)).toBe(true);
    const evidence = new Map<string, number>();
    const stored = upsertPartDroppingStaleSyntheticParts([], tool(), undefined, evidence);
    expect(upsertPartDroppingStaleSyntheticParts(stored, preview, undefined, evidence, true)).toBe(
      stored
    );
  });

  test('accepts complete updates and previews of a different settled call', () => {
    expect(isPreviewOfStoredTool(preview, tool())).toBe(false);
    expect(isPreviewOfStoredTool(tool(), tool({ cloudDetail: marker, end: 5 }))).toBe(false);
    expect(isPreviewOfStoredTool(preview, preview)).toBe(false);
    const evidence = new Map<string, number>();
    const stored = upsertPartDroppingStaleSyntheticParts([], preview, undefined, evidence);
    expect(
      upsertPartDroppingStaleSyntheticParts(stored, tool(), undefined, evidence, true)
    ).toEqual([tool()]);
  });
});
