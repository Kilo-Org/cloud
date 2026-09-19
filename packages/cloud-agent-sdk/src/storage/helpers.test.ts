import type { Part } from '@kilocode/app-shared/opencode';
import {
  EMPTY_PARTS,
  applyTextDelta,
  clonePart,
  createReadonlyPartView,
  createSeedTextPart,
  forgetPartUpdateTime,
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
  upsertPartDroppingStaleSyntheticParts,
} from './helpers';

function makePart(id: string, text = '', messageID = 'm'): Part {
  return { id, sessionID: 's', messageID, type: 'text', text } as Part;
}

function makeToolPart(
  id: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  time?: { start: number; end?: number },
  messageID = 'm'
): Part {
  const base = { id, sessionID: 's', messageID, type: 'tool', callID: `call-${id}`, tool: 'task' };
  if (status === 'pending') {
    return { ...base, state: { status, input: {}, raw: '' } } as Part;
  }
  if (status === 'running') {
    return { ...base, state: { status, input: {}, raw: '', time: time ?? { start: 1 } } } as Part;
  }
  return {
    ...base,
    state: {
      status,
      input: {},
      raw: '',
      ...(status === 'completed'
        ? { output: 'done', title: 'task', metadata: {} }
        : { error: 'boom' }),
      time: time ?? { start: 1, end: 2 },
    },
  } as Part;
}

function toolStatus(parts: Part[], id: string): string {
  const part = parts.find(p => p.id === id);
  if (!part || part.type !== 'tool') throw new Error(`tool part ${id} missing`);
  return part.state.status;
}

/**
 * A part persisted through the ingest-frame compaction path: it keeps only
 * `state.status`, so `state.time` is absent even for running/terminal states.
 */
function makeCompactedToolPart(
  id: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  messageID = 'm'
): Part {
  const base = { id, sessionID: 's', messageID, type: 'tool', callID: `call-${id}`, tool: 'task' };
  return {
    ...base,
    state: {
      status,
      input: {},
      ...(status === 'running'
        ? {}
        : status === 'completed'
          ? { output: 'done', title: 'task', metadata: {} }
          : status === 'error'
            ? { error: 'boom' }
            : { raw: '' }),
    },
  } as unknown as Part;
}

/**
 * The backend owns the ordering-evidence store next to its parts array; the
 * suite keeps one per test so a scenario's updates are ordered against each
 * other, exactly as a storage instance orders them.
 */
let orderingEvidence = new Map<string, number>();

beforeEach(() => {
  orderingEvidence = new Map();
});

function upsert(arr: Part[], part: Part, eventTime?: number): Part[] {
  return upsertPartDroppingStaleSyntheticParts(arr, part, eventTime, orderingEvidence);
}

describe('insertSorted', () => {
  test('inserts into empty array', () => {
    expect(insertSorted([], 'b')).toEqual(['b']);
  });

  test('inserts at beginning, middle, and end', () => {
    const arr = ['b', 'd'];
    expect(insertSorted(arr, 'a')).toEqual(['a', 'b', 'd']);
    expect(insertSorted(arr, 'c')).toEqual(['b', 'c', 'd']);
    expect(insertSorted(arr, 'e')).toEqual(['b', 'd', 'e']);
  });

  test('does not mutate input', () => {
    const arr = ['a', 'c'];
    insertSorted(arr, 'b');
    expect(arr).toEqual(['a', 'c']);
  });
});

describe('insertPartSorted', () => {
  test('inserts into empty array', () => {
    const p = makePart('b');
    expect(insertPartSorted([], p)).toEqual([p]);
  });

  test('inserts at beginning, middle, and end', () => {
    const arr = [makePart('b'), makePart('d')];
    expect(insertPartSorted(arr, makePart('a')).map(p => p.id)).toEqual(['a', 'b', 'd']);
    expect(insertPartSorted(arr, makePart('c')).map(p => p.id)).toEqual(['b', 'c', 'd']);
    expect(insertPartSorted(arr, makePart('e')).map(p => p.id)).toEqual(['b', 'd', 'e']);
  });

  test('does not mutate input', () => {
    const arr = [makePart('a'), makePart('c')];
    insertPartSorted(arr, makePart('b'));
    expect(arr).toHaveLength(2);
  });
});

describe('upsertPartDroppingStaleSyntheticParts', () => {
  test('removes stale synthetic text part when real text part arrives', () => {
    const syntheticPart = { ...makePart('msg-1-text', 'optimistic'), synthetic: true };
    const realPart = makePart('prt-real', 'authoritative');

    const result = upsert([syntheticPart], realPart);

    expect(result).toEqual([realPart]);
  });

  test('preserves synthetic text part for a different message when real text part arrives', () => {
    const existingSynthetic = { ...makePart('msg-1-text', 'optimistic', 'msg-1'), synthetic: true };
    const realPart = makePart('prt-real', 'authoritative', 'msg-2');

    const result = upsert([existingSynthetic], realPart);

    expect(result.map(part => part.id)).toEqual(['msg-1-text', 'prt-real']);
  });

  test('preserves synthetic text part when incoming part is synthetic', () => {
    const existingSynthetic = { ...makePart('msg-1-text', 'optimistic'), synthetic: true };
    const incomingSynthetic = { ...makePart('prt-synthetic', 'new'), synthetic: true };

    const result = upsert([existingSynthetic], incomingSynthetic);

    expect(result.map(part => part.id)).toEqual(['msg-1-text', 'prt-synthetic']);
  });

  test('preserves synthetic text part when incoming part is non-text', () => {
    const syntheticPart = { ...makePart('msg-1-text', 'optimistic'), synthetic: true };
    const toolPart = { id: 'tool-1', sessionID: 's', messageID: 'm', type: 'tool' } as Part;

    const result = upsert([syntheticPart], toolPart);

    expect(result.map(part => part.id)).toEqual(['msg-1-text', 'tool-1']);
  });

  test('removes stale synthetic file part when a real file part arrives', () => {
    const syntheticFile = {
      id: 'msg-1-file-0',
      sessionID: 's',
      messageID: 'msg-1',
      type: 'file',
      mime: '',
      url: '',
      synthetic: true,
    } as Part;
    const realFile = {
      id: 'prt-file',
      sessionID: 's',
      messageID: 'msg-1',
      type: 'file',
      mime: 'image/png',
      url: 'https://cdn/file.png',
    } as Part;

    const result = upsert([syntheticFile], realFile);

    expect(result.map(part => part.id)).toEqual(['prt-file']);
  });

  test('preserves synthetic file part for a different message', () => {
    const syntheticFile = {
      id: 'msg-1-file-0',
      sessionID: 's',
      messageID: 'msg-1',
      type: 'file',
      mime: '',
      url: '',
      synthetic: true,
    } as Part;
    const realFile = {
      id: 'prt-file',
      sessionID: 's',
      messageID: 'msg-2',
      type: 'file',
      mime: 'image/png',
      url: 'https://cdn/file.png',
    } as Part;

    const result = upsert([syntheticFile], realFile);

    expect(result.map(part => part.id)).toEqual(['msg-1-file-0', 'prt-file']);
  });
});

describe('tool part lifecycle ordering', () => {
  test('orders by the stored part id and keeps the evidence out of the part', () => {
    const arr = upsert([], makeToolPart('p-1', 'running'), 200);
    const stored = arr[0];
    expect(stored).toBeDefined();
    // The evidence never rides on the part: no added enumerable keys and no
    // symbol properties, so it cannot leak into a serialized or rendered part.
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ['callID', 'id', 'messageID', 'sessionID', 'state', 'tool', 'type'].sort()
    );
    expect(Object.getOwnPropertySymbols(stored ?? {})).toEqual([]);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);

    // The store is keyed by the part's own id, not by its object identity, so a
    // clone a caller hands back still orders against the stored update: an
    // out-of-order running re-delivery loses.
    const cloned = clonePart(stored as Part);
    expect(cloned).not.toBe(stored);
    const result = upsert(arr, cloned, 150);
    expect(toolStatus(result, 'p-1')).toBe('running');
    expect(result).toBe(arr);
  });

  test('forgetting a part drops its ordering evidence with it', () => {
    const arr = upsert([], makeToolPart('p-1', 'running'), 200);
    expect(orderingEvidence.size).toBe(1);
    forgetPartUpdateTime(orderingEvidence, 'm', 'p-1');
    expect(orderingEvidence.size).toBe(0);

    // With the part gone its evidence goes too, so a re-delivered update starts
    // from the part's own `state.time` instead of the removed part's event time.
    const result = upsert(arr, makeToolPart('p-1', 'completed'), 150);
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('drops a terminal update whose event time predates the stored running update', () => {
    const arr = upsert([], makeToolPart('p-1', 'running'), 200);
    const result = upsert(arr, makeToolPart('p-1', 'completed'), 150);
    expect(toolStatus(result, 'p-1')).toBe('running');
    expect(result).toBe(arr);
  });

  test('drops a terminal update that carries no ordering evidence over a live running task', () => {
    const arr = [makeToolPart('p-1', 'running', { start: 1 })];
    const result = upsert(arr, makeCompactedToolPart('p-1', 'completed'));
    expect(toolStatus(result, 'p-1')).toBe('running');
  });

  test('applies a terminal whose settle time postdates the running start with no event time', () => {
    // The wire event time can be absent (schema `time` is optional); the
    // terminal's own `state.time.end` is then the ordering evidence, exactly as
    // in the terminal-vs-terminal branch.
    const arr = [makeToolPart('p-1', 'running', { start: 1 })];
    const result = upsert(arr, makeToolPart('p-1', 'completed', { start: 1, end: 2 }));
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('drops a terminal whose settle time predates the running start with no event time', () => {
    const arr = [makeToolPart('p-1', 'running', { start: 5 })];
    const result = upsert(arr, makeToolPart('p-1', 'completed', { start: 1, end: 2 }));
    expect(toolStatus(result, 'p-1')).toBe('running');
  });

  test('bounds the running guard by the run start when the stored event time is inherited', () => {
    // A terminal settles at 100; a replayed running part (start 200, no event
    // time) replaces it and inherits the older part's recorded update time. A
    // terminal that settled at 150 — before the live run began — must still lose
    // against the run's own start, not the inherited older evidence.
    const terminal = upsert([], makeToolPart('p-1', 'completed', { start: 1, end: 100 }), 100);
    const arr = upsert(terminal, makeToolPart('p-1', 'running', { start: 200 }));
    expect(toolStatus(arr, 'p-1')).toBe('running');

    const result = upsert(arr, makeToolPart('p-1', 'completed', { start: 1, end: 150 }));
    expect(toolStatus(result, 'p-1')).toBe('running');
    expect(result).toBe(arr);
  });

  test('keeps the recorded event time across a no-time re-delivery so a stale terminal still loses', () => {
    const arr = upsert([], makeToolPart('p-1', 'running'), 200);
    const replayed = upsert(arr, makeToolPart('p-1', 'running'));
    const result = upsert(replayed, makeToolPart('p-1', 'completed'), 150);
    expect(toolStatus(result, 'p-1')).toBe('running');
  });

  test('applies a terminal that postdates the event time kept across a no-time re-delivery', () => {
    const arr = upsert([], makeToolPart('p-1', 'running'), 200);
    const replayed = upsert(arr, makeToolPart('p-1', 'running'));
    const result = upsert(replayed, makeToolPart('p-1', 'completed'), 250);
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('applies a terminal update whose event time postdates the stored running update', () => {
    const arr = [makeToolPart('p-1', 'running')];
    const result = upsert(arr, makeToolPart('p-1', 'completed'), 250);
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('drops a stale running update that would downgrade a pending task', () => {
    const arr = upsert([], makeToolPart('p-1', 'pending'), 300);
    const result = upsert(arr, makeToolPart('p-1', 'running'), 100);
    expect(toolStatus(result, 'p-1')).toBe('pending');
  });

  test('pending never overrides running', () => {
    const arr = [makeToolPart('p-1', 'running')];
    const result = upsert(arr, makeToolPart('p-1', 'pending'));
    expect(toolStatus(result, 'p-1')).toBe('running');
  });

  test('running never overrides a terminal state', () => {
    const arr = [makeToolPart('p-1', 'completed')];
    const result = upsert(arr, makeToolPart('p-1', 'running'), 500);
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('applies a newer running update over a stored terminal that settled before the run', () => {
    // Mirror reopen replay: the cache still holds a stale stored terminal while
    // the live run (started later) is the current state of the same part.
    const arr = [makeToolPart('p-1', 'completed', { start: 1700100002000, end: 1700100006000 })];
    const result = upsert(arr, makeToolPart('p-1', 'running', { start: 1789655865076 }));
    expect(toolStatus(result, 'p-1')).toBe('running');
  });

  test('drops a running update whose start predates the stored terminal', () => {
    const arr = [makeToolPart('p-1', 'completed', { start: 1, end: 250 })];
    const result = upsert(arr, makeToolPart('p-1', 'running', { start: 100 }));
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('settles terminal vs terminal by the tool state time when no event time exists', () => {
    const arr = [makeToolPart('p-1', 'completed', { start: 1, end: 5 })];
    const older = upsert(arr, makeToolPart('p-1', 'error', { start: 1, end: 4 }));
    expect(toolStatus(older, 'p-1')).toBe('completed');

    const newer = upsert(arr, makeToolPart('p-1', 'error', { start: 1, end: 6 }));
    expect(toolStatus(newer, 'p-1')).toBe('error');
  });

  test('drops a replayed terminal whose settle time predates the stored running start', () => {
    // Reopen replay: the snapshotted running part carries the live run's start
    // as its only ordering evidence, and the page replay delivers a terminal
    // that settled before that run began. The stale terminal must not flip it.
    const arr = [makeToolPart('p-1', 'running', { start: 1789655865076 })];
    const result = upsert(
      arr,
      makeToolPart('p-1', 'completed', { start: 1700100002000, end: 1700100006000 }),
      1700100006000
    );
    expect(toolStatus(result, 'p-1')).toBe('running');
    expect(result).toBe(arr);
  });

  test('drops a replayed error whose settle time predates the stored running start', () => {
    const arr = [makeToolPart('p-1', 'running', { start: 1789655865076 })];
    const result = upsert(
      arr,
      makeToolPart('p-1', 'error', { start: 1700100002000, end: 1700100006000 }),
      1700100006000
    );
    expect(toolStatus(result, 'p-1')).toBe('running');
    expect(result).toBe(arr);
  });

  test('applies a replayed terminal whose settle time postdates the stored running start', () => {
    const arr = [makeToolPart('p-1', 'running', { start: 1700100002000 })];
    const result = upsert(
      arr,
      makeToolPart('p-1', 'completed', { start: 1700100002000, end: 1700100006000 }),
      1700100006000
    );
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('first settled terminal wins when no ordering evidence exists at all', () => {
    const arr = [makeToolPart('p-1', 'completed', { start: 1, end: 5 })];
    const result = upsert(arr, makeToolPart('p-1', 'completed', { start: 1, end: 5 }));
    expect(result).toBe(arr);
  });

  test('leaves non-tool parts unordered', () => {
    const arr = [makePart('p-1', 'first')];
    const result = upsert(arr, makePart('p-1', 'second'), 1);
    expect((result[0] as Part & { text: string }).text).toBe('second');
  });

  test('does not throw on a stored compacted running part with no state time', () => {
    const arr = [makeCompactedToolPart('p-1', 'running')];
    const result = upsert(arr, makeToolPart('p-1', 'completed'), 250);
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('does not throw on a stored compacted terminal part with no state time', () => {
    const arr = [makeCompactedToolPart('p-1', 'completed')];
    const result = upsert(arr, makeCompactedToolPart('p-1', 'error'));
    // No ordering evidence on either side: the first settled terminal wins.
    expect(toolStatus(result, 'p-1')).toBe('completed');
  });

  test('keeps a terminal accepted by its settle time against a later older terminal', () => {
    // The stored terminal's recorded event time (100) is older than the settle
    // time (200) of the terminal that replaces it. An out-of-order terminal
    // that lands between the two must lose against the applied settle time.
    const arr = upsert([], makeToolPart('p-1', 'completed', { start: 1, end: 100 }), 100);
    const accepted = upsert(arr, makeToolPart('p-1', 'error', { start: 1, end: 200 }));
    expect(toolStatus(accepted, 'p-1')).toBe('error');

    const result = upsert(accepted, makeToolPart('p-1', 'completed', { start: 1, end: 150 }), 150);
    expect(toolStatus(result, 'p-1')).toBe('error');
    expect(result).toBe(accepted);
  });
});

describe('isSupportedDeltaField', () => {
  test('returns true for text', () => {
    expect(isSupportedDeltaField('text')).toBe(true);
  });

  test('returns false for structural fields', () => {
    for (const f of ['id', 'messageID', 'sessionID', 'type']) {
      expect(isSupportedDeltaField(f)).toBe(false);
    }
  });

  test('returns false for unknown fields', () => {
    expect(isSupportedDeltaField('randomField')).toBe(false);
  });
});

describe('clonePart', () => {
  test('returns deep clone', () => {
    const original = makePart('p1', 'hello');
    const clone = clonePart(original);
    expect(clone).toEqual(original);
    expect(clone).not.toBe(original);
  });

  test('mutating clone does not affect original', () => {
    const original = makePart('p1', 'hello');
    const clone = clonePart(original);
    (clone as Part & { text: string }).text = 'changed';
    expect((original as Part & { text: string }).text).toBe('hello');
  });
});

describe('createReadonlyPartView', () => {
  test('reading properties works normally', () => {
    const view = createReadonlyPartView(makePart('p1', 'hello'));
    expect(view.id).toBe('p1');
    expect((view as Part & { text: string }).text).toBe('hello');
  });

  test('setting a property is silently ignored', () => {
    const view = createReadonlyPartView(makePart('p1', 'hello'));
    (view as Part & { text: string }).text = 'changed';
    expect((view as Part & { text: string }).text).toBe('hello');
  });

  test('deleting a property is silently ignored', () => {
    const view = createReadonlyPartView(makePart('p1', 'hello'));
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (view as Record<string, unknown>)['text'];
    expect((view as Part & { text: string }).text).toBe('hello');
  });
});

describe('applyTextDelta', () => {
  test('appends delta to existing text', () => {
    const part = makePart('p1', 'hello');
    const result = applyTextDelta(part, ' world');
    expect((result as Part & { text: string }).text).toBe('hello world');
  });

  test('returns new object on success', () => {
    const part = makePart('p1', 'hello');
    const result = applyTextDelta(part, ' world');
    expect(result).not.toBe(part);
  });

  test('returns same reference for non-text part', () => {
    const part = { id: 'p1', sessionID: 's', messageID: 'm', type: 'tool' } as Part;
    const result = applyTextDelta(part, 'delta');
    expect(result).toBe(part);
  });
});

describe('createSeedTextPart', () => {
  test('creates a minimal TextPart', () => {
    const part = createSeedTextPart('msg-1', 'part-1', 'content');
    expect(part).toEqual({
      id: 'part-1',
      messageID: 'msg-1',
      sessionID: '',
      type: 'text',
      text: 'content',
    });
  });
});

describe('notify', () => {
  test('calls all registered callbacks for matching key', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    const subs = new Map([['k', new Set([cb1, cb2])]]);
    notify(subs, 'k');
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  test('no-op for missing key', () => {
    const cb = jest.fn();
    const subs = new Map([['k', new Set([cb])]]);
    notify(subs, 'other');
    expect(cb).not.toHaveBeenCalled();
  });

  test('no-op for empty subscriber map', () => {
    expect(() => notify(new Map(), 'k')).not.toThrow();
  });
});

describe('EMPTY_PARTS', () => {
  test('is a frozen empty array', () => {
    expect(Object.isFrozen(EMPTY_PARTS)).toBe(true);
    expect(EMPTY_PARTS).toHaveLength(0);
  });
});
