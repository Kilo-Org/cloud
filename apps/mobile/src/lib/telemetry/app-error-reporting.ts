/**
 * General app-error reporting for the React Query caches.
 *
 * Errors already reported by the network layer (the tRPC links in lib/trpc.ts
 * and the global fetch wrapper in install-error-reporting.ts) are skipped so a
 * single failure produces a single Sentry issue. Pure and total: no SDK import,
 * so node vitest suites can import it (the RN SDK does not parse under
 * vitest/rolldown). Every function wraps its body: telemetry must never throw
 * into app code.
 */

import { CancelledError } from '@tanstack/react-query';
import { z } from 'zod';

import { captureTelemetry } from '@/lib/telemetry/error-sink';
import { readTrpcErrorField } from '@/lib/trpc-error';

type AppErrorSource = 'query' | 'mutation';

export type AppErrorContext = {
  source: AppErrorSource;
  queryKey?: unknown;
};

const TRPC_CLIENT_ERROR_NAME = 'TRPCClientError';
const REQUEST_DEADLINE_ERROR_NAME = 'RequestDeadlineError';

const NamedErrorSchema = z.looseObject({ name: z.string() });
const StringValueSchema = z.string();
const JsonTextSchema = z.string();

function hasErrorName(error: unknown, name: string): boolean {
  const parsed = NamedErrorSchema.safeParse(error);
  return parsed.success && parsed.data.name === name;
}

/**
 * True when the error is already reported by the network layer: a tRPC client
 * error (by name, or any error carrying a tRPC `code`), a react-query
 * `CancelledError`, or a request-deadline timeout. These are captured by the
 * tRPC links or the fetch wrapper, so reporting them again would duplicate
 * issues.
 */
export function isAlreadyReportedNetworkError(error: unknown): boolean {
  try {
    if (hasErrorName(error, TRPC_CLIENT_ERROR_NAME)) {
      return true;
    }
    if (readTrpcErrorField(error, 'code') !== undefined) {
      return true;
    }
    if (error instanceof CancelledError) {
      return true;
    }
    return hasErrorName(error, REQUEST_DEADLINE_ERROR_NAME);
  } catch {
    return false;
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  const named = NamedErrorSchema.safeParse(error);
  if (named.success && named.data.name.length > 0) {
    return named.data.name;
  }
  return 'unknown';
}

function jsonText(value: unknown): string | undefined {
  try {
    const parsed = JsonTextSchema.safeParse(JSON.stringify(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const string = StringValueSchema.safeParse(error);
  if (string.success) {
    return string.data;
  }
  if (error === null) {
    return 'null';
  }
  if (error === undefined) {
    return 'undefined';
  }
  return jsonText(error) ?? 'unknown';
}

/**
 * Defensive string form of a query key for Sentry `extra`. Query keys are
 * structured input that can hold ids, functions, and cycles; never throw and
 * never index them as tags.
 */
function queryKeyString(queryKey: unknown): string {
  if (queryKey === undefined) {
    return '';
  }
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(queryKey, (_key, value: unknown) => {
      if (value instanceof Object) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
    const parsed = JsonTextSchema.safeParse(serialized);
    return parsed.success ? parsed.data : '';
  } catch {
    return '';
  }
}

/**
 * Report an error observed by a React Query cache at error level, unless the
 * network layer already reported it. The query key rides in `extra` (not tags,
 * which are indexed and can carry ids). Never throws.
 */
export function reportAppError(error: unknown, context: AppErrorContext): void {
  try {
    if (isAlreadyReportedNetworkError(error)) {
      return;
    }
    captureTelemetry({
      error,
      level: 'error',
      tags: {
        'error.subsystem': 'app',
        'error.source': context.source,
      },
      extra: { queryKey: queryKeyString(context.queryKey) },
      fingerprint: ['app-error', context.source, errorName(error), errorMessage(error)],
    });
  } catch {
    // Telemetry must never throw into app code.
  }
}
