/* eslint-disable max-lines -- one suite pins the search budget (question counters, a parallel turn, refusal and timeout charges) and the setting on the same mock harness. */
import { onlineManager } from '@tanstack/react-query';
import { ToolFailure } from '@kilocode/harness-sdk';
import { Effect, Result } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { type StoredChatBackend } from './backend-store';
import { backendTargetId, localTargetId } from './backend-target';
import { webSearchTool } from './web-search';
import { type QuestionSearches, questionSearches } from './web-search-budget';
import {
  moveWebSearchEnabled,
  setWebSearchEnabled,
  webSearchDefault,
  webSearchEnabledFor,
} from './web-search-setting';

const world = vi.hoisted(() => ({
  token: 'token-one' as string | null,
  response: { status: 200, body: '{"results":[]}' },
  requests: [] as { url: string; headers: Record<string, string>; body: string }[],
  // How many of the next requests never reach a response: they fail in transport.
  transportFailures: 0,
  // Whether the next request hangs until the search times out.
  hang: false,
  // Whether the response body read fails instead of returning the body.
  unreadable: false,
  // Whether the token read rejects, as a failing keystore read does.
  tokenReadFails: false,
  settings: new Map<string, string>(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:3000' }));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: async () => {
    await Promise.resolve();
    if (world.tokenReadFails) {
      throw new Error('keystore read failed');
    }
    return world.token;
  },
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: world.toastError } }));
vi.mock('./fetch', () => ({
  chatFetch: async (
    url: string,
    request: { readonly headers: Record<string, string>; readonly body: string }
  ) => {
    await Promise.resolve();
    world.requests.push({ url, headers: request.headers, body: request.body });
    if (world.transportFailures > 0) {
      world.transportFailures -= 1;
      throw new TypeError('Network request failed');
    }
    if (world.hang) {
      return new Promise<never>(() => undefined);
    }
    const { status, body } = world.response;
    return {
      ok: status < 400,
      status,
      text: async () => {
        await Promise.resolve();
        if (world.unreadable) {
          throw new Error('stream closed');
        }
        return body;
      },
    };
  },
}));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, key: string) => {
    await Promise.resolve();
    return world.settings.get(`${scope}:${key}`) ?? null;
  },
  setItem: async (scope: string, key: string, value: string) => {
    await Promise.resolve();
    world.settings.set(`${scope}:${key}`, value);
  },
  removeItem: async (scope: string, key: string) => {
    await Promise.resolve();
    world.settings.delete(`${scope}:${key}`);
  },
}));

async function searched(organizationId?: string) {
  const answer = await Effect.runPromise(
    Effect.result(
      webSearchTool(organizationId).run({
        id: 'call-1',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'who won the match last night' }),
      })
    )
  );
  return answer;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  world.token = 'token-one';
  world.response = { status: 200, body: '{"results":[]}' };
  world.requests.length = 0;
  world.transportFailures = 0;
  world.hang = false;
  world.unreadable = false;
  world.tokenReadFails = false;
  world.settings.clear();
  world.toastError.mockClear();
});

/**
 * One question's searches as the chat runs them one after another: the same
 * tool call repeated, against a counter this helper owns, so the test can read
 * what was charged. A later round of the same question passes the counter back.
 */
function askQuestion(calls: number, shared?: QuestionSearches) {
  const spent = shared ?? { used: 0, attempts: 0, answered: 0 };
  const tool = webSearchTool();
  const call = { id: 'c', name: 'web_search', arguments: '{"query":"news"}' };
  const answers = Effect.runPromise(
    Effect.forEach(Array.from({ length: calls }), () => Effect.result(tool.run(call))).pipe(
      Effect.provideService(questionSearches, spent)
    )
  );
  return { spent, answers };
}

/**
 * One question whose turn issues its searches together, as the chat's tool
 * runner does: every call reads the same counter before any of them settles.
 */
function askQuestionAtOnce(calls: number, shared?: QuestionSearches) {
  const spent = shared ?? { used: 0, attempts: 0, answered: 0 };
  const tool = webSearchTool();
  const call = { id: 'c', name: 'web_search', arguments: '{"query":"news"}' };
  const answers = Effect.runPromise(
    Effect.forEach(Array.from({ length: calls }), () => Effect.result(tool.run(call)), {
      concurrency: 'unbounded',
    }).pipe(Effect.provideService(questionSearches, spent))
  );
  return { spent, answers };
}

/** What a refused search told the model. */
function reasonOf(answer: Result.Result<string, ToolFailure> | undefined): string {
  if (answer === undefined || Result.isSuccess(answer)) {
    return '';
  }
  return String(answer.failure.cause);
}

describe('a web search', () => {
  it('asks the Kilo proxy for five results, billed to the chat organization', async () => {
    world.response = {
      status: 200,
      body: JSON.stringify({
        results: Array.from({ length: 8 }, (_, i) => ({
          url: `https://news.example/${String(i)}`,
          title: `Story ${String(i)}`,
          text: 'x'.repeat(5000),
        })),
      }),
    };

    const answer = await searched('org-1');

    expect(world.requests).toHaveLength(1);
    const [request] = world.requests;
    expect(request?.url).toBe('http://localhost:3000/api/exa/search');
    expect(request?.headers.Authorization).toBe('Bearer token-one');
    expect(request?.headers['x-kilocode-organizationid']).toBe('org-1');
    expect(JSON.parse(request?.body ?? '')).toEqual({
      query: 'who won the match last night',
      numResults: 5,
      contents: { text: { maxCharacters: 1200 } },
    });
    const body = JSON.parse(Result.getOrThrow(answer)) as {
      readonly results: readonly { readonly url: string; readonly text: string }[];
    };
    expect(body.results).toHaveLength(5);
    expect(body.results.every(result => result.text.length === 1200)).toBe(true);
  });

  it('fails at once with no request while the device is offline', async () => {
    onlineManager.setOnline(false);

    const answer = await searched();

    expect(Result.isFailure(answer)).toBe(true);
    expect(world.requests).toEqual([]);
  });

  it('says the free searches are used up when the proxy answers 402', async () => {
    world.response = {
      status: 402,
      body: '{"error":"Exa free allowance exhausted and no credit balance available"}',
    };

    const answer = await searched();

    expect(Result.isFailure(answer)).toBe(true);
    expect(world.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('modelChat.webSearch.allowanceExhausted')
    );
  });

  it('stops after five searches in one question, and a new question starts again', async () => {
    const first = await askQuestion(6).answers;

    expect(first.map(answer => Result.isSuccess(answer))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(world.requests).toHaveLength(5);

    const second = await askQuestion(6).answers;

    expect(Result.isSuccess(second[0] ?? Result.fail(undefined))).toBe(true);
    expect(world.requests).toHaveLength(10);
  });

  it('never reaches the proxy without a signed-in token', async () => {
    world.token = null;

    expect(Result.isFailure(await searched())).toBe(true);
    expect(world.requests).toEqual([]);

    const { spent, answers } = askQuestion(2);
    const outcome = await answers;

    expect(outcome.every(answer => Result.isFailure(answer))).toBe(true);
    expect(world.requests).toEqual([]);
    // A signed-out call never reaches the proxy, so it reserves no attempt and no search.
    expect(spent.attempts).toBe(0);
    expect(spent.used).toBe(0);
  });

  it('keeps no attempt when the token read rejects and no search is sent', async () => {
    world.tokenReadFails = true;

    const { spent, answers } = askQuestion(3);
    const outcome = await answers;

    expect(outcome.every(answer => Result.isFailure(answer))).toBe(true);
    expect(world.requests).toEqual([]);
    // A keystore read that rejects sends no search, so it costs no attempt.
    expect(spent.attempts).toBe(0);
  });

  it('charges nothing for five searches that never reach the proxy', async () => {
    world.transportFailures = 5;

    const { spent, answers } = askQuestion(5);
    const outcome = await answers;

    expect(outcome.every(answer => Result.isFailure(answer))).toBe(true);
    expect(world.requests).toHaveLength(5);
    expect(spent.used).toBe(0);
  });

  it('charges nothing for a 402 allowance refusal or a failing status', async () => {
    world.response = { status: 500, body: '{"error":"upstream exploded"}' };

    const broken = askQuestion(1);
    const [brokenAnswer] = await broken.answers;
    expect(Result.isFailure(brokenAnswer ?? Result.fail(undefined))).toBe(true);
    expect(broken.spent.used).toBe(0);
    // A refusal reached the proxy, so the attempt counts even though nothing was spent.
    expect(broken.spent.attempts).toBe(1);

    world.response = {
      status: 402,
      body: '{"error":"Exa free allowance exhausted and no credit balance available"}',
    };

    const refused = askQuestion(1);
    const [refusedAnswer] = await refused.answers;
    expect(Result.isFailure(refusedAnswer ?? Result.fail(undefined))).toBe(true);
    expect(refused.spent.used).toBe(0);
    expect(refused.spent.attempts).toBe(1);
  });

  it('spends only the attempt when a failing status has no readable body', async () => {
    world.response = { status: 500, body: '{"error":"upstream exploded"}' };
    world.unreadable = true;

    const { spent, answers } = askQuestion(1);
    const [answer] = await answers;

    expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
    // Whatever escapes the attempt is a search that reached Kilo and answered nothing.
    expect(reasonOf(answer)).toContain('Web search failed: ');
    expect(spent.used).toBe(0);
    expect(spent.attempts).toBe(1);
  });

  it('charges a search Kilo answered whose body is not the results shape', async () => {
    world.response = { status: 200, body: '{"unexpected":true}' };

    const { spent, answers } = askQuestion(1);
    const [answer] = await answers;

    expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
    // Kilo ran the search and billed the account, so the allowance still moved.
    expect(spent.used).toBe(1);
  });

  it('charges a search Kilo answered even when the body read fails', async () => {
    world.response = { status: 200, body: '{"results":[]}' };
    world.unreadable = true;

    const { spent, answers } = askQuestion(1);
    const [answer] = await answers;

    expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
    // Kilo billed the account for the search, so a body lost mid-stream still counts.
    expect(spent.used).toBe(1);
    // The model is told the search came back unreadable, not the reader's own error.
    expect(reasonOf(answer)).toContain('results could not be read');
    expect(reasonOf(answer)).not.toContain('stream closed');
  });

  it('bounds a failing loop at fifteen attempts and spends no allowance', async () => {
    world.transportFailures = 20;

    const { spent, answers } = askQuestion(20);
    const outcome = await answers;

    expect(world.requests).toHaveLength(15);
    expect(outcome.slice(0, 15).every(answer => Result.isFailure(answer))).toBe(true);
    expect(reasonOf(outcome[15])).toContain('all 15 of its web search attempts');
    // Nothing answered, so the model must say the search did not work.
    expect(reasonOf(outcome[15])).toContain('say the search did not work');
    expect(spent.used).toBe(0);
    expect(spent.attempts).toBe(15);
  });

  it('tells the model nothing answered when the attempt cap stops a turn that answered nothing', async () => {
    // Fourteen failures one at a time give their answered slot back each time,
    // so the question has an answered search of zero and one attempt left.
    world.transportFailures = 14;

    const failures = askQuestion(14);
    const failed = await failures.answers;

    expect(failed.every(answer => Result.isFailure(answer))).toBe(true);
    expect(failures.spent.used).toBe(0);
    expect(failures.spent.attempts).toBe(14);
    expect(failures.spent.answered).toBe(0);

    // The next turn issues three searches at once against a proxy that answers:
    // the first reserves the last attempt, and the other two reach the cap while
    // that search is still on the wire.
    world.response = { status: 200, body: '{"results":[]}' };
    world.transportFailures = 0;
    world.requests.length = 0;

    const turn = askQuestionAtOnce(3, failures.spent);
    const outcome = await turn.answers;

    expect(world.requests).toHaveLength(1);
    expect(turn.spent.used).toBe(1);
    expect(turn.spent.attempts).toBe(15);
    expect(turn.spent.answered).toBe(1);

    const reasons = outcome
      .filter(answer => Result.isFailure(answer))
      .map(answer => reasonOf(answer));

    expect(reasons).toHaveLength(2);
    expect(reasons.every(reason => reason.includes('all 15 of its web search attempts'))).toBe(
      true
    );
    // A reserved slot is not an answer: no refused call of this turn may tell
    // the model to read its reply as if a search had come back.
    expect(reasons.filter(reason => reason.includes('say the search did not work'))).toHaveLength(
      2
    );
    expect(reasons.some(reason => reason.includes('answer with what you have.'))).toBe(false);
  });

  it('holds the answered-search cap for a parallel burst that never answers', async () => {
    world.transportFailures = 20;

    const { spent, answers } = askQuestionAtOnce(20);
    const outcome = await answers;

    // Both slots are taken before the first await, so the calls of a turn that
    // have not learned their outcome yet stop at the five answered searches,
    // stricter than the fifteen attempts a failing loop is allowed one at a time.
    expect(world.requests).toHaveLength(5);
    expect(outcome.slice(0, 5).every(answer => Result.isFailure(answer))).toBe(true);
    expect(reasonOf(outcome[5])).toContain('5 web searches, the limit');
    expect(spent.used).toBe(0);
    expect(spent.answered).toBe(0);
    expect(spent.attempts).toBe(5);
  });

  it('holds the answered-search cap when a turn issues twenty searches at once', async () => {
    world.response = { status: 200, body: '{"results":[]}' };

    const { spent, answers } = askQuestionAtOnce(20);
    const outcome = await answers;

    // Every call of the turn reserves before it awaits, so five answered
    // searches are taken before the sixth call looks at the counter.
    expect(world.requests).toHaveLength(5);
    expect(outcome.slice(0, 5).every(answer => Result.isSuccess(answer))).toBe(true);
    const refused = outcome[5];
    if (refused === undefined || Result.isSuccess(refused)) {
      throw new Error('the sixth search of the turn was not refused');
    }
    // A refusal reaches the model as a failed tool result, not as a body.
    expect(refused.failure).toBeInstanceOf(ToolFailure);
    expect(reasonOf(outcome[5])).toContain('5 web searches, the limit');
    expect(spent.used).toBe(5);
    expect(spent.answered).toBe(5);
    expect(spent.attempts).toBe(5);
  });

  it('gives the answered slots back after a parallel burst that all fails', async () => {
    world.transportFailures = 5;

    const first = askQuestionAtOnce(5);
    const failed = await first.answers;

    expect(failed.every(answer => Result.isFailure(answer))).toBe(true);
    expect(world.requests).toHaveLength(5);
    // Nothing answered, so the searches come back; the five attempts stay spent.
    expect(first.spent.used).toBe(0);
    expect(first.spent.answered).toBe(0);
    expect(first.spent.attempts).toBe(5);

    const next = await askQuestion(1, first.spent).answers;
    const [answered] = next;

    expect(Result.isSuccess(answered ?? Result.fail(undefined))).toBe(true);
    expect(world.requests).toHaveLength(6);
    // The same question may still search, and the answered search now counts.
    expect(first.spent.used).toBe(1);
    expect(first.spent.answered).toBe(1);
    expect(first.spent.attempts).toBe(6);
  });

  it('does not reach the attempt cap while a question still gets answered searches', async () => {
    const { spent, answers } = askQuestion(6);
    const outcome = await answers;

    expect(outcome.map(answer => Result.isSuccess(answer))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // The five-search limit stops the sixth, so attempts never reach fifteen.
    expect(reasonOf(outcome[5])).toContain('5 web searches, the limit');
    expect(world.requests).toHaveLength(5);
    expect(spent.used).toBe(5);
    expect(spent.answered).toBe(5);
    expect(spent.attempts).toBe(5);
  });

  it('counts a timed-out search as one attempt and charges nothing', async () => {
    vi.useFakeTimers();
    try {
      world.hang = true;

      const { spent, answers } = askQuestion(1);
      await vi.advanceTimersByTimeAsync(15_000);
      const [answer] = await answers;
      // A fiber that ran under the timeout must not leak past the test.
      await vi.runAllTimersAsync();

      expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
      expect(reasonOf(answer)).toContain('took too long');
      expect(spent.used).toBe(0);
      expect(spent.attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('whether a chat offers web search', () => {
  it('is on for a Kilo model and off for a custom backend or an on-device model', () => {
    const backend: StoredChatBackend = {
      id: 'b1',
      revision: 1,
      name: 'Local',
      baseUrl: 'https://llm.example/v1',
      apiKind: 'chat_completions',
      apiKey: '',
      headers: {},
      models: [{ id: 'llama', name: 'Llama', tools: true, images: false, reasoning: false }],
      allowLocalHttp: false,
    };

    expect(webSearchDefault('anthropic/claude-sonnet-4.6')).toBe(true);
    expect(webSearchDefault(localTargetId('gguf', 'qwen.gguf'))).toBe(false);
    expect(webSearchDefault(localTargetId('apple'))).toBe(false);
    expect(webSearchDefault(backendTargetId(backend, 'llama'))).toBe(false);
  });

  it('follows the person once they choose, and moves with the chat', async () => {
    const gguf = localTargetId('gguf', 'qwen.gguf');
    await setWebSearchEnabled('s1', true);

    expect(await webSearchEnabledFor('s1', gguf)).toBe(true);

    await moveWebSearchEnabled('s1', 's2');

    expect(await webSearchEnabledFor('s2', gguf)).toBe(true);
    expect(await webSearchEnabledFor('s1', gguf)).toBe(false);
  });
});
