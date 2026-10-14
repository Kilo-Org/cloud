import * as Sentry from '@sentry/cloudflare';
import { TRPCError } from '@trpc/server';
import { HTTPException } from 'hono/http-exception';
import type { DurableObject } from 'cloudflare:workers';
import type { Env } from './types.js';
import { logger } from './logger.js';
import { sessionIdFromDoName } from './session-plane.js';
import { getSentryConfig, sanitizeSentryEvent, SENTRY_ERROR_OPTIONS } from './shared/sentry.js';

export function shouldCaptureCloudAgentException(error: unknown): boolean {
  if (error instanceof TRPCError) return error.code === 'INTERNAL_SERVER_ERROR';
  if (error instanceof HTTPException) return error.status >= 500;
  return true;
}

export function cloudAgentSentryOptions(
  env: Pick<
    Env,
    'CLOUD_AGENT_SENTRY_DSN' | 'CLOUD_AGENT_SENTRY_ENVIRONMENT' | 'CF_VERSION_METADATA'
  >,
  component = 'worker',
  identity: { sessionId?: string; sandboxId?: string } = {}
): Sentry.CloudflareOptions {
  const config = getSentryConfig(env);
  return {
    ...SENTRY_ERROR_OPTIONS,
    ...config,
    dsn: config?.dsn ?? '',
    enabled: config !== undefined,
    release: env.CF_VERSION_METADATA?.id,
    spotlight: false,
    debug: false,
    skipOpenTelemetrySetup: true,
    initialScope: { contexts: { cloud_agent: { component, ...identity } } },
    beforeSend(event, hint) {
      if (!shouldCaptureCloudAgentException(hint.originalException)) return null;
      const tags = logger.getTags();
      const sanitized = sanitizeSentryEvent({
        ...event,
        contexts: {
          cloud_agent: {
            sessionId: tags.sessionId,
            sandboxId: tags.sandboxId,
            ...event.contexts?.cloud_agent,
          },
        },
      });
      if (sanitized) {
        logger
          .withFields({ sentryEventId: sanitized.event_id, component, ...identity })
          .error('Cloud Agent exception captured');
      }
      return sanitized;
    },
  };
}

export function captureCloudAgentException(
  error: unknown,
  context: { operation: string; sessionId?: string; messageId?: string }
): void {
  if (!shouldCaptureCloudAgentException(error)) return;
  try {
    Sentry.withScope(scope => {
      scope.setContext('cloud_agent', { component: 'worker', ...context });
      scope.captureException(error);
    });
  } catch {
    // Error reporting must not change the original response or retry policy.
  }
}

export function instrumentCloudAgentWorker<
  T extends Required<Pick<ExportedHandler<Env>, 'fetch' | 'queue' | 'scheduled'>>,
>(worker: T) {
  const instrumented = Sentry.withSentry((env: Env) => cloudAgentSentryOptions(env), { ...worker });
  return {
    ...worker,
    fetch(...args: Parameters<T['fetch']>) {
      if (!getSentryConfig(args[1])) return worker.fetch(args[0], args[1], args[2]);
      // SDK request initialization otherwise mutates a shared current scope before awaiting.
      return Sentry.withScope(() => instrumented.fetch(args[0], args[1], args[2]));
    },
    queue(...args: Parameters<T['queue']>) {
      if (!getSentryConfig(args[1])) return worker.queue(args[0], args[1], args[2]);
      return Sentry.withScope(() => instrumented.queue(args[0], args[1], args[2]));
    },
    scheduled(...args: Parameters<T['scheduled']>) {
      if (!getSentryConfig(args[1])) return worker.scheduled(args[0], args[1], args[2]);
      return Sentry.withScope(() => instrumented.scheduled(args[0], args[1], args[2]));
    },
  };
}

export function instrumentCloudAgentDurableObject<
  T extends DurableObject<Env>,
  C extends new (ctx: DurableObjectState, env: Env) => T,
>(DurableObjectClass: C, component: string): C {
  return new Proxy(DurableObjectClass, {
    construct(target, args, newTarget) {
      const [ctx, env] = args as [DurableObjectState, Env];
      if (!getSentryConfig(env)) return Reflect.construct(target, args, newTarget) as T;
      const name = ctx.id.name;
      const identity =
        component === 'session' || component === 'legacy-session'
          ? { sessionId: name === undefined ? undefined : sessionIdFromDoName(name) }
          : component === 'sandbox-control' || component === 'sandbox-container'
            ? { sandboxId: name }
            : {};
      const instrumented = Sentry.instrumentDurableObjectWithSentry(
        (_env: Env) => ({
          ...cloudAgentSentryOptions(env, component, identity),
          // These RPC callers are not all Sentry-instrumented. The pinned SDK's
          // replacement option skips capture when the caller has no trace metadata.
          instrumentPrototypeMethods: true,
        }),
        target
      );
      return Reflect.construct(instrumented, args, newTarget) as T;
    },
  });
}
