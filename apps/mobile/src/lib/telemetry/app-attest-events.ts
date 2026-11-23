/**
 * The App Attest failure diagnostic: its producer, the native error
 * classification, and the `beforeSend` projection that bounds what it carries.
 *
 * The projection exists because `scrubEvent` redacts values but keeps every
 * field the SDK attached. This event reports a native proof failure, so a key
 * id, challenge, token, header, breadcrumb or inherited identity would widen
 * what leaves the device without telling a reader anything more than the step
 * and the closed-set native error already do. The event is one fixed message
 * plus validated tags, and {@link projectAppAttestFailureEvent} keeps only that.
 *
 * Classification source, pinned `@expo/app-integrity@58.0.2`:
 * `ios/IntegrityModule.swift` wraps a `DCError` 1:1 into an
 * `ERR_APP_INTEGRITY_*` code, and `DCError.h` numbers the `NS_ERROR_ENUM`
 * cases UnknownSystemFailure 0, FeatureUnsupported 1, InvalidInput 2,
 * InvalidKey 3, ServerUnavailable 4. `ERR_APP_INTEGRITY_UNKNOWN` is the shared
 * `@unknown default` and the non-`DCError` fallback, so it stays the Expo
 * module's own domain, never a DeviceCheck code. No other string is classified
 * and no localized message is parsed.
 *
 * SDK-free and total, so the pure suites can import it under node vitest.
 */

import * as z from 'zod';

import { captureTelemetry } from '@/lib/telemetry/error-sink';

/** Fixed message: the projection's discriminator, so it is never templated. */
const APP_ATTEST_EVENT_MESSAGE = 'App Attest failure';

/** The pinned Expo module's own `AsyncFunction` names for the native steps. */
const NATIVE_STEPS = ['generateKey', 'attestKey', 'generateAssertion'] as const;

/** A failed native proof step. The token POST (`post`) is a JS transport step. */
type AppAttestNativeStep = (typeof NATIVE_STEPS)[number];

/** The exported `DCErrorDomain` symbol name. */
const DEVICE_CHECK_DOMAIN = 'DCErrorDomain';
/** Expo's fallback for a `DCError` case it does not name, and for a non-`DCError`. */
const EXPO_DOMAIN = 'expo_app_integrity';
/** This app's token POST transport, which never reaches DeviceCheck. */
const JS_TRANSPORT_DOMAIN = 'js_transport';

const EXPO_UNKNOWN_CODE = 'ERR_APP_INTEGRITY_UNKNOWN';

/** The one transport outcome each `post` code names. */
const POST_FAILURES = ['timeout', 'network'] as const;

type AppAttestPostFailure = (typeof POST_FAILURES)[number];

/**
 * The `DCError.code` value behind one Expo integrity code, or `undefined` when
 * the code names no `DCError`.
 */
function deviceCheckCodeFor(integrityCode: string): number | undefined {
  switch (integrityCode) {
    case 'ERR_APP_INTEGRITY_SYSTEM_FAILURE': {
      return 0;
    }
    case 'ERR_APP_INTEGRITY_FEATURE_UNSUPPORTED': {
      return 1;
    }
    case 'ERR_APP_INTEGRITY_INVALID_INPUT': {
      return 2;
    }
    case 'ERR_APP_INTEGRITY_INVALID_KEY': {
      return 3;
    }
    case 'ERR_APP_INTEGRITY_SERVER_UNAVAILABLE': {
      return 4;
    }
    default: {
      return undefined;
    }
  }
}

const integrityErrorSchema = z.object({ code: z.string() });

type NativeAttestTags =
  | { 'app_attest.step': AppAttestNativeStep }
  | {
      'app_attest.step': AppAttestNativeStep;
      'app_attest.error_domain': typeof DEVICE_CHECK_DOMAIN;
      'app_attest.error_code': number;
    }
  | {
      'app_attest.step': AppAttestNativeStep;
      'app_attest.error_domain': typeof EXPO_DOMAIN;
      'app_attest.error_code': typeof EXPO_UNKNOWN_CODE;
    };

/** The producer tags for one native rejection. */
function nativeTags(step: AppAttestNativeStep, error: unknown): NativeAttestTags {
  const parsed = integrityErrorSchema.safeParse(error);
  const code = parsed.success ? parsed.data.code : undefined;
  const deviceCheckCode = code === undefined ? undefined : deviceCheckCodeFor(code);
  if (deviceCheckCode !== undefined) {
    return {
      'app_attest.step': step,
      'app_attest.error_domain': DEVICE_CHECK_DOMAIN,
      'app_attest.error_code': deviceCheckCode,
    };
  }
  if (code === EXPO_UNKNOWN_CODE) {
    return {
      'app_attest.step': step,
      'app_attest.error_domain': EXPO_DOMAIN,
      'app_attest.error_code': EXPO_UNKNOWN_CODE,
    };
  }
  // A rejection that named no known code is reported by step alone rather than
  // with a guessed or parsed one.
  return { 'app_attest.step': step };
}

/**
 * File one failed native step. The caller still owns the rejection: this
 * reports and returns, and every call site rethrows.
 */
export function reportAppAttestFailure(step: AppAttestNativeStep, error: unknown): void {
  captureTelemetry({
    level: 'error',
    message: APP_ATTEST_EVENT_MESSAGE,
    tags: nativeTags(step, error),
  });
}

/**
 * File one transport failure of an iOS token POST that carried Apple proof:
 * `timeout` for the app's own deadline, `network` for any other rejection
 * before the server answered. A server verdict is never reported here.
 */
export function reportAppAttestPostFailure(failure: AppAttestPostFailure): void {
  captureTelemetry({
    level: 'error',
    message: APP_ATTEST_EVENT_MESSAGE,
    tags: {
      'app_attest.step': 'post',
      'app_attest.error_domain': JS_TRANSPORT_DOMAIN,
      'app_attest.error_code': failure,
    },
  });
}

// A plain `z.object`, never `strictObject`: the scope's own tags are stripped
// from a diagnostic rather than turning it into an ordinary error event. Each
// domain admits only its own code form, so a mixed pair matches no branch.
const appAttestTagsSchema = z.union([
  z.object({
    'app_attest.step': z.literal('post'),
    'app_attest.error_domain': z.literal(JS_TRANSPORT_DOMAIN),
    'app_attest.error_code': z.enum(POST_FAILURES),
  }),
  z.object({
    'app_attest.step': z.enum(NATIVE_STEPS),
    'app_attest.error_domain': z.literal(DEVICE_CHECK_DOMAIN),
    'app_attest.error_code': z.number().int().min(0).max(4),
  }),
  z.object({
    'app_attest.step': z.enum(NATIVE_STEPS),
    'app_attest.error_domain': z.literal(EXPO_DOMAIN),
    'app_attest.error_code': z.literal(EXPO_UNKNOWN_CODE),
  }),
  z.object({
    'app_attest.step': z.enum(NATIVE_STEPS),
    'app_attest.error_domain': z.undefined().optional(),
    'app_attest.error_code': z.undefined().optional(),
  }),
]);

/** The diagnostic tags, or `null` when the tags are not a producer shape. */
function readAppAttestTags(raw: unknown): Record<string, string | number> | null {
  const parsed = appAttestTagsSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const step = parsed.data['app_attest.step'];
  const domain = parsed.data['app_attest.error_domain'];
  const code = parsed.data['app_attest.error_code'];
  return domain === undefined || code === undefined
    ? { 'app_attest.step': step }
    : { 'app_attest.step': step, 'app_attest.error_domain': domain, 'app_attest.error_code': code };
}

/**
 * True only for this app's diagnostic: the fixed message, never its tag set.
 *
 * A field comparison, not a schema, because `beforeSend` runs for every event
 * and this path allocates nothing.
 */
export function isAppAttestFailureEvent(event: unknown): boolean {
  // SAFETY: only `message` is read, and a non-object has none of its own.
  return (event as { message?: unknown } | null | undefined)?.message === APP_ATTEST_EVENT_MESSAGE;
}

/**
 * The event fields a projected diagnostic keeps: Sentry's own event identity
 * and release metadata, the fixed message, and the validated tags.
 */
const KEPT_EVENT_FIELDS = {
  event_id: true,
  timestamp: true,
  platform: true,
  level: true,
  release: true,
  dist: true,
  environment: true,
  sdk: true,
  message: true,
  tags: true,
} satisfies Readonly<Record<string, true>>;

/**
 * The allowlisted view of a diagnostic. Returns `null` — dropping the event —
 * when its tags match no producer shape, so a malformed diagnostic is never
 * forwarded unprojected.
 */
export function projectAppAttestFailureEvent<T>(event: T): T | null {
  if (!isAppAttestFailureEvent(event)) {
    return null;
  }
  // SAFETY: The SDK supplies the event object. Only allowlisted fields are read.
  const fields = event as Record<string, unknown>;
  const tags = readAppAttestTags(fields.tags);
  if (tags === null) {
    return null;
  }
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(KEPT_EVENT_FIELDS, key)) {
      projected[key] = fields[key];
    }
  }
  projected.message = APP_ATTEST_EVENT_MESSAGE;
  projected.tags = tags;
  // SAFETY: `projected` is the shipped event type's own key set, rebuilt.
  return projected as T;
}
