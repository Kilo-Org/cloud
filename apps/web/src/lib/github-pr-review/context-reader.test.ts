import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import {
  createContextReadBudget,
  createContextSourceReader,
  decodeContextGraphQlSource,
  type ContextReadResult,
} from './context-reader';

const input = { owner: 'octocat', repo: 'hello', number: 1 };
const pageSchema = z.object({ nodes: z.array(z.object({ name: z.string() }).nullable()) });
const labelsPath = ['repository', 'pullRequest', 'labels'];
function envelope(data: unknown, errors?: unknown): ContextReadResult<unknown> {
  return {
    data: { data, errors },
    source: {
      availability: 'available',
      retryable: false,
      reason: null,
      provenance: ['graphql.test'],
      observedAt: '2026-08-29T00:00:00Z',
    },
  };
}
let budget: ReturnType<typeof createContextReadBudget>;
beforeEach(() => {
  jest.useFakeTimers();
  budget = createContextReadBudget();
});
afterEach(() => {
  budget.close();
  jest.useRealTimers();
});
function reader(probe = jest.fn()) {
  return createContextSourceReader({ pulls: { get: probe } } as unknown as Octokit, input, budget);
}

describe('optional GraphQL source decoding', () => {
  it.each([
    {
      path: [...labelsPath, 'nodes', 1, 'name'],
      type: 'FORBIDDEN',
      sibling: 'available',
      retryable: false,
    },
    { path: undefined, type: 'INTERNAL', sibling: 'partial', retryable: true },
    { path: ['repository'], type: 'FORBIDDEN', sibling: 'partial', retryable: false },
  ])('retains data with $type at $path', ({ path, type, sibling, retryable }) => {
    const result = envelope(
      {
        repository: {
          pullRequest: {
            labels: { nodes: [{ name: 'known' }, null] },
            assignees: { nodes: [] },
          },
        },
      },
      [{ type, path, message: 'must not leave the provider boundary' }]
    );
    const labels = decodeContextGraphQlSource(result, labelsPath, pageSchema);
    expect(labels.data?.nodes).toEqual([{ name: 'known' }, null]);
    expect(labels.source).toMatchObject({ availability: 'partial', retryable });
    expect(JSON.stringify(labels)).not.toContain('must not leave');
    const assignees = decodeContextGraphQlSource(
      result,
      ['repository', 'pullRequest', 'assignees'],
      pageSchema
    );
    expect(assignees.data?.nodes).toEqual([]);
    expect(assignees.source.availability).toBe(sibling);
  });

  it('checks all errors rather than only the first error', () => {
    const result = envelope({ repository: { pullRequest: { labels: { nodes: [] } } } }, [
      { type: 'FORBIDDEN', path: ['viewer'] },
      { type: 'INTERNAL', path: labelsPath },
    ]);
    expect(decodeContextGraphQlSource(result, labelsPath, pageSchema)).toMatchObject({
      data: { nodes: [] },
      source: { availability: 'partial', retryable: true },
    });
  });

  it.each([null, {}, { labels: null }])(
    'does not call a null or omitted source empty: %p',
    pullRequest => {
      const result = envelope({ repository: { pullRequest }, viewer: { login: 'known' } }, [
        { type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'queue', 'position'] },
      ]);
      expect(decodeContextGraphQlSource(result, labelsPath, pageSchema)).toMatchObject({
        data: null,
        source: { availability: 'unavailable' },
      });
      expect(
        decodeContextGraphQlSource(result, ['viewer'], z.object({ login: z.string() }))
      ).toMatchObject({
        data: { login: 'known' },
        source: { availability: 'available' },
      });
    }
  );

  it.each([[], undefined, [{ path: ['viewer'], type: 'FORBIDDEN' }]])(
    'accepts an error-free empty sibling: %p',
    errors => {
      expect(
        decodeContextGraphQlSource(
          envelope({ repository: { pullRequest: { labels: { nodes: [] } } } }, errors),
          labelsPath,
          pageSchema
        )
      ).toMatchObject({
        data: { nodes: [] },
        source: { availability: 'available', retryable: false },
      });
    }
  );

  it.each([null, 'invalid', [{ path: [false], type: 'FORBIDDEN' }]])(
    'treats malformed errors as pathless uncertainty: %p',
    errors => {
      expect(
        decodeContextGraphQlSource(
          envelope({ repository: { pullRequest: { labels: { nodes: [] } } } }, errors),
          labelsPath,
          pageSchema
        )
      ).toMatchObject({
        data: { nodes: [] },
        source: { availability: 'partial', retryable: true },
      });
    }
  );

  it.each(['FORBIDDEN', 'NOT_FOUND'])(
    'isolates a null source denied through extensions: %s',
    code => {
      const result = envelope(
        {
          repository: {
            pullRequest: {
              labels: null,
              assignees: { nodes: [{ name: 'known' }] },
            },
          },
        },
        [{ extensions: { code }, path: labelsPath }]
      );
      expect(decodeContextGraphQlSource(result, labelsPath, pageSchema)).toMatchObject({
        data: null,
        source: { availability: 'denied', retryable: false },
      });
      expect(
        decodeContextGraphQlSource(result, ['repository', 'pullRequest', 'assignees'], pageSchema)
      ).toMatchObject({
        data: { nodes: [{ name: 'known' }] },
        source: { availability: 'available' },
      });
    }
  );

  it('keeps numeric sibling paths independent', () => {
    const result = envelope(
      {
        repository: {
          pullRequest: {
            labels: {
              nodes: [{ name: 'known' }, null],
            },
          },
        },
      },
      [{ type: 'FORBIDDEN', path: [...labelsPath, 'nodes', 1, 'name'] }]
    );
    expect(
      decodeContextGraphQlSource(
        result,
        [...labelsPath, 'nodes', 0],
        z.object({ name: z.string() })
      )
    ).toMatchObject({
      data: { name: 'known' },
      source: { availability: 'available' },
    });
    expect(
      decodeContextGraphQlSource(
        result,
        [...labelsPath, 'nodes', 1],
        z.object({ name: z.string() }).nullable()
      )
    ).toMatchObject({
      data: null,
      source: { availability: 'denied', retryable: false },
    });
  });

  it.each([null, { nodes: 'invalid' }, { nodes: [] }])(
    'does not let a default schema prove an omitted source empty: %p',
    labels => {
      const result = envelope({ repository: { pullRequest: { labels } } });
      const decoded = decodeContextGraphQlSource(
        result,
        [...labelsPath, 'missing'],
        pageSchema.default({ nodes: [] })
      );
      expect(decoded).toMatchObject({
        data: null,
        source: { availability: 'unavailable', retryable: true },
      });
    }
  );
});

describe('optional HTTP failures', () => {
  it.each([
    { status: 403, probeStatus: 200, availability: 'denied', retryable: false },
    { status: 503, probeStatus: 200, availability: 'unavailable', retryable: true },
    { status: 429, probeStatus: 200, availability: 'unavailable', retryable: true },
    { status: 401, probeStatus: 200, availability: 'denied', retryable: false },
    { status: 401, probeStatus: 503, availability: 'unavailable', retryable: true },
    { status: 401, probeStatus: 404, availability: 'unavailable', retryable: true },
  ])(
    'isolates $status with probe $probeStatus',
    async ({ status, probeStatus, availability, retryable }) => {
      const probe = jest.fn(async () => {
        if (probeStatus !== 200) throw { status: probeStatus };
        return { data: {} };
      });
      await expect(
        reader(probe)('rules', async () => {
          throw { status };
        })
      ).resolves.toMatchObject({
        data: null,
        source: { availability, retryable },
      });
    }
  );

  it('passes only a confirmed core 401 to credential rotation', async () => {
    const read = reader(jest.fn().mockRejectedValue({ status: 401 }));
    await expect(
      read('rules', async () => {
        throw { status: 401 };
      })
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each([200, 401, 503])(
    'shares one probe with status %s within four active requests',
    async status => {
      let active = 0,
        peak = 0,
        probes = 0;
      async function network<T>(work: () => Promise<T>) {
        active++;
        peak = Math.max(peak, active);
        try {
          return await work();
        } finally {
          active--;
        }
      }
      const held = Promise.withResolvers<string>();
      const probe = Promise.withResolvers<unknown>();
      const read = reader(
        jest.fn(() =>
          network(() => {
            probes++;
            return probe.promise;
          })
        )
      );
      const pending = Promise.allSettled([
        ...Array.from({ length: 3 }, () => read('sibling', () => network(() => held.promise))),
        ...Array.from({ length: 6 }, () =>
          read('denied', () =>
            network(async () => {
              await new Promise(resolve => setTimeout(resolve, 5));
              throw { status: 401 };
            })
          )
        ),
      ]);
      await jest.advanceTimersByTimeAsync(50);
      if (status === 200) probe.resolve({ data: {} });
      else probe.reject({ status });
      held.resolve('known');
      const results = await pending;
      for (const result of results.slice(0, 3)) {
        expect(result).toMatchObject({ status: 'fulfilled', value: { data: 'known' } });
      }
      for (const result of results.slice(3)) {
        if (status === 401)
          expect(result).toMatchObject({ status: 'rejected', reason: { status: 401 } });
        else
          expect(result).toMatchObject({
            status: 'fulfilled',
            value: {
              data: null,
              source: {
                availability: status === 200 ? 'denied' : 'unavailable',
                retryable: status !== 200,
              },
            },
          });
      }
      expect(probes).toBe(1);
      expect(peak).toBe(4);
    }
  );
});

it('retains a completed page, aborts pending pages, and never starts queued or late requests', async () => {
  const read = reader();
  const completed = await read('pages', async () => ({ nodes: ['known'], hasNextPage: true }));
  let started = 0;
  let aborted = 0;
  const pending = Promise.all(
    Array.from({ length: 5 }, () =>
      read('pages', signal => {
        started++;
        return new Promise(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              aborted++;
              resolve('late page');
            },
            { once: true }
          )
        );
      })
    )
  );
  await jest.advanceTimersByTimeAsync(10_000);
  expect(completed).toMatchObject({
    data: { nodes: ['known'], hasNextPage: true },
    source: { availability: 'available' },
  });
  expect((await pending).map(result => result.source.reason)).toEqual(Array(5).fill('deadline'));
  expect(aborted).toBe(4);
  const late = await read('pages', async () => {
    started++;
    return 'late request';
  });
  expect(late).toMatchObject({
    data: null,
    source: { availability: 'unavailable', retryable: true, reason: 'deadline' },
  });
  expect(started).toBe(4);
});

it.each(['success', '401'])(
  'rejects late %s before an overdue deadline timer runs',
  async outcome => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<string>();
    const pending = reader()('pages', () => {
      started.resolve();
      return response.promise;
    });
    await started.promise;
    jest.setSystemTime(Date.now() + 10_000);
    if (outcome === 'success') response.resolve('late page');
    else response.reject({ status: 401 });
    await expect(pending).resolves.toMatchObject({
      data: null,
      source: { availability: 'unavailable', retryable: true, reason: 'deadline' },
    });
  }
);

it('leaves an expired credential probe inconclusive', async () => {
  const read = reader(jest.fn(() => new Promise(() => undefined)));
  const pending = read('rules', async () => {
    throw { status: 401 };
  });
  await jest.advanceTimersByTimeAsync(10_000);
  await expect(pending).resolves.toMatchObject({
    data: null,
    source: {
      availability: 'unavailable',
      retryable: true,
      reason: 'credential-probe-inconclusive',
    },
  });
});
