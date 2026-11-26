import { z } from 'zod';
import type { NOTICE_KINDS } from '../db/enums';

/**
 * What each security notice says, and on which channels (design 5.13). Every notice row is the
 * in-app notice, which the security page always shows. Push and email follow in that order: push
 * first, then email, each tried for every notice of a kind that uses it. Email always follows a
 * push, because a device that receives push may be one a thief signed in, while the address on
 * file is the user's.
 *
 * No notice carries a link, in any channel: a link that performs a state change invites phishing
 * and lets a mail scanner act by accident. A notice names the event, the time and the approximate
 * network, and it points the reader to the security page of their account. `plainText` refuses
 * any text that a mail client or a phone could turn into a link, so a producer's value (a device
 * label, a client name) cannot add one either.
 */

export type NoticeKind = (typeof NOTICE_KINDS)[number];
export type OutOfBandChannel = 'push' | 'email';

/**
 * The out-of-band channels of each kind, in the order they are tried. The sign-in code stop goes
 * by push only: it starts when a flood of sign-in emails reaches the address (design 5.3).
 */
export const NOTICE_CHANNEL_PLAN: Readonly<Record<NoticeKind, readonly OutOfBandChannel[]>> = {
  new_device_network: ['push', 'email'],
  sign_in_method_changed: ['push', 'email'],
  primary_email_changed: ['push', 'email'],
  credential_created: ['push', 'email'],
  device_sign_in_approved: ['push', 'email'],
  ci_trust_policy_changed: ['push', 'email'],
  third_party_client_approved: ['push', 'email'],
  sessions_revoked: ['push', 'email'],
  suspicious_sign_in: ['push', 'email'],
  sign_in_code_stopped: ['push'],
  bot_key_flagged: ['push', 'email'],
};

const ProducerText = z.string().min(1).max(200);

/**
 * The `details` fields the notice text reads. A producer may store more; a field of the wrong
 * shape is left out of the text rather than failing the notice.
 */
const NoticeDetailsSchema = z.object({
  deviceLabel: ProducerText.optional().catch(undefined),
  platform: ProducerText.optional().catch(undefined),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .catch(undefined),
  city: ProducerText.optional().catch(undefined),
  credential: z.enum(['pat', 'bot_key']).optional().catch(undefined),
  /** A sign-in method or passkey change: what changed and how. */
  method: ProducerText.optional().catch(undefined),
  change: z.enum(['added', 'removed']).optional().catch(undefined),
  clientName: ProducerText.optional().catch(undefined),
  /** Set when Kilo support made the change; the notice never names the staff member. */
  actor: z.enum(['user', 'support']).optional().catch(undefined),
  flaggedKeys: z.number().int().positive().optional().catch(undefined),
});
type NoticeDetails = z.infer<typeof NoticeDetailsSchema>;

/** Text that could become a link: a scheme, `www.`, a dotted host name, or an address with `@`. */
const LINK_LIKE = /:\/\/|\bwww\.|[\p{L}\p{N}-]\.\p{L}{2,}|@|\b(?:https?|mailto|tel|sms):/iu;

export class LinkInNoticeError extends Error {
  override name = 'LinkInNoticeError';
  constructor() {
    super('a notice text must not hold anything a reader could open as a link');
  }
}

/** Returns `text` when it holds nothing that reads as a link, and throws otherwise. */
export function plainText(text: string): string {
  if (LINK_LIKE.test(text)) throw new LinkInNoticeError();
  return text;
}

/**
 * A producer's value as notice text: letters, digits, spaces and `-_()+,'` only, and a dot only
 * before a digit (a version such as 14.1), at most 64 characters. Anything else becomes a space,
 * so `evil.example/x` reads as `evil example x` and no client can open it.
 */
export function producerValue(value: string): string {
  return value
    .replace(/\.(?!\p{N})/gu, ' ')
    .replace(/[^\p{L}\p{N} _()+,'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
}

const METHOD_NAMES: Readonly<Record<string, string>> = {
  passkey: 'A passkey',
  google: 'Google sign-in',
  openai: 'OpenAI sign-in',
  anthropic: 'Anthropic sign-in',
  anaconda: 'Anaconda sign-in',
  apple: 'Sign in with Apple',
  github: 'GitHub sign-in',
  gitlab: 'GitLab sign-in',
  discord: 'Discord sign-in',
  linkedin: 'LinkedIn sign-in',
  workos: 'Single sign-on',
  email: 'Email sign-in',
};

function what(kind: NoticeKind, details: NoticeDetails): { title: string; line: string } {
  const by = details.actor === 'support' ? ' by Kilo support' : '';
  switch (kind) {
    case 'new_device_network':
      return {
        title: 'New sign-in from a new device and network',
        line: 'Your Kilo account was signed in to from a device and a network it has not used before.',
      };
    case 'sign_in_method_changed': {
      const method =
        details.method === undefined
          ? 'A passkey or sign-in method'
          : (METHOD_NAMES[details.method] ?? 'A sign-in method');
      const change = details.change === undefined ? 'added or removed' : details.change;
      return {
        title: 'Sign-in method changed',
        line: `${method} was ${change} on your Kilo account${by}.`,
      };
    }
    case 'primary_email_changed':
      return {
        title: 'Account email changed',
        line: `The email address of your Kilo account was changed${by}. This notice goes to the previous and the new address.`,
      };
    case 'credential_created':
      return details.credential === 'bot_key'
        ? {
            title: 'New organization bot key',
            line: 'Your Kilo account created an organization bot key.',
          }
        : {
            title: 'New personal access token',
            line: 'A personal access token was created for your Kilo account.',
          };
    case 'device_sign_in_approved':
      return {
        title: 'Device sign-in approved',
        line: 'A device sign-in, such as one of the Kilo CLI, was approved from your Kilo account.',
      };
    case 'ci_trust_policy_changed':
      return {
        title: 'CI access changed',
        line: 'A CI trust policy, which lets a CI workflow act for your Kilo account, was created or changed.',
      };
    case 'third_party_client_approved': {
      const client =
        details.clientName === undefined
          ? 'An app'
          : `The app "${producerValue(details.clientName)}"`;
      return {
        title: 'App access approved',
        line: `${client} was given access to your Kilo account.`,
      };
    }
    case 'sessions_revoked':
      return {
        title: 'Sessions signed out',
        line: `One or more sessions or devices of your Kilo account were signed out${by}.`,
      };
    case 'suspicious_sign_in':
      return {
        title: 'Unusual sign-in activity',
        line: 'Kilo saw sign-in activity on your account that looks unusual.',
      };
    case 'sign_in_code_stopped':
      return {
        title: 'Sign-in codes paused',
        line: 'Many sign-in codes were asked for your account, so Kilo stopped sending codes for 1 hour. Sign-in emails carry only the sign-in link until then.',
      };
    case 'bot_key_flagged': {
      const keys =
        details.flaggedKeys === undefined ? 'Bot keys' : `${details.flaggedKeys} bot key(s)`;
      return {
        title: 'Organization bot keys flagged',
        line: `${keys} of a member who left your organization were flagged. They stop working in 7 days unless an owner or admin keeps them.`,
      };
    }
  }
}

/** `2026-11-26 14:05 UTC`. */
function utcMinute(time: Date): string {
  return `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export type RenderedNotice = {
  title: string;
  /** The event, the time, the approximate network and the device, one fact per line. */
  text: string;
};

export function renderNotice(
  kind: NoticeKind,
  rawDetails: unknown,
  createdAt: Date
): RenderedNotice {
  const details = NoticeDetailsSchema.catch({}).parse(rawDetails);
  const { title, line } = what(kind, details);
  const lines = [line, `Time: ${utcMinute(createdAt)}`];
  const place = [details.city, details.country]
    .filter(part => part !== undefined)
    .map(producerValue)
    .filter(part => part !== '');
  if (place.length > 0) {
    lines.push(`Approximate location, from the network: ${place.join(', ')}`);
  }
  const device = [details.deviceLabel, details.platform]
    .filter(part => part !== undefined)
    .map(producerValue)
    .filter(part => part !== '');
  if (device.length > 0) lines.push(`Device: ${device.join(', ')}`);
  return { title: plainText(title), text: plainText(lines.join('\n')) };
}

/** What every email adds below the notice text. */
const EMAIL_FOOTER = [
  'If this was you, there is nothing to do.',
  'If it was not you, sign in to Kilo as usual and open the security page in your account settings. There you can see your sessions and credentials and sign out what you do not know. You can also contact Kilo support from the app.',
  'Kilo never asks for your password, sign-in codes or tokens. This email holds no links.',
].join('\n');

export type NoticeEmail = { subject: string; text: string };
export type NoticePush = { title: string; body: string };

export function noticeEmail(rendered: RenderedNotice): NoticeEmail {
  return {
    subject: plainText(`Kilo security notice: ${rendered.title}`),
    text: plainText(`${rendered.text}\n\n${EMAIL_FOOTER}`),
  };
}

/** Push carries the event line only; the security page shows the rest. */
export function noticePush(rendered: RenderedNotice): NoticePush {
  const [line] = rendered.text.split('\n');
  return { title: rendered.title, body: plainText(line ?? rendered.title) };
}
