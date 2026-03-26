import type { Part } from '@/types/opencode.gen';
import {
  EMPTY_PARTS,
  applyTextDelta,
  clonePart,
  createReadonlyPartView,
  createSeedTextPart,
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
} from './helpers';

function makePart(id: string, text = ''): Part {
  return { id, sessionID: 's', messageID: 'm', type: 'text', text } as Part;
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
