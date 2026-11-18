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

  test('degrades a native detail with an unresolved attachment to absent', () => {
    const source = {
      version: 'v2' as const,
      session: {
        id: 'ses_native',
        location: { directory: '/workspace/app' },
        time: { created: 1, updated: 2 },
      },
    };
    const message = {
      id: 'msg_unresolved_detail',
      type: 'assistant',
      time: { created: 1 },
      content: [
        {
          type: 'tool',
          id: 'call_unresolved',
          name: 'browser',
          state: {
            status: 'completed',
            input: {},
            content: [
              { type: 'file', uri: 'media:///private/shot.png', mime: 'image/png' },
              { type: 'text', text: 'browser result' },
            ],
          },
        },
      ],
    };
    const projectedPreview = cloudSessionMessagesPageSchema.parse({
      kind: 'success',
      source,
      info: { id: 'ses_native' },
      messages: [{ message }],
      nextCursor: null,
      omittedItemCount: 1,
      updateCursor: 12,
      totalCostMicrodollars: 0,
    });
    // The history page already omits this message, so the detail request is
    // exercised with the same message a page would have projected when the
    // attachment resolved; the unresolved detail response must stay absent.
    expect(projectedPreview?.messages).toHaveLength(0);
    expect(
      readToolPartDetail({ kind: 'found', source, revision: 12, message }, {
        id: 'msg_unresolved_detail',
        messageID: 'msg_unresolved_detail',
        sessionID: 'ses_native',
        type: 'tool',
        callID: 'call_unresolved',
        tool: 'browser',
        state: {
          status: 'completed',
          input: {},
          output: 'browser preview',
          title: 'browser',
          metadata: {},
          time: { start: 1, end: 2 },
        },
        cloudDetail: {
          version: 1,
          revision: 12,
          omitted: ['output'],
          omittedCount: 1,
          omittedBytes: 10,
        },
      } as Part)
    ).toEqual({ kind: 'not_found' });
  });

  test('degrades a native detail whose user file is storage-free to absent', () => {
    const source = {
      version: 'v2' as const,
      session: {
        id: 'ses_native',
        location: { directory: '/workspace/app' },
        time: { created: 1, updated: 2 },
      },
    };
    // A user file with neither bytes nor a uri cannot project, and the
    // per-message schema rejects it before the guard: the detail response must
    // still stay absent instead of failing the caller.
    const detail = readToolPartDetail(
      {
        kind: 'found',
        source,
        revision: 12,
        message: {
          id: 'msg_storage_free_detail',
          type: 'user',
          time: { created: 1 },
          text: 'attached',
          files: [{ mime: 'image/png', source: { type: 'inline' } }],
        },
      },
      {
        id: 'msg_storage_free_detail',
        messageID: 'msg_storage_free_detail',
        sessionID: 'ses_native',
        type: 'tool',
        callID: 'call_storage_free',
        tool: 'browser',
        state: {
          status: 'completed',
          input: {},
          output: 'browser preview',
          title: 'browser',
          metadata: {},
          time: { start: 1, end: 2 },
        },
        cloudDetail: {
          version: 1,
          revision: 12,
          omitted: ['output'],
          omittedCount: 1,
          omittedBytes: 10,
        },
      } as Part
    );
    expect(detail).toEqual({ kind: 'not_found' });
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

  test('a preview whose state cannot be read is not a preview of the stored call', () => {
    const stateOnlyPreview = {
      ...tool({ cloudDetail: marker }),
      state: { status: 'completed' },
    } as unknown as Part;
    expect(() => isPreviewOfStoredTool(tool(), stateOnlyPreview)).not.toThrow();
    expect(isPreviewOfStoredTool(tool(), stateOnlyPreview)).toBe(false);
  });
});
