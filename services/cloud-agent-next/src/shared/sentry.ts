import type { ErrorEvent, StackFrame } from '@sentry/core';

export type CloudAgentSentryIdentity = {
  userId?: string;
  orgId?: string;
  sessionId?: string;
  sandboxId?: string;
};

type SentryConfigKey = 'CLOUD_AGENT_SENTRY_DSN' | 'CLOUD_AGENT_SENTRY_ENVIRONMENT';
const warnedConfigKeys = new Set<SentryConfigKey>();

function warnInvalidSentryConfig(key: SentryConfigKey): void {
  if (warnedConfigKeys.has(key)) return;
  warnedConfigKeys.add(key);
  console.warn(`Cloud Agent Sentry reporting disabled: invalid ${key}`);
}

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
      warnInvalidSentryConfig('CLOUD_AGENT_SENTRY_DSN');
      return undefined;
    }
    const environment = env.CLOUD_AGENT_SENTRY_ENVIRONMENT;
    if (environment && !/^[a-zA-Z0-9_-]{1,32}$/.test(environment)) {
      warnInvalidSentryConfig('CLOUD_AGENT_SENTRY_ENVIRONMENT');
      return undefined;
    }
    return {
      dsn: url.toString(),
      environment: environment || 'production',
    };
  } catch {
    warnInvalidSentryConfig('CLOUD_AGENT_SENTRY_DSN');
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

function safeFrameFilename(filename: string | undefined): string | undefined {
  if (!filename || filename.startsWith('//') || !/^[a-zA-Z0-9_./@:-]{1,256}$/.test(filename)) {
    return undefined;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(filename)) return filename;
  try {
    const url = new URL(filename);
    if (url.username || url.password) return undefined;
    // Opaque schemes (for example `webpack:user:pass@host/app.js`) keep userinfo in pathname.
    if (!url.host && /^(?:\/+)?[^/]*@/.test(url.pathname)) return undefined;
    return filename;
  } catch {
    return undefined;
  }
}

function sanitizeFrame(frame: StackFrame): StackFrame {
  const filename = safeFrameFilename(frame.filename);
  return {
    ...(filename ? { filename } : {}),
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

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value);
}

export function sanitizeSentryEvent(
  event: ErrorEvent,
  { userId, orgId }: Pick<CloudAgentSentryIdentity, 'userId' | 'orgId'> = {}
): ErrorEvent | null {
  if (!event.exception?.values?.length) return null;
  const context: Partial<Record<(typeof CONTEXT_KEYS)[number], string>> & { exitCode?: number } =
    {};
  const cloudAgent = event.contexts?.cloud_agent;
  for (const key of CONTEXT_KEYS) {
    const value = cloudAgent?.[key];
    if (safeIdentifier(value)) context[key] = value;
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
    ...(safeIdentifier(userId) ? { user: { id: userId } } : {}),
    contexts: { cloud_agent: context },
    tags: {
      ...(context.component ? { component: context.component } : {}),
      ...(context.operation ? { operation: context.operation } : {}),
      ...(orgId === '(personal)' || (safeIdentifier(orgId) && orgId.length <= 200)
        ? { orgId }
        : {}),
      ...(context.sessionId && context.sessionId.length <= 200
        ? { sessionId: context.sessionId }
        : {}),
      ...(context.sandboxId && context.sandboxId.length <= 200
        ? { sandboxId: context.sandboxId }
        : {}),
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
  beforeSend: (event: ErrorEvent) => sanitizeSentryEvent(event),
} as const;
