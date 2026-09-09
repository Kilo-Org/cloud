import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyGitHubRateLimitBody,
  GITHUB_RATE_LIMIT_DIAGNOSTIC_BODY_DEADLINE_MS,
  GITHUB_RATE_LIMIT_DIAGNOSTIC_MAX_BODY_BYTES,
  inspectGitHubRateLimitResponse,
} from './github-rate-limit-diagnostics.js';

describe('classifyGitHubRateLimitBody', () => {
  it.each([
    ['API rate limit exceeded', 'primary_limit'],
    ['You have exceeded a secondary rate limit.', 'secondary_limit'],
    ['You have triggered an abuse detection mechanism.', 'abuse_detection'],
    ['429 Too Many Requests', 'too_many_requests'],
    ['The upstream service is unavailable.', 'unavailable'],
    ['permission denied', 'none'],
  ] as const)('classifies %s as %s', (body, signal) => {
    expect(classifyGitHubRateLimitBody(body)).toBe(signal);
  });
});

describe('inspectGitHubRateLimitResponse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([200, 404])('does not inspect a %i response', async status => {
    const response = new Response('API rate limit exceeded', { status });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toBeUndefined();
    await expect(response.text()).resolves.toBe('API rate limit exceeded');
  });

  it('classifies zero remaining as primary exhaustion and copies only safe headers', async () => {
    const response = new Response('permission denied', {
      status: 403,
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-used': '5000',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-resource': 'core',
        'retry-after': '60',
        authorization: 'Bearer body-secret',
      },
    });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toEqual({
      upstreamStatus: 403,
      githubRateLimitLimit: '5000',
      githubRateLimitRemaining: '0',
      githubRateLimitUsed: '5000',
      githubRateLimitReset: '1700000000',
      githubRateLimitResource: 'core',
      githubRetryAfter: '60',
      quotaClass: 'primary_exhausted',
      bodySignal: 'none',
    });
  });

  it('classifies a primary-limit body without remaining as a primary signal', async () => {
    const response = new Response('API rate limit exceeded', { status: 429 });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toMatchObject({
      quotaClass: 'primary_signal',
      bodySignal: 'primary_limit',
    });
  });

  it.each([
    ['You have exceeded a secondary rate limit.', 'secondary_limit'],
    ['You have triggered an abuse detection mechanism.', 'abuse_detection'],
  ] as const)('classifies %s as secondary or abuse evidence', async (body, bodySignal) => {
    const response = new Response(body, { status: 403 });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toMatchObject({
      quotaClass: 'secondary_or_abuse_signal',
      bodySignal,
    });
  });

  it('does not turn a generic too-many-requests body into a secondary quota claim', async () => {
    const response = new Response('Too Many Requests', { status: 429 });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toMatchObject({
      quotaClass: 'unknown',
      bodySignal: 'too_many_requests',
    });
  });

  it('keeps an empty diagnostic unknown when headers and body provide no usable evidence', async () => {
    const response = new Response('', {
      status: 429,
      headers: {
        'x-ratelimit-limit': 'not-a-number',
        'x-ratelimit-remaining': '0, 1',
        'x-ratelimit-used': '-1',
        'x-ratelimit-reset': '99999999999999999',
        'x-ratelimit-resource': 'core resource',
        'retry-after': 'not-a-delay',
      },
    });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toEqual({
      upstreamStatus: 429,
      quotaClass: 'unknown',
      bodySignal: 'none',
    });
  });

  it('does not retain or decode bytes beyond the bounded prefix', async () => {
    const body = `${'x'.repeat(GITHUB_RATE_LIMIT_DIAGNOSTIC_MAX_BODY_BYTES)} API rate limit exceeded`;
    const response = new Response(body, { status: 429 });

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toMatchObject({
      quotaClass: 'unknown',
      bodySignal: 'none',
    });
    await expect(response.text()).resolves.toBe(body);
  });

  it('leaves the original response body readable after inspecting a clone', async () => {
    const body = 'provider-body-secret: API rate limit exceeded';
    const response = new Response(body, { status: 403 });

    const diagnostic = await inspectGitHubRateLimitResponse(response);

    expect(await response.text()).toBe(body);
    expect(JSON.stringify(diagnostic)).not.toContain(body);
    expect(JSON.stringify(diagnostic)).not.toContain('provider-body-secret');
  });

  it('finishes a stalled cloned body at the total deadline', async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 403 }
    );
    const pending = inspectGitHubRateLimitResponse(response);

    await vi.advanceTimersByTimeAsync(GITHUB_RATE_LIMIT_DIAGNOSTIC_BODY_DEADLINE_MS);

    await expect(pending).resolves.toMatchObject({ quotaClass: 'unknown', bodySignal: 'none' });
  });

  it('uses one total deadline for a slow trickle instead of a deadline per chunk', async () => {
    vi.useFakeTimers();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (scheduled !== undefined) return;
          scheduled = setTimeout(() => {
            scheduled = undefined;
            controller.enqueue(new TextEncoder().encode('x'));
          }, 60);
        },
      }),
      { status: 429 }
    );
    const pending = inspectGitHubRateLimitResponse(response);

    await vi.advanceTimersByTimeAsync(GITHUB_RATE_LIMIT_DIAGNOSTIC_BODY_DEADLINE_MS + 1);

    await expect(pending).resolves.toMatchObject({ quotaClass: 'unknown', bodySignal: 'none' });
  });

  it('does not wait for a clone cancellation that rejects', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const reader = {
      read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      cancel,
    };
    const response = {
      status: 429,
      headers: new Headers(),
      clone: vi.fn(() => ({ body: { getReader: () => reader } })),
    } as unknown as Response;

    await expect(inspectGitHubRateLimitResponse(response)).resolves.toMatchObject({
      quotaClass: 'unknown',
      bodySignal: 'none',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not wait for a clone cancellation that never settles', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<never>(() => undefined));
    const reader = {
      read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      cancel,
    };
    const response = {
      status: 429,
      headers: new Headers(),
      clone: vi.fn(() => ({ body: { getReader: () => reader } })),
    } as unknown as Response;
    const inspection = inspectGitHubRateLimitResponse(response).then(() => 'resolved' as const);
    const outcome = Promise.race([
      inspection,
      new Promise<'timed_out'>(resolve => setTimeout(() => resolve('timed_out'), 10)),
    ]);

    await vi.advanceTimersByTimeAsync(10);

    await expect(outcome).resolves.toBe('resolved');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('turns clone and read failures into unknown body evidence', async () => {
    const cloneFailure = {
      status: 403,
      headers: new Headers(),
      clone: vi.fn(() => {
        throw new Error('clone failed');
      }),
    } as unknown as Response;
    await expect(inspectGitHubRateLimitResponse(cloneFailure)).resolves.toMatchObject({
      quotaClass: 'unknown',
      bodySignal: 'none',
    });

    const readFailure = {
      status: 403,
      headers: new Headers(),
      clone: vi.fn(() => ({
        body: {
          getReader: () => ({
            read: vi.fn().mockRejectedValue(new Error('read failed')),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
      })),
    } as unknown as Response;
    await expect(inspectGitHubRateLimitResponse(readFailure)).resolves.toMatchObject({
      quotaClass: 'unknown',
      bodySignal: 'none',
    });
  });
});
