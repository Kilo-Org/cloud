import { describe, expect, it, vi } from 'vitest';
import {
  kiloSdkPartSchema,
  partIdSchema,
  type Kilo2Message,
} from '@kilocode/session-ingest-contracts';
import type { Env } from '../types.js';
import { readPublicV2History } from './persisted-v2-history.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixture() {
  const getSessionMessagesPage = vi.fn();
  const env = {
    SANDBOX_SESSION: {
      idFromName: vi.fn(),
      get: vi.fn(() => ({ getSessionMessagesPage })),
    },
  } as unknown as Env;
  return {
    getSessionMessagesPage,
    input: { env, userId: 'owner', kiloSessionId, cloudAgentSessionId, query: {} },
  };
}

function page(messages: Kilo2Message[] = []) {
  return {
    source: {
      version: 'v2',
      session: {
        id: kiloSessionId,
        location: { directory: '/workspace/private' },
        time: { created: 1, updated: 2 },
      },
    },
    messages: messages.map(message => ({ message })),
    omittedItemCount: 0,
    nextCursor: null,
  };
}

describe('public v2 history compatibility and failures', () => {
  it('assembles a full unbounded transcript oldest first across internal pages', async () => {
    const f = fixture();
    f.getSessionMessagesPage
      .mockResolvedValueOnce({
        ...page([{ id: 'msg_new', type: 'user', text: 'new', time: { created: 2 } }]),
        nextCursor: 'older',
      })
      .mockResolvedValueOnce(
        page([{ id: 'msg_old', type: 'user', text: 'old', time: { created: 1 } }])
      );
    const result = await readPublicV2History(f.input);
    expect(result).toMatchObject({
      kind: 'success',
      messages: [{ info: { id: 'msg_old' } }, { info: { id: 'msg_new' } }],
      nextCursor: null,
    });
    expect(f.getSessionMessagesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: 'older',
        expectedRootKiloSessionId: kiloSessionId,
        toolDisplay: 'full',
      })
    );
  });

  it.each([
    null,
    {},
    { ...page(), source: { version: 'v1' } },
    {
      ...page(),
      source: { ...page().source, session: { ...page().source.session, id: 'ses_wrong' } },
    },
  ])('does not turn missing or invalid history into empty success: %j', async raw => {
    const f = fixture();
    f.getSessionMessagesPage.mockResolvedValue(raw);
    expect(await readPublicV2History(f.input)).toEqual({
      kind: raw === null ? 'not_found' : 'invalid_data',
    });
  });

  it('fails rather than returning a partial transcript when an older read fails', async () => {
    const f = fixture();
    f.getSessionMessagesPage
      .mockResolvedValueOnce({
        ...page([{ id: 'msg_new', type: 'user', text: 'new', time: { created: 2 } }]),
        nextCursor: 'older',
      })
      .mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await readPublicV2History(f.input)).toEqual({ kind: 'retryable_failure' });
  });

  it('rejects an oversized unbounded transcript at the existing 8 MiB public budget', async () => {
    const f = fixture();
    const large = page([
      { id: 'msg_large', type: 'user', text: 'x'.repeat(3 * 1024 * 1024), time: { created: 1 } },
    ]);
    f.getSessionMessagesPage
      .mockResolvedValueOnce({ ...large, nextCursor: 'page2' })
      .mockResolvedValueOnce({ ...large, nextCursor: 'page3' })
      .mockResolvedValueOnce(large);
    expect(await readPublicV2History(f.input)).toEqual({ kind: 'too_large' });
  });

  it('does not report empty when stored rows were omitted for size', async () => {
    const f = fixture();
    f.getSessionMessagesPage.mockResolvedValue({ ...page(), omittedItemCount: 1 });
    expect(await readPublicV2History(f.input)).toEqual({ kind: 'too_large' });
  });

  it('preserves compaction marker, summary and native content identities', async () => {
    const f = fixture();
    f.getSessionMessagesPage.mockResolvedValue(
      page([
        {
          id: 'msg_compaction',
          type: 'compaction',
          status: 'completed',
          summary: 'saved summary',
          time: { created: 1 },
          content: [{ type: 'text', text: 'native content' }],
        },
      ])
    );
    const result = await readPublicV2History(f.input);
    expect(result).toMatchObject({
      kind: 'success',
      messages: [
        {
          info: { id: 'msg_compaction', parentID: '', summary: true },
          parts: [
            { id: 'msg_compaction_000000', type: 'compaction' },
            { id: 'msg_compaction_000000_summary', type: 'text', text: 'saved summary' },
            { id: 'msg_compaction_000001', type: 'text', text: 'native content' },
          ],
        },
      ],
    });
  });

  it('fails explicitly when a media reference cannot be projected without authorized bytes', async () => {
    const f = fixture();
    f.getSessionMessagesPage.mockResolvedValue(
      page([
        {
          id: 'msg_file',
          type: 'user',
          time: { created: 1 },
          files: [
            { mime: 'image/png', source: { type: 'inline' }, uri: `media:${'a'.repeat(64)}` },
          ],
        },
      ])
    );
    expect(await readPublicV2History(f.input)).toEqual({ kind: 'invalid_data' });
  });

  it.each(['msg_answer_000000', 'msg_answer_000000_summary', 'msg_answer_000001_file_0'])(
    'validates derived display IDs without allowing them as ingest write IDs: %s',
    id => {
      expect(
        kiloSdkPartSchema.safeParse({
          id,
          sessionID: kiloSessionId,
          messageID: 'msg_answer',
          type: 'text',
          text: 'display',
        }).success
      ).toBe(true);
      expect(partIdSchema.safeParse(id).success).toBe(false);
    }
  );

  it.each(['msg_answer', 'msg_answer_00000', 'msg_answer/other_000000', 'msg_answer\u0000_000000'])(
    'rejects non-derived or unsafe display IDs: %s',
    id => {
      expect(
        kiloSdkPartSchema.safeParse({
          id,
          sessionID: kiloSessionId,
          messageID: 'msg_answer',
          type: 'text',
          text: 'display',
        }).success
      ).toBe(false);
    }
  );
});
