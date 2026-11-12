import type * as Sentry from '@sentry/bun';
import { getSentryConfig, SENTRY_ERROR_OPTIONS } from '../../src/shared/sentry.js';

export const WRAPPER_SENTRY_FLUSH_TIMEOUT_MS = 1_000;

export type WrapperSentryContext = {
  operation: 'uncaught_exception' | 'unhandled_rejection' | 'startup';
  sessionId?: string;
  wrapperRunId?: string;
  allocationId?: string;
  wrapperInstanceId?: string;
  providerInstanceId?: string;
  exitCode?: number;
};

export type WrapperSentryReporter = {
  capture(error: unknown, context: WrapperSentryContext): string | undefined;
  flush(): Promise<void>;
};

export async function createWrapperSentryReporter(options: {
  env: { CLOUD_AGENT_SENTRY_DSN?: string; CLOUD_AGENT_SENTRY_ENVIRONMENT?: string };
  log: (message: string) => void;
  transport?: Sentry.BunOptions['transport'];
}): Promise<WrapperSentryReporter> {
  let client: Sentry.NodeClient | undefined;
  let sdk: typeof Sentry | undefined;
  try {
    const config = getSentryConfig(options.env);
    if (config) {
      sdk = await import('@sentry/bun');
      const { applySdkMetadata } = await import('@sentry/core');
      const sentryGlobal: typeof globalThis & { SENTRY_RELEASE?: { id?: string } } = globalThis;
      const clientOptions: ConstructorParameters<typeof Sentry.NodeClient>[0] = {
        ...config,
        ...SENTRY_ERROR_OPTIONS,
        integrations: [],
        transport: options.transport ?? sdk.makeFetchTransport,
        stackParser: sdk.defaultStackParser,
        release: sentryGlobal.SENTRY_RELEASE?.id,
        runtime: { name: 'bun', version: Bun.version },
        includeServerName: false,
        sendClientReports: false,
        debug: false,
      };
      applySdkMetadata(clientOptions, 'bun');
      // SDK init installs Vercel signal hooks even with default integrations disabled.
      client = new sdk.NodeClient(clientOptions);
      client.init();
    }
  } catch {
    client = undefined;
  }

  return {
    capture(error, context) {
      if (!client || !sdk) return undefined;
      try {
        const scope = new sdk.Scope();
        scope.setClient(client);
        scope.setContext('cloud_agent', { ...context, component: 'wrapper' });
        const eventId = scope.captureException(
          error instanceof Error ? error : new Error('Non-Error wrapper failure')
        );
        options.log(`wrapper Sentry eventId=${eventId} operation=${context.operation}`);
        return eventId;
      } catch {
        return undefined;
      }
    },
    async flush() {
      if (!client) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.flush(WRAPPER_SENTRY_FLUSH_TIMEOUT_MS),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, WRAPPER_SENTRY_FLUSH_TIMEOUT_MS);
          }),
        ]);
      } catch {
        return;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
