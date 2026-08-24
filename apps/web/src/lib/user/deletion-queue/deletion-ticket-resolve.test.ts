import { USER_DELETION_KILOCODE_APP_EMAIL } from '@/lib/user/deletion-queue/deletion-constants';
import {
  customerEmailFromPylonIssue,
  resolveTicketEmail,
} from '@/lib/user/deletion-queue/deletion-ticket-resolve';
import type { PylonMessageForPreflight } from '@/lib/user/deletion-queue/handlers/pylon-client';

const ISSUE_ID = 'iss_preflight';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function message(partial: {
  fromEmail?: string;
  toEmails?: string[];
  replyTo?: string | string[];
  contactEmail?: string;
  userEmail?: string;
}): PylonMessageForPreflight {
  return {
    emailInfo: {
      from_email: partial.fromEmail,
      to_emails: partial.toEmails,
      reply_to_email: Array.isArray(partial.replyTo) ? undefined : partial.replyTo,
      reply_to_emails: Array.isArray(partial.replyTo) ? partial.replyTo : undefined,
    },
    authorContactEmail: partial.contactEmail ?? null,
    authorUserEmail: partial.userEmail ?? null,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('customerEmailFromPylonIssue', () => {
  it('uses app-relay reply-to when first message is hi@app.kilocode.ai to itself', () => {
    const result = customerEmailFromPylonIssue(USER_DELETION_KILOCODE_APP_EMAIL, [
      message({
        fromEmail: USER_DELETION_KILOCODE_APP_EMAIL,
        toEmails: [USER_DELETION_KILOCODE_APP_EMAIL],
        replyTo: 'Relay-User@Example.com',
      }),
    ]);
    expect(result).toEqual({ kind: 'resolved', email: 'relay-user@example.com' });
  });

  it('needs attention when app-relay has multiple reply-tos', () => {
    const result = customerEmailFromPylonIssue(USER_DELETION_KILOCODE_APP_EMAIL, [
      message({
        fromEmail: USER_DELETION_KILOCODE_APP_EMAIL,
        toEmails: [USER_DELETION_KILOCODE_APP_EMAIL],
        replyTo: ['one@example.com', 'two@example.com'],
      }),
    ]);
    expect(result).toEqual({ kind: 'attention', code: 'app_relay_reply_to_ambiguous' });
  });

  it('skips a staff-domain requester and uses the first message email', () => {
    const result = customerEmailFromPylonIssue('cx@kilo.ai', [
      message({
        fromEmail: 'real-customer@example.com',
        contactEmail: 'real-customer@example.com',
      }),
    ]);
    expect(result).toEqual({ kind: 'resolved', email: 'real-customer@example.com' });
  });

  it('skips a pylon subdomain requester and walks messages', () => {
    const result = customerEmailFromPylonIssue('user@mail.service.usepylon.com', [
      message({
        fromEmail: 'real-customer@example.com',
        contactEmail: 'real-customer@example.com',
      }),
    ]);
    expect(result).toEqual({ kind: 'resolved', email: 'real-customer@example.com' });
  });

  it('uses a non-internal requester email', () => {
    const result = customerEmailFromPylonIssue('cust@example.com', []);
    expect(result).toEqual({ kind: 'resolved', email: 'cust@example.com' });
  });
});

describe('resolveTicketEmail', () => {
  const originalHost = process.env.PYLON_HOST;
  const originalKey = process.env.PYLON_API_KEY;

  beforeEach(() => {
    process.env.PYLON_API_KEY = 'test-pylon-key';
    process.env.PYLON_HOST = 'http://127.0.0.1:4010';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalHost === undefined) delete process.env.PYLON_HOST;
    else process.env.PYLON_HOST = originalHost;
    if (originalKey === undefined) delete process.env.PYLON_API_KEY;
    else process.env.PYLON_API_KEY = originalKey;
  });

  function mockPylon(issue: unknown, messages: unknown[], status = 200): jest.SpyInstance {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (status !== 200) return jsonResponse({}, status);
      if (url.includes('/messages')) return jsonResponse({ data: messages });
      return jsonResponse({ data: issue });
    });
  }

  it('returns delete_ready_missing when the tag is absent', async () => {
    mockPylon({ id: ISSUE_ID, tags: ['other'], requester: { email: 'cust@example.com' } }, []);
    await expect(resolveTicketEmail('#9001')).resolves.toEqual({
      kind: 'attention',
      code: 'delete_ready_missing',
    });
  });

  it('resolves app-relay hi@app.kilocode.ai with one reply-to', async () => {
    mockPylon(
      {
        id: ISSUE_ID,
        tags: ['delete-ready'],
        requester: { email: USER_DELETION_KILOCODE_APP_EMAIL },
      },
      [
        {
          id: 'msg_1',
          timestamp: '2026-01-01T00:00:00.000Z',
          email_info: {
            from_email: USER_DELETION_KILOCODE_APP_EMAIL,
            to_emails: [USER_DELETION_KILOCODE_APP_EMAIL],
            reply_to_email: 'Relay-User@Example.com',
          },
        },
      ]
    );
    await expect(resolveTicketEmail('#9001')).resolves.toEqual({
      kind: 'resolved',
      email: 'relay-user@example.com',
    });
  });

  it('skips a staff-domain requester and walks messages', async () => {
    mockPylon({ id: ISSUE_ID, tags: ['Delete-Ready'], requester: { email: 'cx@kilo.ai' } }, [
      {
        id: 'msg_1',
        timestamp: '2026-01-01T00:00:00.000Z',
        author: { contact: { email: 'real-customer@example.com' } },
        email_info: { from_email: 'real-customer@example.com' },
      },
    ]);
    await expect(resolveTicketEmail('#9001')).resolves.toEqual({
      kind: 'resolved',
      email: 'real-customer@example.com',
    });
  });

  it('skips a pylon subdomain requester and walks messages', async () => {
    mockPylon(
      {
        id: ISSUE_ID,
        tags: ['delete-ready'],
        requester: { email: 'user@mail.service.usepylon.com' },
      },
      [
        {
          id: 'msg_1',
          timestamp: '2026-01-01T00:00:00.000Z',
          author: { contact: { email: 'real-customer@example.com' } },
          email_info: { from_email: 'real-customer@example.com' },
        },
      ]
    );
    await expect(resolveTicketEmail('#9001')).resolves.toEqual({
      kind: 'resolved',
      email: 'real-customer@example.com',
    });
  });

  it('leaves a pylon subdomain requester unresolved when the thread has no customer email', async () => {
    mockPylon(
      {
        id: ISSUE_ID,
        tags: ['delete-ready'],
        requester: { email: 'user@mail.service.usepylon.com' },
      },
      []
    );
    await expect(resolveTicketEmail('#9001')).resolves.toEqual({
      kind: 'attention',
      code: 'ticket_unresolved',
    });
  });

  it('retries 429 without attention', async () => {
    mockPylon({}, [], 429);
    await expect(resolveTicketEmail('#9001')).resolves.toEqual({ kind: 'retryable' });
  });
});
