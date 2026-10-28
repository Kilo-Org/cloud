import { expect, it } from 'vitest';

import { LIMITS, pageSchema } from '../../src/protocol';
import { batch, client, newSessionID, personal } from '../helpers';

it('resumes pagination after a maximum-length Unicode entity ID', async () => {
  const api = client(personal(`unicode-${crypto.randomUUID()}`));
  const id = newSessionID();
  const source = crypto.randomUUID();
  const key = '界'.repeat(LIMITS.idChars);
  await api.register(id, source);
  const applied = await api.apply(
    id,
    batch(source, 0, 1, [
      { op: 'put', kind: 'message', id: key, value: 'first' },
      { op: 'put', kind: 'message', id: '\uffff', value: 'second' },
    ])
  );
  expect(applied.status).toBe(200);
  const first = pageSchema.parse(await (await api.entities(id, { limit: '1' })).json());
  expect(first.entities.map(entity => entity.id)).toEqual([key]);
  if (first.next === null) throw new Error('The remaining entity requires a continuation cursor');
  const result = await api.entities(id, {
    limit: '1',
    cursor: first.next,
    revision: String(first.revision),
  });
  expect(result.status).toBe(200);
  const second = pageSchema.parse(await result.json());
  expect(second.entities.map(entity => entity.id)).toEqual(['\uffff']);
});
