import * as z from 'zod';

const stagingSinkSchema = z
  .email()
  .refine(email => email.slice(email.lastIndexOf('@') + 1).toLowerCase() === 'kilocode.ai');

type OutboundEmailEnvironment = {
  IS_IN_AUTOMATED_TEST?: string;
  NODE_ENV?: string;
  STAGING_EMAIL_REDIRECT_TO?: string;
  VERCEL_TARGET_ENV?: string;
};

export type OutboundEmailParams = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  category?: string;
};

export type OutboundEmailMode =
  | { kind: 'live' }
  | { kind: 'redirect'; sink: string }
  | { kind: 'local_outbox' }
  | { kind: 'test' }
  | { kind: 'suppressed'; targetEnvironment: string }
  | { kind: 'configuration_error' };

export type OutboundEmailRoute =
  | { kind: 'mailgun'; mode: 'live' | 'redirect'; params: OutboundEmailParams }
  | { kind: 'local_outbox'; params: OutboundEmailParams }
  | { kind: 'suppressed'; targetEnvironment: string | null }
  | { kind: 'configuration_error' };

function stagingSink(environment: OutboundEmailEnvironment): string {
  const result = stagingSinkSchema.safeParse(environment.STAGING_EMAIL_REDIRECT_TO?.trim());
  if (!result.success) {
    throw new Error(
      'STAGING_EMAIL_REDIRECT_TO must contain exactly one valid @kilocode.ai email address'
    );
  }
  return result.data;
}

export function resolveOutboundEmailMode(
  environment: OutboundEmailEnvironment = process.env
): OutboundEmailMode {
  const targetEnvironment = environment.VERCEL_TARGET_ENV;

  if (environment.NODE_ENV === 'test' || environment.IS_IN_AUTOMATED_TEST) {
    return { kind: 'test' };
  }
  if (targetEnvironment === 'production') return { kind: 'live' };
  if (targetEnvironment === 'staging') {
    return { kind: 'redirect', sink: stagingSink(environment) };
  }
  if (targetEnvironment) return { kind: 'suppressed', targetEnvironment };
  if (environment.NODE_ENV === 'production') return { kind: 'configuration_error' };
  return { kind: 'local_outbox' };
}

export function getEmailVerificationRecipient(
  intendedRecipient: string,
  environment: OutboundEmailEnvironment = process.env
): string | null {
  const mode = resolveOutboundEmailMode(environment);
  if (mode.kind === 'live' || mode.kind === 'test') return intendedRecipient;
  if (mode.kind === 'redirect') return mode.sink;
  return null;
}

function safeSubjectValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export function routeOutboundEmail(
  params: OutboundEmailParams,
  environment: OutboundEmailEnvironment = process.env
): OutboundEmailRoute {
  const mode = resolveOutboundEmailMode(environment);

  if (mode.kind === 'live') {
    return { kind: 'mailgun', mode: 'live', params };
  }
  if (mode.kind === 'redirect') {
    return {
      kind: 'mailgun',
      mode: 'redirect',
      params: {
        ...params,
        to: mode.sink,
        subject: `[STAGING to: ${safeSubjectValue(params.to)}] ${params.subject}`,
        replyTo: mode.sink,
      },
    };
  }
  if (mode.kind === 'local_outbox') {
    return { kind: 'local_outbox', params };
  }
  if (mode.kind === 'configuration_error') return { kind: 'configuration_error' };
  return {
    kind: 'suppressed',
    targetEnvironment: mode.kind === 'suppressed' ? mode.targetEnvironment : null,
  };
}
