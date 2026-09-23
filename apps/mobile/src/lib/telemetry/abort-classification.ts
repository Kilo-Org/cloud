/**
 * Abort and deadline classification for network errors.
 *
 * Expo SDK 57's fetch rejects a canceled request with a
 * `FetchRequestCanceledException`: a raw native error carries it as `name`, an
 * expo-modules-core `CodedError` as `code`, and the `FetchError` wrapper (whose
 * `name` is `Error`) embeds it in `message`. The wrapper is what production
 * reports: `FetchError.createFromError` does `new FetchError(error.message)`
 * and `FetchError` does `super(\`fetch failed: ${message}\`)`, while the native
 * exception's message is exactly `Fetch request has been canceled`. Neither
 * `name` nor `code` survives, so the class name in `message` is optional and
 * the native message is matched on its own.
 *
 * Pure and total: no SDK import, no network, no React. An unrecognized value
 * yields `false` and never throws.
 */

import { z } from 'zod';

// `Error` and `DOMException` both carry a string `name`; abort/deadline checks
// key on it so a structured error never needs an `instanceof` across bundles.
const NamedErrorSchema = z.looseObject({ name: z.string() });
const ErrorCodeSchema = z.looseObject({ code: z.string() });
const ErrorMessageSchema = z.looseObject({ message: z.string() });
const ErrorCauseSchema = z.looseObject({ cause: z.unknown() });

const EXPO_CANCEL_NAME = 'FetchRequestCanceledException';
const EXPO_CANCEL_MESSAGE = 'Fetch request has been canceled';
const ABORT_ERROR_NAME = 'AbortError';
const REQUEST_DEADLINE_NAME = 'RequestDeadlineError';

function hasErrorName(error: unknown, name: string): boolean {
  try {
    const parsed = NamedErrorSchema.safeParse(error);
    return parsed.success && parsed.data.name === name;
  } catch {
    return false;
  }
}

function isExpoCanceledError(error: unknown): boolean {
  try {
    if (hasErrorName(error, EXPO_CANCEL_NAME)) {
      return true;
    }
    const byCode = ErrorCodeSchema.safeParse(error);
    if (byCode.success && byCode.data.code === EXPO_CANCEL_NAME) {
      return true;
    }
    const byMessage = ErrorMessageSchema.safeParse(error);
    if (!byMessage.success) {
      return false;
    }
    // A raw expo-modules-core error embeds the class name; the production
    // `FetchError` wrapper does not, so match the native message as a suffix
    // (`fetch failed: Fetch request has been canceled`).
    return (
      byMessage.data.message.includes(EXPO_CANCEL_NAME) ||
      byMessage.data.message.endsWith(EXPO_CANCEL_MESSAGE)
    );
  } catch {
    return false;
  }
}

/**
 * True when the value is an abort: an `AbortError` / `DOMException` or an Expo
 * `FetchRequestCanceledException`. The Expo cancellation is checked on the
 * error itself and one level of `cause`, since the SDK wraps it. Total: an
 * unrecognized value yields `false` and never throws.
 */
export function isAbortError(error: unknown): boolean {
  try {
    if (hasErrorName(error, ABORT_ERROR_NAME) || isExpoCanceledError(error)) {
      return true;
    }
    const parsed = ErrorCauseSchema.safeParse(error);
    return parsed.success && parsed.data.cause !== undefined
      ? isExpoCanceledError(parsed.data.cause)
      : false;
  } catch {
    return false;
  }
}

export function isRequestDeadlineError(error: unknown): boolean {
  return hasErrorName(error, REQUEST_DEADLINE_NAME);
}
