import { createMemoryStorage } from './memory';
import type { SessionStorage } from './types';
import type { Part } from '@kilocode/app-shared/opencode';
import type { MessageInfo } from '../types';

function makeMsg(id: string, role: 'user' | 'assistant' = 'user'): MessageInfo {
  return {
    id,
    sessionID: 'ses-1',
    role,
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'a', modelID: 'b' },
  } as MessageInfo;
}

function makePart(id: string, messageId: string, text = ''): Part {
  return { id, sessionID: 'ses-1', messageID: messageId, type: 'text', text } as Part;
}

function makeToolPart(
  id: string,
  status: 'running' | 'completed',
  time: { start: number; end?: number }
): Part {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'task',
    state:
      status === 'running'
        ? { status, input: {}, raw: '', time }
        : { status, input: {}, raw: '', output: 'done', title: 'task', metadata: {}, time },
  } as unknown as Part;
}

describe('createMemoryStorage', () => {
  let s: SessionStorage;

  beforeEach(() => {
    s = createMemoryStorage();
  });

  describe('upsertMessage', () => {
    test('new message is added to messageIds', () => {
      s.upsertMessage(makeMsg('msg-1'));
      expect(s.getMessageIds()).toEqual(['msg-1']);
    });

    test('existing message updates without changing messageIds', () => {
      s.upsertMessage(makeMsg('msg-1'));
      s.upsertMessage(makeMsg('msg-1', 'assistant'));
      expect(s.getMessageIds()).toEqual(['msg-1']);
      expect(s.getMessageInfo('msg-1')?.role).toBe('assistant');
    });

    test('messages are sorted by ID', () => {
      s.upsertMessage(makeMsg('c'));
      s.upsertMessage(makeMsg('a'));
      s.upsertMessage(makeMsg('b'));
      expect(s.getMessageIds()).toEqual(['a', 'b', 'c']);
    });

    test('getMessageIds does not expose mutable internal state', () => {
      s.upsertMessage(makeMsg('a'));
      s.upsertMessage(makeMsg('b'));

      const ids = s.getMessageIds();
      ids.push('z');

      expect(s.getMessageIds()).toEqual(['a', 'b']);
    });
  });

  describe('getMessageInfo', () => {
    test('returns info for existing message', () => {
      const msg = makeMsg('msg-1');
      s.upsertMessage(msg);
      expect(s.getMessageInfo('msg-1')).toBe(msg);
    });

    test('returns undefined for non-existent message', () => {
      expect(s.getMessageInfo('nope')).toBeUndefined();
    });
  });

  describe('upsertPart', () => {
    test('new part is added', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'hello'));
      expect(s.getParts('msg-1')).toHaveLength(1);
      expect(s.getParts('msg-1')[0].id).toBe('p-1');
    });

    test('existing part is replaced', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'old'));
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'new'));
      const parts = s.getParts('msg-1');
      expect(parts).toHaveLength(1);
      expect((parts[0] as Part & { text: string }).text).toBe('new');
    });

    test('parts are sorted by ID', () => {
      s.upsertPart('msg-1', makePart('c', 'msg-1'));
      s.upsertPart('msg-1', makePart('a', 'msg-1'));
      s.upsertPart('msg-1', makePart('b', 'msg-1'));
      const ids = s.getParts('msg-1').map(p => p.id);
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    test('drops stale synthetic optimistic text part when real text part arrives', () => {
      const syntheticPart = { ...makePart('msg-1-text', 'msg-1', 'hello'), synthetic: true };
      s.upsertPart('msg-1', syntheticPart);
      s.upsertPart('msg-1', makePart('prt-real', 'msg-1', 'hello'));

      const parts = s.getParts('msg-1');
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual(expect.objectContaining({ id: 'prt-real', text: 'hello' }));
    });

    test('keeps a running tool part live when a stale terminal replays through the backend', () => {
      // The accepted update's ordering evidence lives in the backend's own
      // store, keyed by the part id: a running update ingested at t=200, a
      // no-event-time re-delivery of the same run, then an out-of-order
      // terminal (event time 150) must not settle the part.
      s.upsertPart('msg-1', makeToolPart('p-1', 'running', { start: 1 }), 200);
      s.upsertPart('msg-1', makeToolPart('p-1', 'running', { start: 1 }));
      s.upsertPart('msg-1', makeToolPart('p-1', 'completed', { start: 1, end: 150 }), 150);

      const parts = s.getParts('msg-1');
      const part = parts.find(p => p.id === 'p-1');
      expect(part?.type).toBe('tool');
      expect(part?.type === 'tool' ? part.state.status : undefined).toBe('running');
    });

    test('drops a deleted part’s ordering evidence with the part', () => {
      s.upsertPart('msg-1', makeToolPart('p-1', 'running', { start: 1 }), 200);
      s.deletePart('msg-1', 'p-1');
      // The removal took the part's evidence with it, so a re-delivered update
      // is ordered by the part's own state times, not the deleted part's event
      // time (150 postdates this run's start of 1).
      s.upsertPart('msg-1', makeToolPart('p-1', 'completed', { start: 1, end: 150 }), 150);

      const parts = s.getParts('msg-1');
      const part = parts.find(p => p.id === 'p-1');
      expect(part?.type === 'tool' ? part.state.status : undefined).toBe('completed');
    });
  });

  describe('applyPartDelta', () => {
    test('appends delta to text', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'hel'));
      s.applyPartDelta('msg-1', 'p-1', 'text', 'lo');
      const parts = s.getParts('msg-1');
      expect(parts[0]).toEqual(expect.objectContaining({ text: 'hello' }));
    });

    test('creates part if part does not exist for message', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      s.applyPartDelta('msg-1', 'new-part', 'text', 'delta');
      expect(s.getParts('msg-1')).toHaveLength(2);
      expect(s.getParts('msg-1').find(p => p.id === 'new-part')).toEqual(
        expect.objectContaining({ text: 'delta' })
      );
    });

    test('creates part if message has no parts yet', () => {
      s.applyPartDelta('no-msg', 'p-1', 'text', 'delta');
      expect(s.getParts('no-msg')).toHaveLength(1);
      expect(s.getParts('no-msg')[0]).toEqual(
        expect.objectContaining({ id: 'p-1', text: 'delta' })
      );
    });

    test('ignores unsupported delta fields', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'hello'));

      s.applyPartDelta('msg-1', 'p-1', 'unsupportedField', 'x');

      expect(s.getParts('msg-1')[0]).toEqual(expect.objectContaining({ id: 'p-1', text: 'hello' }));
      expect(s.getParts('msg-1')[0]).not.toHaveProperty('unsupportedField');
    });

    test('does not allow applyPartDelta to mutate structural identifiers', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'hello'));

      s.applyPartDelta('msg-1', 'p-1', 'id', '-mutated');

      expect(s.getParts('msg-1')[0]).toEqual(
        expect.objectContaining({ id: 'p-1', messageID: 'msg-1' })
      );
    });
  });

  describe('deletePart', () => {
    test('removes the part', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      s.upsertPart('msg-1', makePart('p-2', 'msg-1'));
      s.deletePart('msg-1', 'p-1');
      const ids = s.getParts('msg-1').map(p => p.id);
      expect(ids).toEqual(['p-2']);
    });

    test('no-op if part does not exist', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      s.deletePart('msg-1', 'missing');
      expect(s.getParts('msg-1')).toHaveLength(1);
    });
  });

  describe('getParts', () => {
    test('returns empty array for unknown messageId', () => {
      expect(s.getParts('unknown')).toEqual([]);
    });

    test('returns stable reference for unchanged parts', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      const first = s.getParts('msg-1');
      const second = s.getParts('msg-1');
      expect(first).toBe(second);
    });

    test('returns new reference after mutation', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      const first = s.getParts('msg-1');
      s.upsertPart('msg-1', makePart('p-2', 'msg-1'));
      const second = s.getParts('msg-1');
      expect(first).not.toBe(second);
    });

    test('mutating returned part objects does not mutate storage state', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'hello'));

      const returnedParts = s.getParts('msg-1');
      (returnedParts[0] as Part & { text: string }).text = 'mutated';

      expect(s.getParts('msg-1')[0]).toEqual(expect.objectContaining({ text: 'hello' }));
    });
  });

  describe('subscribe', () => {
    test('messageIds subscription fires on new message insert', () => {
      const cb = jest.fn();
      s.subscribe('messageIds', cb);
      s.upsertMessage(makeMsg('msg-1'));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('messageIds subscription does NOT fire on message update', () => {
      s.upsertMessage(makeMsg('msg-1'));
      const cb = jest.fn();
      s.subscribe('messageIds', cb);
      s.upsertMessage(makeMsg('msg-1', 'assistant'));
      expect(cb).not.toHaveBeenCalled();
    });

    test('message:{id} subscription fires on message update', () => {
      s.upsertMessage(makeMsg('msg-1'));
      const cb = jest.fn();
      s.subscribe('message:msg-1', cb);
      s.upsertMessage(makeMsg('msg-1', 'assistant'));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('parts:{messageId} subscription fires on part upsert', () => {
      const cb = jest.fn();
      s.subscribe('parts:msg-1', cb);
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('parts:{messageId} subscription fires on applyPartDelta', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1', 'hi'));
      const cb = jest.fn();
      s.subscribe('parts:msg-1', cb);
      s.applyPartDelta('msg-1', 'p-1', 'text', '!');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('parts:{messageId} subscription fires on deletePart', () => {
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));
      const cb = jest.fn();
      s.subscribe('parts:msg-1', cb);
      s.deletePart('msg-1', 'p-1');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('unsubscribe stops notifications', () => {
      const cb = jest.fn();
      const unsub = s.subscribe('messageIds', cb);
      unsub();
      s.upsertMessage(makeMsg('msg-1'));
      expect(cb).not.toHaveBeenCalled();
    });

    test('subscription for one message does not fire for another', () => {
      const cb = jest.fn();
      s.subscribe('parts:msg-1', cb);
      s.upsertPart('msg-2', makePart('p-1', 'msg-2'));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    test('resets all state', () => {
      s.upsertMessage(makeMsg('msg-1'));
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));

      s.clear();

      expect(s.getMessageIds()).toEqual([]);
      expect(s.getMessageInfo('msg-1')).toBeUndefined();
      expect(s.getParts('msg-1')).toEqual([]);
    });

    test('fires messageIds subscriber', () => {
      const msgCb = jest.fn();
      s.subscribe('messageIds', msgCb);

      s.clear();

      expect(msgCb).toHaveBeenCalledTimes(1);
    });

    test('notifies granular subscribers for existing message and parts keys', () => {
      s.upsertMessage(makeMsg('msg-1'));
      s.upsertPart('msg-1', makePart('p-1', 'msg-1'));

      const messageCb = jest.fn();
      const partsCb = jest.fn();
      s.subscribe('message:msg-1', messageCb);
      s.subscribe('parts:msg-1', partsCb);

      s.clear();

      expect(messageCb).toHaveBeenCalledTimes(1);
      expect(partsCb).toHaveBeenCalledTimes(1);
    });
  });
});
