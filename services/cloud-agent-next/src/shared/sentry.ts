import type { ErrorEvent, StackFrame } from '@sentry/core';

export function getSentryConfig(env: {
  CLOUD_AGENT_SENTRY_DSN?: string;
  CLOUD_AGENT_SENTRY_ENVIRONMENT?: string;
}): { dsn: string; environment: string } | undefined {
  if (!env.CLOUD_AGENT_SENTRY_DSN) return undefined;
  try {
    const url = new URL(env.CLOUD_AGENT_SENTRY_DSN);
    if (
      url.protocol !== 'https:' ||
      !/^[a-zA-Z0-9]+$/.test(url.username) ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/\d+$/.test(url.pathname) ||
      !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(url.hostname)
    ) {
      return undefined;
    }
    const environment = env.CLOUD_AGENT_SENTRY_ENVIRONMENT;
    return {
      dsn: url.toString(),
      environment:
        environment && /^[a-zA-Z0-9_-]{1,32}$/.test(environment) ? environment : 'production',
    };
  } catch {
    return undefined;
  }
}

const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'TRPCError',
]);

const CONTEXT_KEYS = [
  'component',
  'operation',
  'sessionId',
  'messageId',
  'sandboxId',
  'allocationId',
  'wrapperInstanceId',
  'wrapperRunId',
  'providerInstanceId',
] as const;

function sanitizeFrame(frame: StackFrame): StackFrame {
  const filename = frame.filename;
  const safeFilename = filename && /^[a-zA-Z0-9_./@:-]{1,256}$/.test(filename);
  return {
    ...(safeFilename ? { filename } : {}),
    ...(typeof frame.lineno === 'number' ? { lineno: frame.lineno } : {}),
    ...(typeof frame.colno === 'number' ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {}),
    ...(frame.function && /^[a-zA-Z0-9_.$<> /-]{1,128}$/.test(frame.function)
      ? { function: frame.function }
      : {}),
    ...(frame.debug_id && /^[a-fA-F0-9-]{32,36}$/.test(frame.debug_id)
      ? { debug_id: frame.debug_id }
      : {}),
  };
}

export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent | null {
  if (!event.exception?.values?.length) return null;
  const context: Record<string, string | number> = {};
  const cloudAgent = event.contexts?.cloud_agent;
  for (const key of CONTEXT_KEYS) {
    const value = cloudAgent?.[key];
    if (typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value)) {
      context[key] = value;
    }
  }
  if (typeof cloudAgent?.exitCode === 'number' && Number.isInteger(cloudAgent.exitCode)) {
    context.exitCode = cloudAgent.exitCode;
  }
  // Exception messages can contain prompts, provider bodies, or user credentials.
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    debug_meta: event.debug_meta,
    contexts: { cloud_agent: context },
    tags: {
      ...(context.component ? { component: context.component } : {}),
      ...(context.operation ? { operation: context.operation } : {}),
    },
    exception: {
      values: event.exception.values.map(exception => ({
        type: exception.type && ERROR_TYPES.has(exception.type) ? exception.type : 'Error',
        value: 'Cloud Agent internal error; inspect correlated logs for details',
        ...(exception.stacktrace
          ? { stacktrace: { frames: exception.stacktrace.frames?.map(sanitizeFrame) } }
          : {}),
        ...(exception.mechanism
          ? {
              mechanism: {
                type: exception.mechanism.type,
                handled: exception.mechanism.handled,
              },
            }
          : {}),
      })),
    },
  };
}

export const SENTRY_ERROR_OPTIONS = {
  defaultIntegrations: false,
  sendDefaultPii: false,
  sendClientReports: false,
  enableLogs: false,
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  beforeSend: sanitizeSentryEvent,
} as const;
