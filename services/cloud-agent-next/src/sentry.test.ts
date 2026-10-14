import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/cloudflare';
import type { ErrorEvent } from '@sentry/core';
import { TRPCError } from '@trpc/server';
import { HTTPException } from 'hono/http-exception';
import {
  captureCloudAgentException,
  cloudAgentSentryOptions,
  instrumentCloudAgentWorker,
  shouldCaptureCloudAgentException,
} from './sentry.js';
import type { Env } from './types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const telemetryEnv = {
  CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
  CLOUD_AGENT_SENTRY_ENVIRONMENT: 'test',
  CF_VERSION_METADATA: { id: 'worker-version' },
};

function memoryOptions() {
  const events: ErrorEvent[] = [];
  const options: Sentry.CloudflareOptions = {
    ...cloudAgentSentryOptions(telemetryEnv),
    transport: () => ({
      send: async envelope => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === 'event') events.push(payload as ErrorEvent);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  };
  return { events, options };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext,
  };
}

describe('Cloud Agent exception policy', () => {
  it('does not report expected authentication, billing, or input errors', () => {
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'PAYMENT_REQUIRED'] as const) {
      expect(shouldCaptureCloudAgentException(new TRPCError({ code }))).toBe(false);
    }
    expect(shouldCaptureCloudAgentException(new HTTPException(400))).toBe(false);
    expect(shouldCaptureCloudAgentException(new HTTPException(503))).toBe(true);
    expect(shouldCaptureCloudAgentException(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' }))).toBe(
      true
    );
    expect(shouldCaptureCloudAgentException(new TypeError('Unexpected bug'))).toBe(true);
  });

  it('disables reporting when configuration is missing or malformed', () => {
    expect(cloudAgentSentryOptions({})).toMatchObject({ enabled: false, dsn: '' });
    expect(cloudAgentSentryOptions({ CLOUD_AGENT_SENTRY_DSN: 'not-a-dsn' })).toMatchObject({
      enabled: false,
      dsn: '',
    });
  });

  it('keeps the existing error path when capture itself fails', () => {
    vi.spyOn(Sentry.Scope.prototype, 'captureException').mockImplementation(() => {
      throw new Error('Sentry is unavailable');
    });
    expect(() =>
      captureCloudAgentException(new Error('Original bug'), { operation: 'http' })
    ).not.toThrow();
  });
});

describe('Cloud Agent Worker SDK capture', () => {
  it.each(['fetch', 'queue', 'scheduled'] as const)(
    'isolates overlapping %s calls when the second call flushes before the first',
    async handler => {
      const events: ErrorEvent[] = [];
      const transport = vi.fn(async (input: string, init: RequestInit) => {
        expect(new URL(input).origin).toBe('https://o1.ingest.sentry.io');
        expect(new URL(input).pathname).toBe('/api/42/envelope/');
        expect(init.method).toBe('POST');
        if (typeof init.body !== 'string') throw new Error('Expected a serialized Sentry envelope');
        const lines = init.body.split('\n');
        for (let index = 1; index < lines.length; index += 2) {
          const header = JSON.parse(lines[index]) as { type: string };
          expect(header.type).toBe('event');
          events.push(JSON.parse(lines[index + 1]) as ErrorEvent);
        }
        return new Response('', { status: 200 });
      });
      vi.stubGlobal('fetch', transport);
      const first = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        ...executionContext(),
      };
      const second = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        ...executionContext(),
      };
      async function report(sessionId: string): Promise<void> {
        const call = sessionId === 'workspace_first' ? first : second;
        call.started.resolve();
        await call.release.promise;
        captureCloudAgentException(new TypeError('private-request-failure'), {
          operation: handler,
          sessionId,
          messageId: `${sessionId}_message`,
        });
      }
      const worker = instrumentCloudAgentWorker({
        async fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
          await report(new URL(request.url).pathname.slice(1));
          return new Response('Internal error', { status: 500 });
        },
        async queue(batch: MessageBatch<unknown>, _env: Env, _ctx: ExecutionContext) {
          await report(batch.queue);
        },
        async scheduled(controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
          await report(controller.cron);
        },
      });
      async function dispatch(sessionId: string, ctx: ExecutionContext): Promise<void> {
        if (handler === 'fetch') {
          const response = await worker.fetch(
            new Request(`https://worker.example/${sessionId}`),
            telemetryEnv as Env,
            ctx
          );
          expect(response.status).toBe(500);
          await response.text();
        } else if (handler === 'queue') {
          await worker.queue(
            { queue: sessionId, messages: [] } as unknown as MessageBatch<unknown>,
            telemetryEnv as Env,
            ctx
          );
        } else {
          await worker.scheduled(
            { cron: sessionId, scheduledTime: Date.now() } as ScheduledController,
            telemetryEnv as Env,
            ctx
          );
        }
      }
      const firstCompletion = dispatch('workspace_first', first.ctx);
      const secondCompletion = dispatch('workspace_second', second.ctx);
      await Promise.all([first.started.promise, second.started.promise]);
      second.release.resolve();
      await secondCompletion;
      await Promise.all(second.pending);
      expect(events).toHaveLength(1);
      expect(events[0]?.contexts?.cloud_agent?.sessionId).toBe('workspace_second');
      first.release.resolve();
      await firstCompletion;
      await Promise.all(first.pending);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(events.map(event => event.contexts?.cloud_agent)).toEqual([
        {
          component: 'worker',
          operation: handler,
          sessionId: 'workspace_second',
          messageId: 'workspace_second_message',
        },
        {
          component: 'worker',
          operation: handler,
          sessionId: 'workspace_first',
          messageId: 'workspace_first_message',
        },
      ]);
      expect(events.every(event => event.release === 'worker-version')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('private-');
    }
  );

  it.each([undefined, '', 'not-a-dsn'])(
    'calls raw handlers without changing scope or synchronous behavior when DSN is %j',
    dsn => {
      const scopes: ReturnType<typeof Sentry.getCurrentScope>[] = [];
      const response = new Response('raw');
      const error = new TypeError('Raw queue fault');
      const transport = vi.fn();
      vi.stubGlobal('fetch', transport);
      const worker = instrumentCloudAgentWorker({
        fetch(_request: Request, _env: Env, _ctx: ExecutionContext) {
          scopes.push(Sentry.getCurrentScope());
          return response;
        },
        queue(_batch: MessageBatch<unknown>, _env: Env, _ctx: ExecutionContext): void {
          scopes.push(Sentry.getCurrentScope());
          throw error;
        },
        scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): void {
          scopes.push(Sentry.getCurrentScope());
        },
      });
      const scope = Sentry.getCurrentScope();
      const env = { CLOUD_AGENT_SENTRY_DSN: dsn } as Env;
      const { ctx, pending } = executionContext();
      expect(worker.fetch(new Request('https://worker.example/'), env, ctx)).toBe(response);
      expect(() =>
        worker.queue({ queue: 'test', messages: [] } as unknown as MessageBatch<unknown>, env, ctx)
      ).toThrow(error);
      expect(
        worker.scheduled(
          { cron: 'test', scheduledTime: Date.now() } as ScheduledController,
          env,
          ctx
        )
      ).toBeUndefined();
      expect(scopes).toHaveLength(3);
      for (const handlerScope of scopes) expect(handlerScope).toBe(scope);
      expect(pending).toEqual([]);
      expect(transport).not.toHaveBeenCalled();
    }
  );

  it('captures an uncaught request exception with a readable stack and safe metadata', async () => {
    const { events, options } = memoryOptions();
    const worker = Sentry.withSentry((_env: Env) => options, {
      async fetch(_request: Request, _env: Env, _ctx: ExecutionContext) {
        throw new TypeError('private-prompt-and-token');
      },
    });
    const { ctx, pending } = executionContext();
    await expect(
      worker.fetch(
        new Request('https://worker.example/stream?ticket=private-ticket'),
        telemetryEnv as Env,
        ctx
      )
    ).rejects.toThrow('private-prompt-and-token');
    await Promise.all(pending);
    expect(events).toHaveLength(1);
    expect(events[0]?.release).toBe('worker-version');
    expect(events[0]?.exception?.values?.[0]?.type).toBe('TypeError');
    expect(events[0]?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('private-');
  });

  it('captures handled internal failures once and excludes expected tRPC failures', async () => {
    const { events, options } = memoryOptions();
    const worker = Sentry.withSentry((_env: Env) => options, {
      async fetch(_request: Request, _env: Env, _ctx: ExecutionContext) {
        captureCloudAgentException(new TRPCError({ code: 'UNAUTHORIZED' }), {
          operation: 'send',
        });
        const error = new Error('private-message');
        captureCloudAgentException(error, { operation: 'send', sessionId: 'workspace_one' });
        captureCloudAgentException(error, { operation: 'send', sessionId: 'workspace_one' });
        return new Response('Internal error', { status: 500 });
      },
    });
    const { ctx, pending } = executionContext();
    expect(
      (
        await worker.fetch(
          new Request('https://worker.example/trpc/send'),
          telemetryEnv as Env,
          ctx
        )
      ).status
    ).toBe(500);
    await Promise.all(pending);
    expect(events).toHaveLength(1);
    expect(events[0]?.contexts?.cloud_agent).toEqual({
      component: 'worker',
      operation: 'send',
      sessionId: 'workspace_one',
    });
  });

  it('captures queue and scheduled faults without changing retries or rejection behavior', async () => {
    const { events, options } = memoryOptions();
    const worker = Sentry.withSentry((_env: Env) => options, {
      async queue(_batch: MessageBatch, _env: Env, _ctx: ExecutionContext) {
        throw new Error('Queue fault');
      },
      async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
        throw new Error('Scheduled fault');
      },
    });
    const { ctx, pending } = executionContext();
    await expect(
      worker.queue({ queue: 'test', messages: [] } as unknown as MessageBatch, {} as Env, ctx)
    ).rejects.toThrow('Queue fault');
    await expect(
      worker.scheduled(
        { cron: 'test', scheduledTime: Date.now() } as ScheduledController,
        telemetryEnv as Env,
        ctx
      )
    ).rejects.toThrow('Scheduled fault');
    await Promise.all(pending);
    expect(events).toHaveLength(2);
  });
});
