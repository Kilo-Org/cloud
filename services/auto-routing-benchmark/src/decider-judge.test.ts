import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_SYSTEM_ONE_URL } from '@kilocode/auto-routing-contracts/classifier';
import { createDeciderJudge } from './decider-judge';

const client = { apiKey: 'test-key', attributionHeaders: { 'X-Title': 'benchmark-test' } };
const input = { userPrompt: 'Design a queue', output: 'Use a durable queue', rubric: 'Handles retries', reference: 'Durable queue with bounded retries' };
const body = { answers: { satisfies: { type: 'noul', noul: 0.83 } }, usage: { cost: 0.004 } };

afterEach(() => { vi.unstubAllGlobals(); });

describe('createDeciderJudge', () => {
  it('maps the System One request and probability response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createDeciderJudge(client)(input)).toEqual({ probability: 0.83, costUsd: 0.004 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(OPENROUTER_SYSTEM_ONE_URL);
    const options = call?.[1];
    expect(options?.method).toBe('POST');
    expect(options?.headers).toEqual({
      'X-Title': 'benchmark-test', Authorization: 'Bearer test-key', 'Content-Type': 'application/json',
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    if (typeof options?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(options.body)).toMatchObject({
      model: 'typesafe/jev-1.13',
      state: { task: input.userPrompt, answer: input.output, rubric: input.rubric, reference: input.reference },
      questions: { satisfies: { type: 'noul', instructions: {
        question: 'Does `answer` satisfy every criterion in `rubric` for `task`?',
      } } },
    });
  });

  it('supports an explicit model and absent reference', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    await createDeciderJudge(client, 'typesafe/custom')({ userPrompt: 'Task', output: 'Answer', rubric: 'Correct' });
    const options = fetchMock.mock.calls[0]?.[1];
    if (typeof options?.body !== 'string') throw new Error('Expected request body');
    expect(JSON.parse(options.body)).toMatchObject({ model: 'typesafe/custom', state: { reference: null } });
  });

  it.each([-1, 2, '0.8'])('rejects invalid probability %s', async noul => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ...body, answers: { satisfies: { type: 'noul', noul } },
    })));
    await expect(createDeciderJudge(client)(input)).rejects.toThrow('invalid decider judge response');
  });

  it('does not retry permanent HTTP errors or expose response bodies', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('private data', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createDeciderJudge(client)(input)).rejects.toThrow('System One returned HTTP 401');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reuses the single transient retry', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createDeciderJudge(client)(input)).toEqual({ probability: 0.83, costUsd: 0.004 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
