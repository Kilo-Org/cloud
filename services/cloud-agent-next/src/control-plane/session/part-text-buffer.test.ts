import { describe, expect, it } from 'vitest';
import { createPartTextBuffer, type BufferedPartText } from './part-text-buffer.js';

function partText(id: string, text: string): BufferedPartText {
  return {
    kind: 'part',
    rowId: 1,
    sessionId: 'workspace_test',
    timestamp: 1,
    part: { id, type: 'text' },
    text,
  };
}

describe('createPartTextBuffer', () => {
  it('drops a row that fails to write and still writes the other rows', () => {
    const written: string[] = [];
    const errors: unknown[] = [];
    const buffer = createPartTextBuffer({
      queries: {
        upsert(params) {
          if (params.entityId === 'part/poison') throw new Error('row too big');
          written.push(params.entityId ?? '');
          return 1;
        },
      },
      onFlushError: error => errors.push(error),
    });
    buffer.set('part/poison', partText('poison', 'a'));
    buffer.set('part/healthy', partText('healthy', 'b'));

    buffer.flush();

    expect(written).toEqual(['part/healthy']);
    expect(errors).toHaveLength(1);
    expect(buffer.get('part/poison', 'part')).toBeUndefined();
    expect(buffer.get('part/healthy', 'part')).toBeUndefined();
    buffer.clear();
  });
});
