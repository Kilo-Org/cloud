import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { ErrorEvent } from '@sentry/core';
import { getClient } from '@sentry/bun';
import { createLegacyCrashHandler } from './crash.js';
import { runLegacyWrapper } from './main.js';
import { runControlPlaneWrapper } from './control-plane/main.js';
import { CONTROL_PLANE_ALLOCATION_ID_ENV } from '../../src/shared/control-plane-protocol.js';
import { createWrapperSentryReporter, WRAPPER_SENTRY_FLUSH_TIMEOUT_MS } from './sentry.js';

async function memoryReporter(flush: () => Promise<boolean> = async () => true) {
  const events: ErrorEvent[] = [];
  const logs: string[] = [];
  const reporter = await createWrapperSentryReporter({
    env: {
      CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
      CLOUD_AGENT_SENTRY_ENVIRONMENT: 'test',
    },
    log: message => logs.push(message),
    transport: () => ({
      send: async envelope => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === 'event') events.push(payload as ErrorEvent);
        }
        return { statusCode: 200 };
      },
      flush,
    }),
  });
  return { reporter, events, logs };
}

describe('wrapper Sentry reporter', () => {
  it('captures the original exception and only safe per-capture metadata', async () => {
    const { reporter, events, logs } = await memoryReporter();
    const error = new TypeError('Wrapper crash private-error-message');
    Object.assign(error, { request: { authorization: 'private-token' }, env: 'private-env' });
    const eventId = reporter.capture(error, {
      operation: 'uncaught_exception',
      allocationId: 'allocation_one',
      providerInstanceId: 'sandbox_one',
      wrapperInstanceId: '65a7e4f8-df0f-4004-9439-226575a28c3c',
      exitCode: 1,
    });
    await reporter.flush();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.event_id).toBe(eventId);
    expect(event?.environment).toBe('test');
    expect(event?.exception?.values?.[0]?.type).toBe('TypeError');
    expect(event?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
    expect(event?.contexts?.cloud_agent).toEqual({
      component: 'wrapper',
      operation: 'uncaught_exception',
      allocationId: 'allocation_one',
      providerInstanceId: 'sandbox_one',
      wrapperInstanceId: '65a7e4f8-df0f-4004-9439-226575a28c3c',
      exitCode: 1,
    });
    expect(event).not.toHaveProperty('request');
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('extra');
    expect(event).not.toHaveProperty('breadcrumbs');
    expect(JSON.stringify(event)).not.toContain('private-token');
    expect(JSON.stringify(event)).not.toContain('private-env');
    expect(JSON.stringify(event)).not.toContain('private-error-message');
    expect(logs).toEqual([`wrapper Sentry eventId=${eventId} operation=uncaught_exception`]);
  });

  it('does not retain one session or allocation in the next capture', async () => {
    const { reporter, events } = await memoryReporter();
    reporter.capture(new Error('First'), {
      operation: 'startup',
      sessionId: 'agent_one',
      wrapperRunId: 'run_one',
      exitCode: 1,
    });
    reporter.capture(new Error('Second'), {
      operation: 'unhandled_rejection',
      allocationId: 'allocation_two',
    });
    await reporter.flush();
    expect(events).toHaveLength(2);
    expect(events[0]?.contexts?.cloud_agent).toMatchObject({
      sessionId: 'agent_one',
      wrapperRunId: 'run_one',
    });
    expect(events[1]?.contexts?.cloud_agent).toEqual({
      component: 'wrapper',
      operation: 'unhandled_rejection',
      allocationId: 'allocation_two',
    });
  });

  it('does not serialize non-Error rejection objects', async () => {
    const { reporter, events } = await memoryReporter();
    reporter.capture(
      { request: { authorization: 'private-token' }, prompt: 'private-prompt' },
      { operation: 'unhandled_rejection' }
    );
    await reporter.flush();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('private-token');
    expect(JSON.stringify(events)).not.toContain('private-prompt');
  });

  it('does not install global crash handlers or send a duplicate original Error', async () => {
    const uncaughtListeners = process.listeners('uncaughtException');
    const rejectionListeners = process.listeners('unhandledRejection');
    const sigtermListeners = process.listeners('SIGTERM');
    const beforeExitListeners = process.listeners('beforeExit');
    const globalClient = getClient();
    const vercel = process.env.VERCEL;
    process.env.VERCEL = '1';
    let memory: Awaited<ReturnType<typeof memoryReporter>>;
    try {
      memory = await memoryReporter();
    } finally {
      if (vercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = vercel;
    }
    const { reporter, events } = memory;
    expect(process.listeners('uncaughtException')).toEqual(uncaughtListeners);
    expect(process.listeners('unhandledRejection')).toEqual(rejectionListeners);
    expect(process.listeners('SIGTERM')).toEqual(sigtermListeners);
    expect(process.listeners('beforeExit')).toEqual(beforeExitListeners);
    expect(getClient()).toBe(globalClient);
    const error = new Error('Wrapper crash');
    reporter.capture(error, { operation: 'uncaught_exception', exitCode: 1 });
    reporter.capture(error, { operation: 'startup', exitCode: 1 });
    await reporter.flush();
    expect(events).toHaveLength(1);
  });

  it('uses the baked wrapper release instead of generic Worker or session release env', async () => {
    const sentryGlobal: typeof globalThis & { SENTRY_RELEASE?: { id?: string } } = globalThis;
    const originalGlobal = sentryGlobal.SENTRY_RELEASE;
    const originalEnv = process.env.SENTRY_RELEASE;
    try {
      sentryGlobal.SENTRY_RELEASE = { id: 'cloud-agent-wrapper@immutable-bundle' };
      process.env.SENTRY_RELEASE = 'worker@newer-deployment';
      const { reporter, events } = await memoryReporter();
      reporter.capture(new Error('Wrapper crash'), { operation: 'startup', exitCode: 1 });
      await reporter.flush();
      expect(events[0]?.release).toBe('cloud-agent-wrapper@immutable-bundle');
    } finally {
      if (originalGlobal === undefined) delete sentryGlobal.SENTRY_RELEASE;
      else sentryGlobal.SENTRY_RELEASE = originalGlobal;
      if (originalEnv === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = originalEnv;
    }
  });

  it('is a no-op without a DSN and does not construct a transport', async () => {
    let transports = 0;
    const logs: string[] = [];
    const reporter = await createWrapperSentryReporter({
      env: {},
      log: message => logs.push(message),
      transport: () => {
        transports += 1;
        throw new Error('No transport should be created');
      },
    });
    expect(reporter.capture(new Error('Wrapper crash'), { operation: 'startup' })).toBeUndefined();
    await reporter.flush();
    expect(transports).toBe(0);
    expect(logs).toEqual([]);
  });

  it.each(['', 'invalid-dsn'])(
    'does not load the SDK or tracing for DSN=%j in a fresh process',
    async dsn => {
      const child = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
const sdkModules = () => Object.keys(require.cache).filter(path =>
  path.includes('@sentry') || path.includes('@opentelemetry')
);
const { createWrapperSentryReporter } = await import(${JSON.stringify(join(import.meta.dir, 'sentry.ts'))});
const logs = [];
const reporter = await createWrapperSentryReporter({
  env: { CLOUD_AGENT_SENTRY_DSN: ${JSON.stringify(dsn)} },
  log: message => logs.push(message),
});
const noCapture = reporter.capture(new Error('Wrapper crash'), { operation: 'startup' }) === undefined;
await reporter.flush();
const disabled = { sdkModules: sdkModules(), logs, noCapture };
await createWrapperSentryReporter({
  env: { CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42' },
  log: message => logs.push(message),
});
console.log(JSON.stringify({ ...disabled, enabledLoadsSdk: sdkModules().length > 0 }));
`,
        ],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 }
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        expect(await child.exited).toBe(0);
        expect(await stderr).toBe('');
        expect(JSON.parse(await stdout)).toEqual({
          sdkModules: [],
          logs: [],
          noCapture: true,
          enabledLoadsSdk: true,
        });
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    }
  );

  it('hard-bounds a transport flush that never settles', async () => {
    const { reporter } = await memoryReporter(() => new Promise<boolean>(() => undefined));
    reporter.capture(new Error('Wrapper crash'), { operation: 'startup', exitCode: 1 });
    const started = Date.now();
    await reporter.flush();
    expect(Date.now() - started).toBeGreaterThanOrEqual(WRAPPER_SENTRY_FLUSH_TIMEOUT_MS - 20);
    expect(Date.now() - started).toBeLessThan(WRAPPER_SENTRY_FLUSH_TIMEOUT_MS + 1_000);
  });

  it('swallows initialization, transport, and logging failures', async () => {
    const unavailable = await createWrapperSentryReporter({
      env: { CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42' },
      log: () => undefined,
      transport: () => {
        throw new Error('Transport initialization failed');
      },
    });
    expect(unavailable.capture(new Error('Crash'), { operation: 'startup' })).toBeUndefined();
    await unavailable.flush();

    const { reporter } = await memoryReporter(async () => {
      throw new Error('Transport flush failed');
    });
    reporter.capture(new Error('Crash'), { operation: 'startup' });
    await reporter.flush();

    const loggingFailure = await createWrapperSentryReporter({
      env: { CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42' },
      log: () => {
        throw new Error('Logging failed');
      },
      transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
    });
    expect(() =>
      loggingFailure.capture(new Error('Crash'), { operation: 'startup' })
    ).not.toThrow();
    await loggingFailure.flush();
  });
});

describe('legacy wrapper crash capture', () => {
  for (const operation of ['uncaught_exception', 'unhandled_rejection'] as const) {
    it(`captures ${operation} once and preserves fatal exit and log finalization`, async () => {
      const { reporter, events } = await memoryReporter();
      const exited = Promise.withResolvers<number>();
      const logsFinalized = Promise.withResolvers<void>();
      let finalizes = 0;
      const handler = createLegacyCrashHandler({
        sentry: reporter,
        getContext: () => ({ sessionId: 'agent_one', wrapperRunId: 'run_one' }),
        isShuttingDown: () => false,
        log: () => undefined,
        finalizeLogs: async () => {
          finalizes += 1;
          await logsFinalized.promise;
        },
        exit: code => exited.resolve(code),
      });
      const error = new TypeError('Wrapper crash');
      handler(operation, error);
      handler(operation, error);
      await reporter.flush();
      expect(events).toHaveLength(1);
      expect(events[0]?.exception?.values?.[0]?.type).toBe('TypeError');
      expect(events[0]?.contexts?.cloud_agent).toEqual({
        component: 'wrapper',
        operation,
        sessionId: 'agent_one',
        wrapperRunId: 'run_one',
        exitCode: 1,
      });
      expect(finalizes).toBe(1);
      logsFinalized.resolve();
      expect(await exited.promise).toBe(1);
    });
  }

  it('ignores failures during an existing signal shutdown', async () => {
    const { reporter, events, logs } = await memoryReporter();
    const handler = createLegacyCrashHandler({
      sentry: reporter,
      getContext: () => {
        throw new Error('No context should be read during shutdown');
      },
      isShuttingDown: () => true,
      log: () => {
        throw new Error('No crash log should be written during shutdown');
      },
      finalizeLogs: async () => {
        throw new Error('No logs should be finalized twice');
      },
      exit: () => {
        throw new Error('No second exit should be requested');
      },
    });
    handler('uncaught_exception', new Error('Shutdown error'));
    handler('unhandled_rejection', new Error('Shutdown rejection'));
    await reporter.flush();
    expect(events).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe('wrapper fatal startup capture', () => {
  it('captures and flushes the legacy startup exception once before rejecting', async () => {
    const { reporter, events } = await memoryReporter();
    const originalArgv = process.argv;
    try {
      process.argv = [process.execPath, 'wrapper'];
      const error = await runLegacyWrapper(reporter).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Missing required --agent-session argument');
      expect(events).toHaveLength(1);
      expect(events[0]?.contexts?.cloud_agent).toEqual({
        component: 'wrapper',
        operation: 'startup',
        exitCode: 1,
      });
      expect(events[0]?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('captures and flushes an original control-plane startup exception with wrapper identities', async () => {
    const { reporter, events } = await memoryReporter();
    const error = new TypeError('Startup error');
    const env = {
      [CONTROL_PLANE_ALLOCATION_ID_ENV]: 'allocation_startup',
      PROVIDER_INSTANCE_ID: 'sandbox_startup',
      CONTROL_WRAPPER_INSTANCE_ID: '65a7e4f8-df0f-4004-9439-226575a28c3c',
    };
    Object.defineProperty(env, 'CONTROL_LOG_UPLOAD_URL', {
      get: () => {
        throw error;
      },
    });
    expect(await runControlPlaneWrapper(env, reporter).catch(error => error)).toBe(error);
    expect(events).toHaveLength(1);
    expect(events[0]?.exception?.values?.[0]?.type).toBe('TypeError');
    expect(events[0]?.contexts?.cloud_agent).toEqual({
      component: 'wrapper',
      operation: 'startup',
      exitCode: 1,
      allocationId: 'allocation_startup',
      providerInstanceId: 'sandbox_startup',
      wrapperInstanceId: '65a7e4f8-df0f-4004-9439-226575a28c3c',
    });
  });
});
