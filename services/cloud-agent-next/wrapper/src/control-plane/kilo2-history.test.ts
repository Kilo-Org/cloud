import { describe, expect, it } from 'bun:test';
import { MAX_RESTORE_MESSAGES, restoreKilo2History } from './kilo2-history.js';
import type { Kilo2Api } from './kilo2-api.js';

const SESSION_ID = `ses_${'a'.repeat(26)}`;

function fakeApi() {
  const calls: string[] = [];
  const imported: unknown[] = [];
  const api: Kilo2Api = {
    async request(path, options) {
      calls.push(`${options?.method ?? 'GET'} ${path.split('?')[0]}`);
      if (path.startsWith('/api/location')) return { project: { id: 'project-1' } };
      if (path === '/api/experimental/session/import') imported.push(options?.body);
      return undefined;
    },
    async data() {
      throw new Error('unused api.data');
    },
  };
  return { api, calls, imported };
}

function message(id: string, created: number, type = 'user') {
  return { message: { id, type, time: { created }, text: `prompt ${id}` } };
}

function v2Page(messages: unknown[], nextCursor: string | null, id = SESSION_ID) {
  return {
    kind: 'success',
    source: { version: 'v2', session: { id } },
    info: { id },
    messages,
    nextCursor,
    omittedItemCount: 0,
  };
}

function input(pages: Record<string, unknown>) {
  const restored: boolean[] = [];
  const reads: Array<string | undefined> = [];
  return {
    restored,
    reads,
    value: {
      sessionId: SESSION_ID,
      directory: '/workspace/app',
      env: {},
      restoreFiles: false,
      onRestore: () => restored.push(true),
      readHistoryPage: async (cursor: string | undefined) => {
        reads.push(cursor);
        return pages[cursor ?? 'first'];
      },
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (failure: unknown) => failure
  );
  if (!(error instanceof Error)) throw new Error('expected a rejection');
  return error.message;
}

describe('restoreKilo2History', async () => {
  it('does not restore without a history reader', async () => {
    const { api, calls } = fakeApi();
    const { readHistoryPage: _unused, ...value } = input({}).value;
    expect(await restoreKilo2History(api, value)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('creates a fresh session when Cloud has no native history yet', async () => {
    const { api, calls } = fakeApi();
    const target = input({
      first: {
        kind: 'success',
        source: { version: 'v1' },
        info: { id: SESSION_ID },
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
      },
    });
    expect(await restoreKilo2History(api, target.value)).toBe(false);
    expect(target.reads).toEqual([undefined]);
    expect(target.restored).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('creates a fresh session when Cloud has only v1 history', async () => {
    const { api, calls } = fakeApi();
    const target = input({
      first: {
        kind: 'success',
        source: { version: 'v1' },
        info: { id: SESSION_ID },
        messages: [{ info: { id: 'msg_v1' }, parts: [] }],
        nextCursor: 'older',
        omittedItemCount: 0,
      },
    });
    expect(await restoreKilo2History(api, target.value)).toBe(false);
    expect(target.reads).toEqual([undefined]);
    expect(target.restored).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('imports every page in creation order and reports the restore', async () => {
    const { api, calls, imported } = fakeApi();
    const first = `msg_${'b'.repeat(26)}`;
    const second = `msg_${'c'.repeat(26)}`;
    const target = input({
      first: v2Page([message(second, 9)], 'next'),
      next: v2Page([message(first, 5)], null),
    });
    expect(await restoreKilo2History(api, target.value)).toBe(true);
    expect(target.reads).toEqual([undefined, 'next']);
    expect(target.restored).toEqual([true]);
    expect(calls).toEqual(['GET /api/location', 'POST /api/experimental/session/import']);
    expect(
      (imported[0] as { messages: Array<{ id: string }> }).messages.map(item => item.id)
    ).toEqual([first, second]);
  });

  it('restores the available messages when Cloud omits rows', async () => {
    const { api, imported } = fakeApi();
    const id = `msg_${'b'.repeat(26)}`;
    const target = input({ first: { ...v2Page([message(id, 1)], null), omittedItemCount: 2 } });
    expect(await restoreKilo2History(api, target.value)).toBe(true);
    expect(
      (imported[0] as { messages: Array<{ id: string }> }).messages.map(item => item.id)
    ).toEqual([id]);
  });

  it('starts at a prompt when Cloud omits the first prompt', async () => {
    const { api, imported } = fakeApi();
    const answer = message(`msg_${'b'.repeat(26)}`, 1, 'assistant');
    const synthetic = message(`msg_${'c'.repeat(26)}`, 2, 'synthetic');
    const reply = message(`msg_${'d'.repeat(26)}`, 3, 'assistant');
    const prompt = message(`msg_${'e'.repeat(26)}`, 4);
    const target = input({
      first: { ...v2Page([answer, synthetic, reply, prompt], null), omittedItemCount: 1 },
    });
    expect(await restoreKilo2History(api, target.value)).toBe(true);
    expect(
      (imported[0] as { messages: Array<{ id: string }> }).messages.map(item => item.id)
    ).toEqual([synthetic, reply, prompt].map(item => item.message.id));
  });

  it('restores the newest messages within the budget, starting at a prompt', async () => {
    const { api, imported } = fakeApi();
    const total = MAX_RESTORE_MESSAGES + 200;
    const cut = total - MAX_RESTORE_MESSAGES;
    const id = (index: number) => `msg_${String(index).padStart(26, '0')}`;
    const all = Array.from({ length: total }, (_, index) =>
      message(id(index), index, index === cut ? 'assistant' : 'user')
    );
    const target = input({
      first: v2Page(all.slice(600), 'older'),
      older: v2Page(all.slice(0, 600), null),
    });
    expect(await restoreKilo2History(api, target.value)).toBe(true);
    const ids = (imported[0] as { messages: Array<{ id: string }> }).messages.map(item => item.id);
    // The oldest kept message is an answer whose prompt was cut, so it is not restored.
    expect(ids).toEqual(all.slice(cut + 1).map(item => item.message.id));
  });

  it('fails when a history read fails', async () => {
    const { api, calls } = fakeApi();
    const target = input({});
    target.value.readHistoryPage = async () => {
      throw new Error('History read failed: unavailable');
    };
    expect(await rejection(restoreKilo2History(api, target.value))).toContain(
      'History read failed: unavailable'
    );
    expect(calls).toEqual([]);
  });

  it('rejects a page that belongs to another native session', async () => {
    const { api } = fakeApi();
    const target = input({ first: v2Page([], null, `ses_${'c'.repeat(26)}`) });
    expect(await rejection(restoreKilo2History(api, target.value))).toContain(
      'Cloud history belongs to another native session'
    );
  });

  it('rejects pagination that does not advance', async () => {
    const { api } = fakeApi();
    const target = input({
      first: v2Page([message(`msg_${'b'.repeat(26)}`, 1)], 'loop'),
      loop: v2Page([message(`msg_${'c'.repeat(26)}`, 2)], 'loop'),
    });
    expect(await rejection(restoreKilo2History(api, target.value))).toContain(
      'Cloud history pagination did not advance'
    );
  });
});
