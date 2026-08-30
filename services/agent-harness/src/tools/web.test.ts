import { expect, it } from 'vitest';
import { z } from 'zod';
import { RunLimitsSchema } from '../commands';
import { reserve, ReservationSchema, type Reservation } from '../limits';
import { executeWeb } from './web';

const search = { name: 'web.search', arguments: { query: 'Kilo', limit: 5 } };
const retrieve = { name: 'web.retrieve', arguments: { url: 'https://example.com/' } };
const source = {
  url: 'https://EXAMPLE.COM',
  title: ' Source ',
  text: 'abcdef',
  publishedDate: '2026-08-01',
};
function fixture(overrides = {}) {
  const limits = RunLimitsSchema.parse(overrides);
  const admission = {
    runId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    context: { type: 'personal' as const },
    limits,
    model: { contextTokens: 32000, inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
  };
  let reservations: Reservation[] = [],
    dispatches = 0;
  const nextBudget = () => {
    const reservation = reserve(
      admission,
      reservations,
      { kind: 'tool', step: 1, toolCallId: crypto.randomUUID(), webRequest: true },
      Date.now()
    );
    // Reload the persisted representation before dispatch, including uncertain prior requests.
    reservations = z
      .array(ReservationSchema)
      .parse(JSON.parse(JSON.stringify([...reservations, reservation])));
    return {
      limits,
      reservation: ReservationSchema.parse(reservations.at(-1)),
      signal: new AbortController().signal,
    };
  };
  const run = async (
    input: unknown = search,
    body: unknown = { results: [source] },
    lost = false
  ) =>
    executeWeb(input, nextBudget(), async () => {
      dispatches++;
      if (lost) throw new Error('Lost provider response');
      return { status: 'succeeded', body, costMicrodollars: 2000 };
    });
  return { run, nextBudget, count: () => dispatches };
}
it('returns bounded normalized untrusted sources with actual citation parts', async () => {
  const f = fixture({ searchResults: 2, snippetCharacters: 3 });
  expect(await f.run(search, { results: [source, { ...source, title: '' }, source] })).toEqual({
    outcome: {
      status: 'succeeded',
      output: [
        {
          url: 'https://example.com/',
          title: 'Source',
          text: 'abc',
          publishedAt: '2026-08-01T00:00:00.000Z',
          untrusted: true,
        },
        {
          url: 'https://example.com/',
          title: 'https://example.com/',
          text: 'abc',
          publishedAt: '2026-08-01T00:00:00.000Z',
          untrusted: true,
        },
      ],
    },
    citations: [
      { type: 'citation', url: 'https://example.com/', title: 'Source' },
      { type: 'citation', url: 'https://example.com/', title: 'https://example.com/' },
    ],
    costMicrodollars: 2000,
  });
});
it.each([
  [4, '漢字', '漢'],
  [3, '𠮷a', ''],
  [4, '𠮷a', '𠮷'],
  [5, 'é漢x', 'é漢'],
] as const)(
  'bounds page UTF-8 bytes at %i without corruption',
  async (pageBytes, text, expected) => {
    expect(
      await fixture({ pageBytes }).run(retrieve, { results: [{ ...source, text }] })
    ).toMatchObject({
      outcome: { status: 'succeeded', output: { text: expected, untrusted: true } },
    });
  }
);
it('bounds snippets without splitting Unicode characters', async () => {
  const result = await fixture({ snippetCharacters: 1 }).run(search, {
    results: [{ ...source, text: '𠮷a' }],
  });
  expect(JSON.stringify(result)).toContain('"text":"𠮷"');
});
it.each([search, retrieve])('returns honest empty %j data without citations', async request => {
  expect(await fixture().run(request, { results: [] })).toMatchObject({
    outcome: { status: 'succeeded', output: request === search ? [] : { text: '' } },
    citations: [],
  });
});
it.each([undefined, '', '   '])('omits citations for empty page text %j', async text => {
  expect(await fixture().run(retrieve, { results: [{ ...source, text }] })).toMatchObject({
    outcome: { status: 'succeeded', output: { text: text ?? '', untrusted: true } },
    citations: [],
  });
});
it.each([
  [{ results: [{ ...source, url: 'javascript:alert(1)' }] }, {}, 'invalid_output'],
  [{ results: [{ ...source, publishedDate: 'invalid' }] }, {}, 'invalid_output'],
  [{ results: [{ ...source, url: 'https://user:password@example.com/' }] }, {}, 'invalid_output'],
  [{ results: [{ ...source, text: 42 }] }, {}, 'invalid_output'],
  [{ results: [source] }, { toolOutputBytes: 1 }, 'limit_exceeded'],
  [{ results: [source] }, { toolInputBytes: 1 }, 'limit_exceeded'],
  [
    { results: [], statuses: [{ status: 'error', error: { httpStatusCode: 404 } }] },
    {},
    'unavailable_tool',
  ],
] as const)('rejects malformed, oversized, and failed source data', async (body, limits, code) => {
  expect(await fixture(limits).run(search, body)).toMatchObject({
    outcome: { status: 'failed', error: { code, retryable: false } },
    citations: [],
  });
});
it.each([408, 429, 500, undefined])(
  'allows budgeted recovery for provider status %j',
  async status => {
    const body = {
      results: [],
      statuses: [{ status: 'error', error: { httpStatusCode: status } }],
    };
    expect(await fixture().run(retrieve, body)).toMatchObject({
      outcome: { status: 'failed', error: { code: 'unavailable_tool', retryable: true } },
      citations: [],
      costMicrodollars: 2000,
    });
  }
);
it.each([
  null,
  { id: '' },
  { kind: 'model' },
  { webRequest: false },
  { status: 'released' },
  { status: 'finished' },
  { toolCallId: null },
  { deadline: 0 },
  { deadline: NaN },
])('rejects an inadmissible reservation %j before dispatch', async patch => {
  const budget = fixture().nextBudget();
  const reservation = patch === null ? null : { ...budget.reservation, ...patch };
  const result = await executeWeb(
    search,
    { ...budget, reservation: reservation as Reservation },
    async () => ({
      status: 'succeeded',
      body: { results: [source] },
      costMicrodollars: 2000,
    })
  );
  expect(result).toMatchObject({
    outcome: { status: 'failed', error: { code: 'limit_exceeded', retryable: false } },
    citations: [],
    costMicrodollars: null,
  });
});
it.each([0, null, 2000])('preserves returned actual cost %j', async costMicrodollars => {
  const result = await executeWeb(search, fixture().nextBudget(), async () => ({
    status: 'succeeded',
    body: { results: [] },
    costMicrodollars,
  }));
  expect(result).toEqual({
    outcome: { status: 'succeeded', output: [] },
    citations: [],
    costMicrodollars,
  });
});
it.each([
  [false, 'Access denied.', 'unavailable_tool'],
  [true, 'Retry later.', 'unavailable_tool'],
  [true, 'x'.repeat(1024), 'limit_exceeded'],
] as const)('preserves bounded provider failures (%j)', async (retryable, message, code) => {
  const result = await executeWeb(
    search,
    fixture({ toolOutputBytes: 512 }).nextBudget(),
    async () => ({
      status: 'failed',
      error: { code: 'unavailable_tool', message, retryable },
      costMicrodollars: null,
    })
  );
  expect(result).toMatchObject({
    outcome: {
      status: 'failed',
      error: { code, retryable: code === 'limit_exceeded' ? false : retryable },
    },
    citations: [],
    costMicrodollars: null,
  });
});
it('bounds the complete UTF-8 result including citations and its envelope', async () => {
  const body = { results: [{ ...source, title: '漢'.repeat(30) }] };
  const result = await fixture().run(search, body);
  const size = new Blob([JSON.stringify(result)]).size;
  expect(await fixture({ toolOutputBytes: size }).run(search, body)).toEqual(result);
  expect(await fixture({ toolOutputBytes: size - 1 }).run(search, body)).toMatchObject({
    outcome: { status: 'failed', error: { code: 'limit_exceeded', retryable: false } },
    citations: [],
    costMicrodollars: 2000,
  });
});
it('allows five live requests, consumes uncertainty, and keeps Exa outside the model ceiling', async () => {
  const f = fixture({ modelCostUsd: 0.000001 });
  expect(await f.run(search, {}, true)).toMatchObject({
    outcome: { status: 'failed', error: { retryable: true } },
    costMicrodollars: null,
  });
  for (let count = 1; count < 5; count++)
    expect(await f.run()).toMatchObject({
      outcome: { status: 'succeeded' },
      costMicrodollars: 2000,
    });
  await expect(f.run()).rejects.toMatchObject({ detail: { code: 'limit_exceeded' } });
  expect(f.count()).toBe(5);
});
