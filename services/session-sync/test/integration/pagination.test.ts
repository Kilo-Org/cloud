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

it('seeks across kinds and byte-truncated pages without skipping or repeating rows', async () => {
  const api = client(personal(`pages-${crypto.randomUUID()}`));
  const id = newSessionID();
  const source = crypto.randomUUID();
  await api.register(id, source);
  const value = 'x'.repeat(60 * 1024);
  const expected: string[] = [];
  let position = 0;
  for (const kind of ['asset', 'message'] as const) {
    for (let offset = 0; offset < 40; offset += 4) {
      const changes = Array.from({ length: 4 }, (_, index) => {
        const key = String(offset + index).padStart(3, '0');
        expected.push(`${kind}/${key}`);
        return { op: 'put' as const, kind, id: key, value };
      });
      expect((await api.apply(id, batch(source, position, position + 1, changes))).status).toBe(200);
      position++;
    }
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let revision: string | undefined;
  let pages = 0;
  do {
    const query: Record<string, string> = { limit: '100' };
    if (cursor) query.cursor = cursor;
    if (revision) query.revision = revision;
    const page = pageSchema.parse(await (await api.entities(id, query)).json());
    expect(page.entities.length).toBeLessThanOrEqual(Math.floor(LIMITS.pageBytes / (value.length + 2)));
    seen.push(...page.entities.map(entity => `${entity.kind}/${entity.id}`));
    cursor = page.next ?? undefined;
    revision = String(page.revision);
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen).toEqual(expected);
});
