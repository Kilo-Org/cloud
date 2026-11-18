import * as Sentry from '@sentry/cloudflare';
import { TRPCError } from '@trpc/server';
import { HTTPException } from 'hono/http-exception';
import type { DurableObject } from 'cloudflare:workers';
import type { Env } from './types.js';
import { logger, sentryLogIdentity, withSentryLogTagCapture } from './logger.js';
import { sessionIdFromDoName } from './session-identity.js';
import {
  type CloudAgentSentryIdentity,
  getSentryConfig,
  sanitizeSentryEvent,
  SENTRY_ERROR_OPTIONS,
} from './shared/sentry.js';
import {
  readSentryIdentity,
  type SentryIdentityReader,
  type SentryIdentitySource,
} from './sentry-identity.js';

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
  identity: Pick<CloudAgentSentryIdentity, 'sessionId' | 'sandboxId'> = {},
  readIdentity?: SentryIdentityReader
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
      const logged = sentryLogIdentity(hint.originalException);
      const cloudAgent = event.contexts?.cloud_agent;
      const finish = (stored?: CloudAgentSentryIdentity) => {
        const sanitized = sanitizeSentryEvent(
          {
            ...event,
            contexts: {
              cloud_agent: {
                ...cloudAgent,
                component,
                sessionId:
                  stored?.sessionId ??
                  cloudAgent?.sessionId ??
                  identity.sessionId ??
                  logged.sessionId,
                sandboxId:
                  stored?.sandboxId ??
                  cloudAgent?.sandboxId ??
                  identity.sandboxId ??
                  logged.sandboxId,
              },
            },
          },
          {
            userId:
              stored?.userId ??
              (typeof cloudAgent?.userId === 'string' ? cloudAgent.userId : logged.userId),
            orgId:
              stored?.orgId ??
              (typeof cloudAgent?.orgId === 'string' ? cloudAgent.orgId : logged.orgId),
          }
        );
        if (sanitized) {
          logger
            .withFields({ sentryEventId: sanitized.event_id, component, ...identity })
            .error('Cloud Agent exception captured');
        }
        return sanitized;
      };
      // A failed identity lookup must not drop the original exception.
      return readIdentity
        ? Promise.resolve()
            .then(readIdentity)
            .then(finish, () => finish())
        : finish();
    },
  };
}

export function captureCloudAgentException(
  error: unknown,
  context: CloudAgentSentryIdentity & { operation: string; messageId?: string }
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
  function withRequestScope<R>(fn: () => R): R {
    // SDK request initialization otherwise mutates a shared current scope before awaiting.
    return withSentryLogTagCapture(() => Sentry.withScope(fn));
  }
  return {
    ...worker,
    fetch(...args: Parameters<T['fetch']>) {
      if (!getSentryConfig(args[1])) return worker.fetch(args[0], args[1], args[2]);
      return withRequestScope(() => instrumented.fetch(args[0], args[1], args[2]));
    },
    queue(...args: Parameters<T['queue']>) {
      if (!getSentryConfig(args[1])) return worker.queue(args[0], args[1], args[2]);
      return withRequestScope(() => instrumented.queue(args[0], args[1], args[2]));
    },
    scheduled(...args: Parameters<T['scheduled']>) {
      if (!getSentryConfig(args[1])) return worker.scheduled(args[0], args[1], args[2]);
      return withRequestScope(() => instrumented.scheduled(args[0], args[1], args[2]));
    },
  };
}

export function instrumentCloudAgentDurableObject<
  T extends DurableObject<Env> & SentryIdentitySource,
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
          ...cloudAgentSentryOptions(env, component, identity, () =>
            instance[readSentryIdentity]?.()
          ),
          // These RPC callers are not all Sentry-instrumented. The pinned SDK's
          // replacement option skips capture when the caller has no trace metadata.
          instrumentPrototypeMethods: true,
        }),
        target
      );
      const instance = Reflect.construct(instrumented, args, newTarget) as T;
      return instance;
    },
  });
}
