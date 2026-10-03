import { describe, expect, test } from 'bun:test';
import {
  composeReviewSummary,
  createGitHubReviewPublisher,
  extractSummaryRemainder,
  GitHubReviewPublishError,
  resolveApiBaseUrl,
  type GitHubReviewPublisherDeps,
} from './github-review-publish-mcp.js';
import type { GitHubReviewTarget } from '../../src/shared/github-review-target.js';

const TARGET: GitHubReviewTarget = {
  repo: 'acme/widgets',
  pullRequestNumber: 42,
  appType: 'standard',
  botUserId: '9001',
};

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

type Call = { method: string; url: string; body?: unknown };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makePublisher(handler: (call: Call) => Response | Promise<Response>): {
  publish: ReturnType<typeof createGitHubReviewPublisher>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const deps: GitHubReviewPublisherDeps = {
    target: TARGET,
    token: 'ghs_test',
    apiBaseUrl: 'https://api.github.com',
    sleep: async () => {},
    fetchImpl: async (input, init) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: input,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      };
      calls.push(call);
      return handler(call);
    },
  };
  return { publish: createGitHubReviewPublisher(deps), calls };
}

describe('extractSummaryRemainder', () => {
  test('strips model-supplied reserved blocks and markers', () => {
    const remainder = extractSummaryRemainder(
      [
        '<!-- kilo-review -->',
        '## Code Review',
        'Looks good.',
        '<!-- kilo-council-verdict:start -->',
        'council',
        '<!-- kilo-council-verdict:end -->',
        '<!-- kilo-review-history -->',
        'old',
        '<!-- /kilo-review-history -->',
        '---',
        '<!-- kilo-usage -->',
        '<sub>Reviewed by model</sub>',
      ].join('\n')
    );
    expect(remainder).toBe('## Code Review\nLooks good.');
  });
});

describe('composeReviewSummary', () => {
  test('rejects empty and marker-only bodies', () => {
    expect(composeReviewSummary({ modelBody: '   ' })).toEqual({
      ok: false,
      reason: 'rejected_body',
    });
    expect(
      composeReviewSummary({
        modelBody:
          '<!-- kilo-review -->\n<!-- kilo-review-history -->\n<!-- /kilo-review-history -->',
      })
    ).toEqual({ ok: false, reason: 'rejected_body' });
  });

  test('adds exactly one leading marker', () => {
    const composed = composeReviewSummary({ modelBody: '## Code Review\nHello' });
    expect(composed).toEqual({
      ok: true,
      body: '<!-- kilo-review -->\n\n## Code Review\nHello',
    });
  });

  test('preserves trusted blocks when updating an owned comment', () => {
    const existing = [
      '<!-- kilo-review -->',
      '## Code Review',
      '<!-- kilo-council-verdict:start -->',
      'council',
      '<!-- kilo-council-verdict:end -->',
      '<!-- kilo-review-history -->',
      'old',
      '<!-- /kilo-review-history -->',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Reviewed by model</sub>',
    ].join('\n');
    const composed = composeReviewSummary({
      modelBody: '## Code Review\nNew',
      existingBody: existing,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.body).toContain('<!-- kilo-council-verdict:start -->\ncouncil');
    expect(composed.body).toContain('<!-- kilo-review-history -->\nold');
    expect(composed.body).toContain('---\n<!-- kilo-usage -->');
    expect(composed.body.startsWith('<!-- kilo-review -->\n\n## Code Review\nNew')).toBe(true);
  });
});

describe('createGitHubReviewPublisher', () => {
  test('creates a summary comment and verifies it', async () => {
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      if (call.method === 'POST') {
        const body = (call.body as { body: string }).body;
        return jsonResponse({ id: 5, body, user: { id: 9001 }, html_url: 'https://x/5' });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/5')) {
        return jsonResponse({
          id: 5,
          body: '<!-- kilo-review -->\n\nHello',
          user: { id: 9001 },
          html_url: 'https://x/5',
        });
      }
      return jsonResponse({}, 500);
    });
    const result = await publish('Hello', new AbortController().signal);
    expect(result).toEqual({ commentId: 5, url: 'https://x/5' });
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
  });

  test('patches the latest owned summary instead of creating', async () => {
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?')) {
        return jsonResponse([
          {
            id: 1,
            body: '<!-- kilo-review -->\nold',
            user: { id: 9001 },
            updated_at: '2020-01-01',
          },
          { id: 2, body: 'someone else', user: { id: 7 } },
        ]);
      }
      if (call.method === 'PATCH' && call.url.endsWith('/issues/comments/1')) {
        return jsonResponse({
          id: 1,
          body: (call.body as { body: string }).body,
          user: { id: 9001 },
        });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/1')) {
        return jsonResponse({
          id: 1,
          body: '<!-- kilo-review -->\n\nNew',
          user: { id: 9001 },
          html_url: 'https://x/1',
        });
      }
      return jsonResponse({}, 500);
    });
    const result = await publish('New', new AbortController().signal);
    expect(result.commentId).toBe(1);
    expect(calls.some(call => call.method === 'POST')).toBe(false);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  test('returns locked without waiting', async () => {
    const { publish } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      return jsonResponse({ message: 'Locked' }, 403);
    });
    const error = await caught(publish('Hello', new AbortController().signal));
    expect(error).toMatchObject({ code: 'locked' });
  });

  test('returns scan_limit when the page cap is hit with no owned summary', async () => {
    const { publish } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?')) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            body: 'other',
            user: { id: 7 },
          }))
        );
      }
      return jsonResponse({}, 500);
    });
    const error = await caught(publish('Hello', new AbortController().signal));
    expect(error).toMatchObject({ code: 'scan_limit' });
  });

  test('retries once within the rate-limit window and returns rate_limited beyond it', async () => {
    let writes = 0;
    const ok = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      if (call.method === 'POST') {
        writes += 1;
        if (writes === 1) return new Response('', { status: 429, headers: { 'retry-after': '5' } });
        return jsonResponse({
          id: 9,
          body: (call.body as { body: string }).body,
          user: { id: 9001 },
        });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/9')) {
        return jsonResponse({ id: 9, body: '<!-- kilo-review -->\n\nHello', user: { id: 9001 } });
      }
      return jsonResponse({}, 500);
    });
    const result = await ok.publish('Hello', new AbortController().signal);
    expect(result).toMatchObject({ commentId: 9 });
    expect(writes).toBe(2);

    const tooLong = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      return new Response('', { status: 429, headers: { 'retry-after': '120' } });
    });
    const tooLongError = await caught(tooLong.publish('Hello', new AbortController().signal));
    expect(tooLongError).toMatchObject({ code: 'rate_limited' });
  });

  test('reuses an owned publication-failure comment by patching it into the summary', async () => {
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?')) {
        return jsonResponse([
          {
            id: 8,
            body: '<!-- kilo-review-publication-failure -->',
            user: { id: 9001 },
            updated_at: '2026-01-01',
          },
        ]);
      }
      if (call.method === 'PATCH' && call.url.endsWith('/issues/comments/8')) {
        return jsonResponse({
          id: 8,
          body: (call.body as { body: string }).body,
          user: { id: 9001 },
        });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/8')) {
        return jsonResponse({
          id: 8,
          body: '<!-- kilo-review -->\n\nRecovered',
          user: { id: 9001 },
          html_url: 'https://x/8',
        });
      }
      return jsonResponse({}, 500);
    });
    const result = await publish('Recovered', new AbortController().signal);
    expect(result.commentId).toBe(8);
    expect(calls.some(call => call.method === 'POST')).toBe(false);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  test('rejects an over-long composed body without writing', async () => {
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      return jsonResponse({}, 500);
    });
    const error = await caught(publish('x'.repeat(70_000), new AbortController().signal));
    expect(error).toMatchObject({ code: 'rejected_body' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  test('rejects an over-long body formed by preserved trusted blocks without writing', async () => {
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?')) {
        return jsonResponse([
          {
            id: 12,
            body: `<!-- kilo-review -->\nold\n\n<!-- kilo-review-history -->\n${'h'.repeat(66_000)}\n<!-- /kilo-review-history -->`,
            user: { id: 9001 },
            updated_at: '2026-01-01',
          },
        ]);
      }
      return jsonResponse({}, 500);
    });
    const error = await caught(publish('New wording', new AbortController().signal));
    expect(error).toMatchObject({ code: 'rejected_body' });
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  test('ignores a user-copied marker and creates a new owned summary', async () => {
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?')) {
        return jsonResponse([
          {
            id: 4,
            body: '<!-- kilo-review -->\n## Code Review Summary\nCopied by a user',
            user: { id: 7 },
            updated_at: '2026-05-01',
          },
        ]);
      }
      if (call.method === 'POST') {
        return jsonResponse({
          id: 13,
          body: (call.body as { body: string }).body,
          user: { id: 9001 },
        });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/13')) {
        return jsonResponse({
          id: 13,
          body: '<!-- kilo-review -->\n\nNew',
          user: { id: 9001 },
        });
      }
      return jsonResponse({}, 500);
    });
    const result = await publish('New', new AbortController().signal);
    expect(result.commentId).toBe(13);
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  test('posts the exact body JSON with quotes, newlines, and non-ASCII characters', async () => {
    const remainder = 'say "hi"\nsecond line café ☕ 日本語';
    const { publish, calls } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      if (call.method === 'POST') {
        return jsonResponse({
          id: 21,
          body: (call.body as { body: string }).body,
          user: { id: 9001 },
        });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/21')) {
        return jsonResponse({
          id: 21,
          body: `<!-- kilo-review -->\n\n${remainder}`,
          user: { id: 9001 },
        });
      }
      return jsonResponse({}, 500);
    });
    const result = await publish(remainder, new AbortController().signal);
    expect(result.commentId).toBe(21);
    const posted = calls.find(call => call.method === 'POST')?.body as { body: string };
    expect(posted.body).toBe(`<!-- kilo-review -->\n\n${remainder}`);
  });

  test('returns unverified when the fetched body does not match', async () => {
    const { publish } = makePublisher(call => {
      if (call.method === 'GET' && call.url.includes('/issues/42/comments?'))
        return jsonResponse([]);
      if (call.method === 'POST') {
        return jsonResponse({
          id: 3,
          body: (call.body as { body: string }).body,
          user: { id: 9001 },
        });
      }
      if (call.method === 'GET' && call.url.endsWith('/issues/comments/3')) {
        return jsonResponse({ id: 3, body: 'tampered', user: { id: 9001 } });
      }
      return jsonResponse({}, 500);
    });
    const error = await caught(publish('Hello', new AbortController().signal));
    expect(error).toBeInstanceOf(GitHubReviewPublishError);
  });

  test('maps a locked list response to locked instead of prompting', async () => {
    const { publish } = makePublisher(() => jsonResponse({ message: 'Locked' }, 403));
    const error = await caught(publish('Hello', new AbortController().signal));
    expect(error).toMatchObject({ code: 'locked' });
  });

  test('applies the rate-limit rule to a list response', async () => {
    const { publish } = makePublisher(
      () => new Response('', { status: 429, headers: { 'retry-after': '120' } })
    );
    const error = await caught(publish('Hello', new AbortController().signal));
    expect(error).toMatchObject({ code: 'rate_limited' });
  });

  test('refuses a non-loopback API base override', async () => {
    expect(resolveApiBaseUrl({})).toBe('https://api.github.com');
    expect(resolveApiBaseUrl({ KILO_GITHUB_REVIEW_API_BASE: 'http://127.0.0.1:8080' })).toBe(
      'http://127.0.0.1:8080'
    );
    expect(resolveApiBaseUrl({ KILO_GITHUB_REVIEW_API_BASE: 'https://evil.example' })).toBeNull();

    const { calls } = makePublisher(() => jsonResponse({}, 500));
    expect(
      await caught(
        createGitHubReviewPublisher({
          target: TARGET,
          token: 'ghs_test',
          apiBaseUrl: null,
          sleep: async () => {},
          fetchImpl: async (input, init) => {
            calls.push({ method: init?.method ?? 'GET', url: input });
            return jsonResponse({}, 500);
          },
        })('Hello', new AbortController().signal)
      )
    ).toMatchObject({ code: 'misconfigured' });
    expect(calls).toHaveLength(0);
  });
});
