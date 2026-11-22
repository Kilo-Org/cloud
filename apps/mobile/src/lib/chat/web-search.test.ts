import { onlineManager } from '@tanstack/react-query';
import { type ToolFailure } from '@kilocode/harness-sdk';
import { Effect, Result } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { type StoredChatBackend } from './backend-store';
import { backendTargetId, localTargetId } from './backend-target';
import { webSearchTool } from './web-search';
import { questionSearches } from './web-search-budget';
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
  settings: new Map<string, string>(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:3000' }));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: async () => {
    await Promise.resolve();
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
  world.settings.clear();
  world.toastError.mockClear();
});

/**
 * One question's searches as the chat runs them: the same tool call repeated,
 * against a counter this helper owns so the test can read what was charged.
 * The effect starts at once, and `answers` resolves with every attempt's result.
 */
function askQuestion(calls: number) {
  const spent = { used: 0 };
  const tool = webSearchTool();
  const call = { id: 'c', name: 'web_search', arguments: '{"query":"news"}' };
  const answers = Effect.runPromise(
    Effect.forEach(Array.from({ length: calls }), () => Effect.result(tool.run(call))).pipe(
      Effect.provideService(questionSearches, spent)
    )
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
  });

  it('charges nothing for five searches that never reach the proxy', async () => {
    world.transportFailures = 5;

    const { spent, answers } = askQuestion(5);
    const outcome = await answers;

    expect(outcome.every(answer => Result.isFailure(answer))).toBe(true);
    expect(world.requests).toHaveLength(5);
    expect(spent.used).toBe(0);
  });

  it('allows five answered searches and refuses the sixth with the limit reason', async () => {
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
    expect(world.requests).toHaveLength(5);
    expect(spent.used).toBe(5);
    expect(reasonOf(outcome[5])).toContain('5 web searches, the limit');
  });

  it('charges nothing when the proxy answers 402 for used-up free searches', async () => {
    world.response = {
      status: 402,
      body: '{"error":"Exa free allowance exhausted and no credit balance available"}',
    };

    const { spent, answers } = askQuestion(1);
    const [answer] = await answers;

    expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
    expect(spent.used).toBe(0);
  });

  it('charges nothing when the proxy fails with status 500', async () => {
    world.response = { status: 500, body: '{"error":"upstream exploded"}' };

    const { spent, answers } = askQuestion(1);
    const [answer] = await answers;

    expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
    expect(spent.used).toBe(0);
  });

  it('charges a search Kilo answered even when the body cannot be read', async () => {
    world.response = { status: 200, body: '{"unexpected":true}' };

    const { spent, answers } = askQuestion(1);
    const [answer] = await answers;

    expect(Result.isFailure(answer ?? Result.fail(undefined))).toBe(true);
    // Kilo ran the search and billed the account, so the allowance still moved.
    expect(spent.used).toBe(1);
  });

  it('charges nothing when the search times out at fifteen seconds', async () => {
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
