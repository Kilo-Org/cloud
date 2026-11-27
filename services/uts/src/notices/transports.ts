import type { UtsNoticeKind } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { NOTICE_ATTEMPT_OUTCOMES } from '../db/enums';
import { isMailAddress } from '../signin/email/address';

/**
 * The push and email providers UTS sends notices through (design 5.13): Expo push through the
 * `notifications` Worker, which holds every user's Expo push tokens and the Expo access token,
 * and Mailgun for email. Each transport answers one outcome per message:
 *
 * | Outcome | Meaning |
 * |---|---|
 * | `sent` | The provider accepted the message for at least one device or address |
 * | `no_target` | The account has nothing to send to on this channel (no push device) |
 * | `not_configured` | This environment has no provider for the channel |
 * | `retryable_failure` | The provider or the network failed; a later round may succeed |
 * | `permanent_failure` | The provider refused the message; a retry would fail the same way |
 */

export type ChannelOutcome = (typeof NOTICE_ATTEMPT_OUTCOMES)[number];

export type PushMessage = {
  accountId: string;
  /** One key per notice, so a retried round that already reached the devices is not repeated. */
  idempotencyKey: string;
  kind: UtsNoticeKind;
  title: string;
  body: string;
};

export type EmailMessage = {
  /** One or two addresses; each gets its own message, so neither sees the other. */
  to: readonly string[];
  subject: string;
  text: string;
};

export type PushTransport = (message: PushMessage) => Promise<ChannelOutcome>;
export type EmailTransport = (message: EmailMessage) => Promise<ChannelOutcome>;

/** Null where the environment has no provider for the channel. */
export type NoticeTransports = { push: PushTransport | null; email: EmailTransport | null };

/** Every provider call gives up after this long and counts as a retryable failure. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * The `notifications` Worker's RPC for a security notice, on its named entrypoint
 * `SecurityNotices`, which the mint Worker binds with its own deployed name as `props.caller`
 * (`UTS_MINT_DEPLOYMENTS`): one push to every Expo token of the user, with no presence,
 * preference or rate-limit suppression (a security notice is never muted), deduplicated by
 * `idempotencyKey`. Its answer uses the outcome vocabulary of that Worker's `dispatchPush`.
 */
export type SecurityPushService = {
  dispatchSecurityNotice(input: {
    userId: string;
    idempotencyKey: string;
    kind: UtsNoticeKind;
    title: string;
    body: string;
  }): Promise<unknown>;
};

const DispatchOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delivered'), tokenCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('duplicate') }),
  z.object({ kind: z.literal('no_tokens') }),
  z.object({ kind: z.literal('failed'), error: z.string() }),
]);

type Timed<Result> = { status: 'answered'; value: Result } | { status: 'timed_out' };

/** `work`'s result, or `timed_out` once `PROVIDER_TIMEOUT_MS` passes first. */
async function withinProviderTimeout<Result>(work: Promise<Result>): Promise<Timed<Result>> {
  const { promise: timeout, resolve } = Promise.withResolvers<Timed<Result>>();
  const timer = setTimeout(() => resolve({ status: 'timed_out' }), PROVIDER_TIMEOUT_MS);
  try {
    return await Promise.race([
      work.then((value): Timed<Result> => ({ status: 'answered', value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function logRefusal(kind: UtsNoticeKind, reason: 'threw' | 'invalid_answer', error?: unknown) {
  console.error(
    JSON.stringify({
      event: 'uts.notice.push_refused',
      kind,
      reason,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.name : 'unknown' }),
    })
  );
}

/**
 * Push through the `notifications` Worker's service binding. An answer outside its outcome union
 * is a permanent failure of push for that notice, which is logged and not retried, and email still
 * goes out. A call that throws is retried like a timeout: a binding call throws for a network or
 * deploy fault as well as for a refusal, and the two cannot be told apart, so a push-only notice
 * (`sign_in_code_stopped`) is not given up after one fault; a refusal that throws every time fails
 * after the notice's 3 rounds.
 */
export function notificationsServicePush(service: SecurityPushService): PushTransport {
  return async message => {
    let answer;
    try {
      answer = await withinProviderTimeout(
        service.dispatchSecurityNotice({
          userId: message.accountId,
          idempotencyKey: message.idempotencyKey,
          kind: message.kind,
          title: message.title,
          body: message.body,
        })
      );
    } catch (error) {
      logRefusal(message.kind, 'threw', error);
      return 'retryable_failure';
    }
    if (answer.status === 'timed_out') return 'retryable_failure';
    const outcome = DispatchOutcomeSchema.safeParse(answer.value);
    if (!outcome.success) {
      logRefusal(message.kind, 'invalid_answer');
      return 'permanent_failure';
    }
    switch (outcome.data.kind) {
      case 'delivered':
        return outcome.data.tokenCount > 0 ? 'sent' : 'no_target';
      // An earlier round with the same key reached the devices.
      case 'duplicate':
        return 'sent';
      case 'no_tokens':
        return 'no_target';
      case 'failed':
        return 'retryable_failure';
    }
  };
}

export type MailgunConfig = {
  /** The API host of the region that holds the sending domain, such as `https://api.mailgun.net`. */
  baseUrl: string;
  domain: string;
  /** The sender, such as `Kilo <security@...>`. */
  from: string;
  apiKey: string;
};

/**
 * Email through Mailgun's messages API, as plain text only, so no message holds an HTML anchor.
 * Tracking is off, so Mailgun rewrites nothing into a link. `recipient-variables` makes Mailgun send
 * each address its own message. Mailgun reads `to` as an address list, so a recipient that is not
 * a plain addr-spec in any letter case (`isMailAddress`) is dropped before the call (a display
 * name or a comma could otherwise reach another mailbox), as `guardedEmail` drops an address the
 * recipient rule refuses; a message left with no address is `no_target`. `fetcher` is the global
 * `fetch` in a Worker and a fake in tests.
 */
export function mailgunEmail(config: MailgunConfig, fetcher: typeof fetch): EmailTransport {
  const url = `${config.baseUrl}/v3/${encodeURIComponent(config.domain)}/messages`;
  const authorization = `Basic ${btoa(`api:${config.apiKey}`)}`;
  return async message => {
    const to = message.to.filter(address => isMailAddress(address.toLowerCase()));
    if (to.length < message.to.length) {
      console.error(
        JSON.stringify({
          event: 'uts.mail.recipient_invalid',
          dropped: message.to.length - to.length,
        })
      );
    }
    if (to.length === 0) return 'no_target';
    const form = new FormData();
    form.set('from', config.from);
    for (const address of to) form.append('to', address);
    form.set('recipient-variables', JSON.stringify(Object.fromEntries(to.map(a => [a, {}]))));
    form.set('subject', message.subject);
    form.set('text', message.text);
    form.set('o:tracking', 'no');
    form.set('o:tracking-clicks', 'no');
    form.set('o:tracking-opens', 'no');
    form.set('h:Auto-Submitted', 'auto-generated');
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: authorization },
        body: form,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      return 'retryable_failure';
    }
    await response.body?.cancel();
    if (response.ok) return 'sent';
    return response.status === 429 || response.status >= 500
      ? 'retryable_failure'
      : 'permanent_failure';
  };
}
