import { UTS_NOTICE_KINDS } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { IdentityStoreError } from '../../src/db/client';
import { NOTICE_KINDS } from '../../src/db/enums';
import { credentialNotices } from '../../src/notices/credential';
import {
  type NoticeDeps,
  deliverClaimed,
  dispatchNotice,
  sweepNotices,
} from '../../src/notices/dispatch';
import {
  type FakeAnswers,
  type RecordedMessage,
  ALWAYS_SENT,
  fakeTransports,
} from '../../src/notices/fake-transports';
import {
  LinkInNoticeError,
  NOTICE_CHANNEL_PLAN,
  type NoticeKind,
  noticeEmail,
  noticePush,
  plainText,
  placeName,
  renderNotice,
} from '../../src/notices/kinds';
import type {
  ClaimedNotice,
  FinishInput,
  FinishResult,
  NoticeStore,
} from '../../src/notices/store';
import { mailgunEmail, notificationsServicePush } from '../../src/notices/transports';

const CREATED_AT = new Date('2026-11-26T14:05:09Z');
const LINK_LIKE = /:\/\/|www\.|[\p{L}\p{N}-]\.\p{L}{2,}|@|https?:/iu;

/**
 * Every field a producer may set, holding what an attacker would put there: links, a phone
 * number, an instruction. None of it may reach a message.
 */
const HOSTILE_DETAILS = {
  deviceLabel: 'Call Kilo support 1 888 555 0100 now',
  platform: 'Reply with your code to 4242',
  deviceKind: 'browser',
  country: 'DE',
  city: 'Berlin 0800 123',
  credential: 'pat',
  method: 'toString',
  change: 'added',
  clientName: 'Visit evil.example/claim or mail me@evil.example',
  actor: 'support',
  flaggedKeys: 2,
};
/** Words and digits of the hostile values that no message may carry. */
const HOSTILE_WORDS = /Call|888|0100|Reply|4242|evil|0800|Visit|claim|function/;

function claimed(kind: NoticeKind, overrides: Partial<ClaimedNotice> = {}): ClaimedNotice {
  return {
    noticeId: '00000000-0000-4000-8000-000000000001',
    claimId: '00000000-0000-4000-8000-0000000000c1',
    accountId: 'oauth/user-1',
    kind,
    details: { country: 'DE', city: 'Berlin', deviceKind: 'desktop' },
    createdAt: CREATED_AT,
    round: 1,
    recipientEmail: 'user@example.com',
    primaryEmail: 'user@example.com',
    oldEmail: null,
    settledChannels: [],
    ...overrides,
  };
}

/** A notice store that hands out `queue` and records each finish. */
function memoryStore(
  queue: ClaimedNotice[],
  finish: FinishResult = { outcome: 'finished', delivery: 'delivered' }
) {
  const finished: FinishInput[] = [];
  const store: NoticeStore = {
    claimNotice: async noticeId => queue.find(notice => notice.noticeId === noticeId) ?? null,
    claimCredentialNotice: async () => queue[0] ?? null,
    claimDueNotices: async limit => queue.slice(0, limit),
    finishNotice: async input => {
      finished.push(input);
      return finish;
    },
    maintainNoticeRows: async () => [{ kind: 'notices', deleted: 3 }],
  };
  return { store, finished };
}

function deps(store: NoticeStore, answers: FakeAnswers, outbox: RecordedMessage[]): NoticeDeps {
  return {
    notices: work => work(store),
    transports: fakeTransports(answers, outbox),
    now: () => CREATED_AT,
  };
}

describe('notice kinds', () => {
  it('match the identity-store enum and the contract list', () => {
    expect([...UTS_NOTICE_KINDS]).toEqual([...NOTICE_KINDS]);
    expect(Object.keys(NOTICE_CHANNEL_PLAN).sort()).toEqual([...NOTICE_KINDS].sort());
  });

  it('send every design 5.13 event by push and then email, and the code stop by push only', () => {
    for (const kind of NOTICE_KINDS) {
      expect(NOTICE_CHANNEL_PLAN[kind]).toEqual(
        kind === 'sign_in_code_stopped' ? ['push'] : ['push', 'email']
      );
    }
  });

  it.each(NOTICE_KINDS)(
    'render %s without a link or a producer word, even from hostile details',
    kind => {
      for (const details of [{}, HOSTILE_DETAILS, { deviceLabel: 42, country: 'not a code' }]) {
        const rendered = renderNotice(kind, details, CREATED_AT);
        const email = noticeEmail(rendered);
        const push = noticePush(rendered);
        for (const text of [
          rendered.title,
          rendered.text,
          email.subject,
          email.text,
          push.title,
          push.body,
        ]) {
          expect(text).not.toMatch(LINK_LIKE);
          expect(text).not.toMatch(HOSTILE_WORDS);
        }
        expect(rendered.text).toContain('Time: 2026-11-26 14:05 UTC');
      }
    }
  );

  it('names the event, the time, the approximate network and the kind of device only', () => {
    const rendered = renderNotice(
      'new_device_network',
      {
        country: 'DE',
        city: 'Berlin',
        deviceKind: 'desktop',
        deviceLabel: 'Kilo CLI 1.2.3',
        platform: 'linux',
      },
      CREATED_AT
    );
    expect(rendered).toEqual({
      title: 'New sign-in from a new device and network',
      text: [
        'Your Kilo account was signed in to from a device and a network it has not used before.',
        'Time: 2026-11-26 14:05 UTC',
        'Approximate location, from the network: Berlin, DE',
        'Device: a desktop client, such as the Kilo CLI',
      ].join('\n'),
    });
    expect(noticeEmail(rendered).text).toContain('This email holds no links.');
    expect(
      renderNotice('new_device_network', { deviceKind: 'browser' }, CREATED_AT).text
    ).toContain('Device: a web browser');
    expect(renderNotice('new_device_network', { deviceKind: 'mobile' }, CREATED_AT).text).toContain(
      'Device: a mobile device'
    );
  });

  it('names a sign-in method only from its closed list', () => {
    const line = (method: string) =>
      renderNotice('sign_in_method_changed', { method, change: 'removed' }, CREATED_AT).text.split(
        '\n'
      )[0];
    expect(line('github')).toBe('GitHub sign-in was removed on your Kilo account.');
    expect(line('toString')).toBe('A sign-in method was removed on your Kilo account.');
  });

  it('says a change came from Kilo support without naming anyone', () => {
    const rendered = renderNotice('sessions_revoked', { actor: 'support' }, CREATED_AT);
    expect(rendered.text.split('\n')[0]).toBe(
      'One or more sessions or devices of your Kilo account were signed out by Kilo support.'
    );
  });

  it('refuses text that reads as a link', () => {
    for (const text of [
      'see https://x',
      'go to www.kilo',
      'open app.kilo.ai',
      'mail a@b',
      'mailto:x',
    ]) {
      expect(() => plainText(text)).toThrow(LinkInNoticeError);
    }
    expect(plainText('Kilo CLI 1.2.3 on macOS 14.1. Next line')).toBe(
      'Kilo CLI 1.2.3 on macOS 14.1. Next line'
    );
  });

  it('keeps only the letters of a place name', () => {
    expect(placeName('evil.example/login?x=1')).toBe('evil example login x');
    expect(placeName("Saint-Jean-d'Angély")).toBe("Saint-Jean-d'Angély");
    expect(placeName('Call 1 888 555 0100')).toBe('Call');
    expect(placeName('a'.repeat(100))).toHaveLength(40);
  });
});

describe('notice delivery', () => {
  it('sends push and then email, and finishes the claim with both attempts', async () => {
    const outbox: RecordedMessage[] = [];
    const { store, finished } = memoryStore([claimed('credential_created')]);
    const result = await deliverClaimed(
      deps(store, ALWAYS_SENT, outbox),
      claimed('credential_created')
    );
    expect(outbox.map(entry => entry.channel)).toEqual(['push', 'email']);
    expect(outbox[0]).toMatchObject({
      message: {
        accountId: 'oauth/user-1',
        idempotencyKey: 'uts-notice:00000000-0000-4000-8000-000000000001',
        kind: 'credential_created',
      },
    });
    expect(outbox[1]).toMatchObject({ message: { to: ['user@example.com'] } });
    expect(finished).toEqual([
      {
        noticeId: '00000000-0000-4000-8000-000000000001',
        claimId: '00000000-0000-4000-8000-0000000000c1',
        planned: ['push', 'email'],
        attempts: [
          { channel: 'push', outcome: 'sent', attemptedAt: CREATED_AT },
          { channel: 'email', outcome: 'sent', attemptedAt: CREATED_AT },
        ],
      },
    ]);
    expect(result.finish).toEqual({ outcome: 'finished', delivery: 'delivered' });
  });

  it('emails the previous address of an email change as well, each its own message', async () => {
    const outbox: RecordedMessage[] = [];
    const notice = claimed('primary_email_changed', { oldEmail: 'old@example.com' });
    await deliverClaimed(deps(memoryStore([notice]).store, ALWAYS_SENT, outbox), notice);
    expect(outbox[1]).toMatchObject({
      channel: 'email',
      message: { to: ['user@example.com', 'old@example.com'] },
    });
  });

  it('emails the address of the event time and the address on file now when they differ', async () => {
    const outbox: RecordedMessage[] = [];
    const notice = claimed('new_device_network', { primaryEmail: 'changed@example.com' });
    await deliverClaimed(deps(memoryStore([notice]).store, ALWAYS_SENT, outbox), notice);
    expect(outbox[1]).toMatchObject({
      channel: 'email',
      message: { to: ['user@example.com', 'changed@example.com'] },
    });
  });

  it('skips the channels an earlier round settled', async () => {
    const outbox: RecordedMessage[] = [];
    const notice = claimed('sessions_revoked', { round: 2, settledChannels: ['push'] });
    const { store, finished } = memoryStore([notice]);
    await deliverClaimed(deps(store, ALWAYS_SENT, outbox), notice);
    expect(outbox.map(entry => entry.channel)).toEqual(['email']);
    expect(finished[0].attempts.map(attempt => attempt.channel)).toEqual(['email']);
  });

  it('records a retryable failure and still tries the next channel', async () => {
    const outbox: RecordedMessage[] = [];
    const { store, finished } = memoryStore([], { outcome: 'finished', delivery: 'pending' });
    const result = await deliverClaimed(
      deps(store, { push: () => 'retryable_failure', email: () => 'sent' }, outbox),
      claimed('suspicious_sign_in')
    );
    expect(finished[0].attempts.map(attempt => attempt.outcome)).toEqual([
      'retryable_failure',
      'sent',
    ]);
    expect(result.finish).toEqual({ outcome: 'finished', delivery: 'pending' });
  });

  it('counts a provider that throws as a retryable failure', async () => {
    const { store, finished } = memoryStore([]);
    await deliverClaimed(
      {
        notices: work => work(store),
        transports: {
          push: async () => {
            throw new Error('down');
          },
          email: async () => 'permanent_failure',
        },
        now: () => CREATED_AT,
      },
      claimed('device_sign_in_approved')
    );
    expect(finished[0].attempts.map(attempt => attempt.outcome)).toEqual([
      'retryable_failure',
      'permanent_failure',
    ]);
  });

  it('records not_configured where the environment has no provider', async () => {
    const { store, finished } = memoryStore([], { outcome: 'finished', delivery: 'failed' });
    await deliverClaimed(
      {
        notices: work => work(store),
        transports: { push: null, email: null },
        now: () => CREATED_AT,
      },
      claimed('ci_trust_policy_changed')
    );
    expect(finished[0].attempts.map(attempt => attempt.outcome)).toEqual([
      'not_configured',
      'not_configured',
    ]);
  });

  it('answers null when the notice is not due, and sends nothing', async () => {
    const outbox: RecordedMessage[] = [];
    const { store } = memoryStore([]);
    expect(await dispatchNotice(deps(store, ALWAYS_SENT, outbox), 'missing')).toBeNull();
    expect(outbox).toEqual([]);
  });

  it('drops a stale claim result', async () => {
    const { store } = memoryStore([], { outcome: 'stale_claim' });
    const result = await deliverClaimed(
      deps(store, ALWAYS_SENT, []),
      claimed('suspicious_sign_in')
    );
    expect(result.finish).toEqual({ outcome: 'stale_claim' });
  });

  it('sweeps due notices and counts each result; a failed finish counts as unfinished', async () => {
    const queue = [
      claimed('sessions_revoked'),
      claimed('sign_in_code_stopped', { noticeId: 'n2' }),
    ];
    let calls = 0;
    const store: NoticeStore = {
      ...memoryStore(queue).store,
      finishNotice: async () => {
        calls += 1;
        if (calls === 2) {
          throw new IdentityStoreError('retryable', {
            sqlState: '08006',
            constraint: undefined,
            table: undefined,
            systemCode: undefined,
          });
        }
        return { outcome: 'finished', delivery: 'delivered' };
      },
    };
    const result = await sweepNotices(deps(store, ALWAYS_SENT, []));
    expect(result).toEqual({
      claimed: 2,
      delivered: 1,
      pending: 0,
      failed: 0,
      unfinished: 1,
      retention: { status: 'done', deleted: 3 },
    });
  });

  it('logs a failed retention step without failing the pass', async () => {
    const store: NoticeStore = {
      ...memoryStore([]).store,
      maintainNoticeRows: async () => {
        throw new Error('down');
      },
    };
    const result = await sweepNotices(deps(store, ALWAYS_SENT, []));
    expect(result.retention).toEqual({ status: 'failed' });
  });

  it('delivers the credential notice the create statement wrote, once', async () => {
    const outbox: RecordedMessage[] = [];
    const { store, finished } = memoryStore([claimed('credential_created')]);
    await credentialNotices(deps(store, ALWAYS_SENT, outbox))({
      kind: 'pat_created',
      accountId: 'oauth/user-1',
      credentialId: '00000000-0000-4000-8000-0000000000aa',
    });
    expect(finished).toHaveLength(1);
    const empty = memoryStore([]);
    await credentialNotices(deps(empty.store, ALWAYS_SENT, outbox))({
      kind: 'bot_key_created',
      accountId: 'oauth/user-1',
      credentialId: '00000000-0000-4000-8000-0000000000bb',
    });
    expect(empty.finished).toEqual([]);
  });
});

describe('Mailgun email', () => {
  const config = {
    baseUrl: 'https://api.mailgun.test',
    domain: 'mail.example.com',
    from: 'Kilo <security@mail.example.com>',
    apiKey: 'synthetic-key',
  };
  const message = {
    to: ['a@example.com', 'b@example.com'],
    subject: 'Kilo security notice',
    text: 'Line',
  };

  it('posts plain text with tracking off and one message per address', async () => {
    const requests: Request[] = [];
    const send = mailgunEmail(config, async (input, init) => {
      requests.push(new Request(input, init));
      return new Response('{}', { status: 200 });
    });
    expect(await send(message)).toBe('sent');
    const [request] = requests;
    expect(request.url).toBe('https://api.mailgun.test/v3/mail.example.com/messages');
    expect(request.headers.get('Authorization')).toBe(`Basic ${btoa('api:synthetic-key')}`);
    const form = await request.formData();
    expect(form.getAll('to')).toEqual(['a@example.com', 'b@example.com']);
    expect(JSON.parse(String(form.get('recipient-variables')))).toEqual({
      'a@example.com': {},
      'b@example.com': {},
    });
    expect(form.get('text')).toBe('Line');
    expect(form.has('html')).toBe(false);
    expect([
      form.get('o:tracking'),
      form.get('o:tracking-clicks'),
      form.get('o:tracking-opens'),
    ]).toEqual(['no', 'no', 'no']);
  });

  it.each([
    [429, 'retryable_failure'],
    [503, 'retryable_failure'],
    [400, 'permanent_failure'],
    [401, 'permanent_failure'],
  ] as const)('maps status %i to %s', async (status, outcome) => {
    const send = mailgunEmail(config, async () => new Response('{}', { status }));
    expect(await send(message)).toBe(outcome);
  });

  it('maps a network failure to a retryable failure', async () => {
    const send = mailgunEmail(config, async () => {
      throw new TypeError('network');
    });
    expect(await send(message)).toBe('retryable_failure');
  });
});

describe('push through the notifications Worker', () => {
  const message = {
    accountId: 'oauth/u',
    idempotencyKey: 'uts-notice:n',
    kind: 'sessions_revoked',
    title: 'T',
    body: 'B',
  } as const;

  it.each([
    [{ kind: 'delivered', tokenCount: 2 }, 'sent'],
    [{ kind: 'delivered', tokenCount: 0 }, 'no_target'],
    [{ kind: 'duplicate' }, 'sent'],
    [{ kind: 'no_tokens' }, 'no_target'],
    [{ kind: 'failed', error: 'expo' }, 'retryable_failure'],
    [{ kind: 'refused', error: 'invalid_payload' }, 'permanent_failure'],
    [{ kind: 'something_else' }, 'permanent_failure'],
  ] as const)('maps %o to %s', async (answer, outcome) => {
    const inputs: unknown[] = [];
    const push = notificationsServicePush({
      dispatchSecurityNotice: async input => {
        inputs.push(input);
        return answer;
      },
    });
    expect(await push(message)).toBe(outcome);
    expect(inputs).toEqual([
      {
        userId: 'oauth/u',
        idempotencyKey: 'uts-notice:n',
        kind: 'sessions_revoked',
        title: 'T',
        body: 'B',
      },
    ]);
  });

  it('takes a thrown refusal, such as a wrong caller, as a permanent failure', async () => {
    const push = notificationsServicePush({
      dispatchSecurityNotice: async () => {
        throw new Error('caller not allowed');
      },
    });
    expect(await push(message)).toBe('permanent_failure');
  });

  it('still emails, and does not retry push, when the receiver refuses', async () => {
    for (const refuse of [
      async () => {
        throw new Error('caller not allowed');
      },
      async () => ({ kind: 'refused', error: 'invalid_payload' }),
    ]) {
      const outbox: RecordedMessage[] = [];
      const { store, finished } = memoryStore([]);
      const result = await deliverClaimed(
        {
          notices: work => work(store),
          transports: {
            push: notificationsServicePush({ dispatchSecurityNotice: refuse }),
            email: fakeTransports(ALWAYS_SENT, outbox).email,
          },
          now: () => CREATED_AT,
        },
        claimed('new_device_network')
      );
      expect(finished[0].attempts.map(attempt => [attempt.channel, attempt.outcome])).toEqual([
        ['push', 'permanent_failure'],
        ['email', 'sent'],
      ]);
      expect(outbox.map(entry => entry.channel)).toEqual(['email']);
      expect(result.finish).toEqual({ outcome: 'finished', delivery: 'delivered' });
    }
  });
});
