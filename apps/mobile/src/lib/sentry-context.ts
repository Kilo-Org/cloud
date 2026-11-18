import * as Sentry from '@sentry/react-native';

export type SentryAuthState = 'error' | 'loading' | 'signed_in' | 'signed_out';
export type SentryTelemetryMode = 'mandatory' | 'optional';

let userId: string | null = null;
let authState: SentryAuthState = 'loading';
let telemetryMode: SentryTelemetryMode = 'mandatory';

export function applySentryContext(): void {
  Sentry.setUser(userId === null ? null : { id: userId });
  Sentry.setTag('app.auth_state', authState);
  Sentry.setTag('app.telemetry_mode', telemetryMode);
}

export function setSentryContext(context: {
  readonly userId: string | null;
  readonly authState: SentryAuthState;
  readonly telemetryMode: SentryTelemetryMode;
}): void {
  userId = context.userId;
  authState = context.authState;
  telemetryMode = context.telemetryMode;
  applySentryContext();
}

export function clearSentryUser(): void {
  userId = null;
  authState = 'signed_out';
  applySentryContext();
}
