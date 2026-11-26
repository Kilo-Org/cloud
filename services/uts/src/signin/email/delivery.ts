import type { ChannelOutcome, EmailTransport } from '../../notices/transports';
import { mailgunEmail } from '../../notices/transports';
import {
  type MailSettings,
  type RecipientRule,
  type SignInConfig,
  recipientAllowed,
} from '../providers/config';
import type { MailResult, SignInEmail, SignInMailer } from './mailer';
import { type TurnstileCheck, turnstileCheck } from './turnstile';

/**
 * How the email sign-in of one environment sends its mail (design 5.1, 5.3, 5.13):
 *
 * * `mailgun`: the deployed sender. It needs `SIGNIN_EMAIL_HASH_KEY` and the mail settings
 *   (`MailSettings`: Mailgun key, domain and sender, Turnstile site key and secret, and outside
 *   production the recipient allow-list). Every start passes the Turnstile check and the
 *   recipient rule before anything is stored or sent.
 * * `recording`: the development entry's mail port (src/dev.ts), which records each message and
 *   sends nothing, so it needs no Turnstile check. Only an entry that passes a recording mailer
 *   gets it, and the mail settings win when they are set.
 *
 * Without a sender the email sign-in is `off`: not offered, and its routes answer 404.
 */
export type EmailDelivery =
  | {
      kind: 'mailgun';
      mailer: SignInMailer;
      turnstile: TurnstileCheck;
      siteKey: string;
      recipients: RecipientRule;
    }
  | { kind: 'recording'; mailer: SignInMailer };

export type EmailSignIn =
  | { status: 'off' }
  | { status: 'misconfigured'; missing: readonly string[] }
  | { status: 'on'; hashKey: Uint8Array; delivery: EmailDelivery };

/** The platform `fetch`, called through a closure as the runtime expects. */
export const platformFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * Sends to the addresses the rule allows and drops the rest without sending. A message left with
 * no address is `no_target`: this environment has nobody to send it to.
 */
export function guardedEmail(rule: RecipientRule, transport: EmailTransport): EmailTransport {
  if (rule.kind === 'any') return transport;
  return async message => {
    const to = message.to.filter(address => recipientAllowed(rule, address));
    if (to.length < message.to.length) {
      console.error(
        JSON.stringify({
          event: 'uts.mail.recipient_refused',
          refused: message.to.length - to.length,
        })
      );
    }
    if (to.length === 0) return 'no_target';
    return await transport({ ...message, to });
  };
}

/** The notice email transport: Mailgun behind the recipient rule, or null where mail is not on. */
export function noticeEmail(mail: MailSettings, fetcher: typeof fetch): EmailTransport | null {
  return mail.status === 'on'
    ? guardedEmail(mail.recipients, mailgunEmail(mail.mailgun, fetcher))
    : null;
}

function mailResultOf(outcome: ChannelOutcome): MailResult {
  switch (outcome) {
    case 'sent':
      return 'sent';
    case 'retryable_failure':
      return 'retryable';
    case 'permanent_failure':
    case 'no_target':
    case 'not_configured':
      return 'failed';
  }
}

/** The sign-in email as plain text: the link, the code when there is one, and the expiry. */
export function signInEmailText(message: SignInEmail): string {
  const until = `${message.expiresAt.toISOString().slice(11, 16)} UTC`;
  const lines = ['Open this link to sign in to Kilo:', '', message.link, ''];
  if (message.code !== null) {
    lines.push(`Or enter this code on the sign-in page: ${message.code}`, '');
    lines.push(`The link and the code work for 10 minutes, until ${until}.`);
  } else {
    lines.push(`The link works for 10 minutes, until ${until}.`);
  }
  lines.push('', 'If you did not ask to sign in, ignore this email. Do not forward it to anyone.');
  return lines.join('\n');
}

/**
 * The email sign-in of one request. `issuer` names the host the Turnstile token must come from;
 * `recordingMailer` is non-null only in the development entry.
 */
export function emailSignIn(
  settings: SignInConfig,
  issuer: string,
  recordingMailer: SignInMailer | null,
  fetcher: typeof fetch
): EmailSignIn {
  const { emailHashKey: hash, mail } = settings;
  const hashMissing = hash.status === 'misconfigured' ? hash.missing : [];
  if (mail.status === 'misconfigured') {
    return { status: 'misconfigured', missing: [...hashMissing, ...mail.missing] };
  }
  if (mail.status === 'on') {
    if (hash.status !== 'on') {
      return { status: 'misconfigured', missing: ['SIGNIN_EMAIL_HASH_KEY'] };
    }
    const transport = guardedEmail(mail.recipients, mailgunEmail(mail.mailgun, fetcher));
    return {
      status: 'on',
      hashKey: hash.hashKey,
      delivery: {
        kind: 'mailgun',
        mailer: async message =>
          mailResultOf(
            await transport({
              to: [message.to],
              subject: 'Sign in to Kilo',
              text: signInEmailText(message),
            })
          ),
        turnstile: turnstileCheck(mail.turnstile, new URL(issuer).hostname, fetcher),
        siteKey: mail.turnstile.siteKey,
        recipients: mail.recipients,
      },
    };
  }
  // Without the mail settings only an entry that records mail has a sender; the hash key alone
  // switches nothing on.
  if (recordingMailer === null || hash.status === 'off') return { status: 'off' };
  if (hash.status === 'misconfigured') return { status: 'misconfigured', missing: hashMissing };
  return {
    status: 'on',
    hashKey: hash.hashKey,
    delivery: { kind: 'recording', mailer: recordingMailer },
  };
}
