import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4010;
const DEFAULT_HOST = '127.0.0.1';
const RETRY_AFTER_SECONDS = 8;

const TICKETS: Record<number, string> = {
  1001: 'ok@local.test',
  1429: '429-posthog@local.test',
  1430: '429-pylon@local.test',
  1431: '429-pylon-reply@local.test',
  1500: 'fail-posthog@local.test',
  1501: 'fail-pylon@local.test',
  1600: 'slow-posthog@local.test',
  1700: 'missing@local.test',
  1804: 'expired-substack@local.test',
  1805: 'no-substack@local.test',
  1806: '429-cio@local.test',
  1807: 'fail-cio@local.test',
  2001: 'ok2@local.test',
  2002: 'ok3@local.test',
  2003: 'ok4@local.test',
};

const UNRESOLVED_TICKETS = new Set([1]);

type Scenario =
  | 'ok'
  | '429-posthog'
  | '429-pylon'
  | '429-pylon-reply'
  | 'fail-posthog'
  | 'fail-pylon'
  | 'slow-posthog'
  | 'missing'
  | 'expired-substack'
  | 'no-substack'
  | '429-cio'
  | 'fail-cio';

type Person = {
  id: string;
  email: string;
  distinctIds: string[];
  deleted: boolean;
  verifyPolls: number;
};

type Contact = {
  id: string;
  email: string;
  deleted: boolean;
};

type IssueMessage = {
  id: string;
  message_html: string;
  timestamp: string;
  source: string;
  is_private: boolean;
  thread_id: string;
  author: Record<string, unknown>;
  email_info: Record<string, unknown>;
};

type Issue = {
  id: string;
  number: number;
  email: string;
  state: string;
  createdAt: string;
  messages: IssueMessage[];
};

type Subscriber = {
  id: string;
  email: string;
  deleted: boolean;
  decoy: boolean;
};

export type DeletionProviderMockHandle = {
  host: string;
  port: number;
  origin: string;
  close: () => Promise<void>;
};

export function emailForIssue(number: number): string {
  return TICKETS[number] ?? `ok+${number}@local.test`;
}

export function scenarioFromEmail(email: string): Scenario {
  const local = localPart(email);
  if (local.startsWith('429-posthog')) return '429-posthog';
  if (local.startsWith('429-pylon-reply')) return '429-pylon-reply';
  if (local.startsWith('429-pylon')) return '429-pylon';
  if (local.startsWith('fail-posthog')) return 'fail-posthog';
  if (local.startsWith('fail-pylon')) return 'fail-pylon';
  if (local.startsWith('slow-posthog')) return 'slow-posthog';
  if (local.startsWith('expired-substack')) return 'expired-substack';
  if (local.startsWith('no-substack')) return 'no-substack';
  if (local.startsWith('429-cio')) return '429-cio';
  if (local.startsWith('fail-cio')) return 'fail-cio';
  if (local.startsWith('missing')) return 'missing';
  return 'ok';
}

function localPart(email: string): string {
  return email.split('@')[0] ?? email;
}

function nowIso(): string {
  return new Date().toISOString();
}

function personIdForEmail(email: string): string {
  const hex = createHash('sha256').update(`posthog:${email}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function contactIdForEmail(email: string): string {
  return `contact-${localPart(email)}`;
}

function parseIssueRef(raw: string): number | null {
  const value = decodeURIComponent(raw);
  const numeric = value.replace(/^iss[_-]/i, '');
  if (/^\d+$/.test(numeric)) return Number(numeric);
  return null;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function rateLimited(res: ServerResponse): void {
  json(res, 429, { detail: 'rate limited' }, { 'retry-after': String(RETRY_AFTER_SECONDS) });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function helpText(host: string, port: number): string {
  return [
    'Deletion provider mock (PostHog + Pylon + Substack + Customer.io)',
    '',
    `Listening on http://${host}:${port}`,
    'Point POSTHOG_HOST, PYLON_HOST, SUBSTACK_PUBLICATION_URL, and CUSTOMERIO_TRACK_BASE at this origin.',
    '',
    'Email local-part scenarios:',
    '  ok@local.test                 happy path for all mocked providers',
    '  ok2@local.test / ok3 / ok4    extra happy-path Cloud users',
    '  429-posthog@local.test        PostHog bulk delete 429',
    '  429-pylon@local.test          Pylon contact delete 429',
    '  429-pylon-reply@local.test    Pylon reply 429',
    '  fail-posthog@local.test       PostHog lookup 500',
    '  fail-pylon@local.test         Pylon lookup 500',
    '  slow-posthog@local.test       person GET stays 200 for two polls, then 404',
    '  missing@local.test            empty/404 on all providers',
    '  expired-substack@local.test   Substack 401',
    '  no-substack@local.test        no Substack subscriber; other providers ok',
    '  429-cio@local.test            Customer.io DELETE 429',
    '  fail-cio@local.test           Customer.io DELETE 500',
    '',
    'Ticket-only shortcuts:',
    '  #1001 ok   #1429 429-posthog   #1430 429-pylon   #1431 429-pylon-reply',
    '  #1500 fail-posthog   #1501 fail-pylon   #1600 slow-posthog   #1700 missing',
    '  #1804 expired-substack   #1805 no-substack   #1806 429-cio   #1807 fail-cio',
    '  #2001 ok2   #2002 ok3   #2003 ok4',
    '  #1 no requester (ticket_unresolved)',
    '',
    'Unknown numeric tickets map to ok+<number>@local.test.',
    '',
  ].join('\n');
}

function createDeletionProviderMockState(): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const persons = new Map<string, Person>();
  const contacts = new Map<string, Contact>();
  const issues = new Map<string, Issue>();
  const subscribers = new Map<string, Subscriber>();

  function ensurePerson(email: string): Person {
    const id = personIdForEmail(email);
    let person = persons.get(id);
    if (!person) {
      person = { id, email, distinctIds: [email, id], deleted: false, verifyPolls: 0 };
      persons.set(id, person);
      ensureSubscriber(email);
    }
    return person;
  }

  function ensureContact(email: string): Contact {
    const id = contactIdForEmail(email);
    let contact = contacts.get(id);
    if (!contact) {
      contact = { id, email, deleted: false };
      contacts.set(id, contact);
      ensureSubscriber(email);
    }
    return contact;
  }

  function ensureIssue(number: number): Issue {
    const id = `iss_${number}`;
    const existing = issues.get(id) ?? issues.get(String(number));
    if (existing) return existing;
    const email = emailForIssue(number);
    ensureSubscriber(email);
    const contact = ensureContact(email);
    const createdAt = nowIso();
    const issue: Issue = {
      id,
      number,
      email,
      state: 'open',
      createdAt,
      messages: [
        {
          id: `msg-${number}-customer`,
          message_html: '<p>Please delete my account and all associated data.</p>',
          timestamp: createdAt,
          source: 'email',
          is_private: false,
          thread_id: `thread-${number}`,
          author: { contact: { id: contact.id, email } },
          email_info: { from_email: email, to_emails: ['support@kilocode.ai'] },
        },
      ],
    };
    issues.set(id, issue);
    issues.set(String(number), issue);
    return issue;
  }

  function ensureSubscriber(email: string): Subscriber | null {
    const normalized = email.trim().toLowerCase();
    const scenario = scenarioFromEmail(normalized);
    if (!normalized || scenario === 'missing' || scenario === 'no-substack') return null;
    const id = `sub-${localPart(normalized)}`;
    let subscriber = subscribers.get(id);
    if (!subscriber) {
      subscriber = { id, email: normalized, deleted: false, decoy: false };
      subscribers.set(id, subscriber);
    }
    return subscriber;
  }

  function seedPresentSubscribers(): void {
    for (const email of Object.values(TICKETS)) {
      ensureSubscriber(email);
    }
    ensureDecoySubscriber('partial-prefix-decoy', 'decoy-prefix@local.test');
    ensureDecoySubscriber('partial-substr-decoy', 'xdecoy@local.test');
  }

  function ensureDecoySubscriber(id: string, email: string): Subscriber {
    let subscriber = subscribers.get(id);
    if (!subscriber) {
      subscriber = { id, email, deleted: false, decoy: true };
      subscribers.set(id, subscriber);
    }
    return subscriber;
  }

  seedPresentSubscribers();

  function issuePayload(issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      title: `GDPR deletion for ${issue.email}`,
      body_html: '<p>Please delete my data</p>',
      state: issue.state,
      source: 'email',
      type: 'ticket',
      created_at: issue.createdAt,
      latest_message_time: issue.messages.at(-1)?.timestamp ?? issue.createdAt,
      number: issue.number,
      tags: [],
      requester: { id: contactIdForEmail(issue.email), email: issue.email },
    };
  }

  function findPersonsByDistinctIds(ids: string[]): Person[] {
    const wanted = new Set(ids);
    const matched: Person[] = [];
    for (const person of persons.values()) {
      if (wanted.has(person.id) || person.distinctIds.some(id => wanted.has(id))) {
        matched.push(person);
      }
    }
    return matched;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`;
    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    console.log(`${method} ${path}${url.search}`);

    if (method === 'GET' && path === '/') {
      const [listenHost, listenPort] = host.split(':');
      text(res, 200, helpText(listenHost || DEFAULT_HOST, Number(listenPort) || DEFAULT_PORT));
      return;
    }

    const personsMatch = path.match(/^\/api\/projects\/[^/]+\/persons$/);
    const personMatch = path.match(/^\/api\/projects\/[^/]+\/persons\/([^/]+)$/);
    const bulkDeleteMatch = path.match(/^\/api\/projects\/[^/]+\/persons\/bulk_delete$/);
    const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
    const issueMessagesMatch = path.match(/^\/issues\/([^/]+)\/messages$/);
    const issueReplyMatch = path.match(/^\/issues\/([^/]+)\/reply$/);
    const issueMatch = path.match(/^\/issues\/([^/]+)$/);
    const substackSubscriberMatch = path.match(/^\/api\/v1\/subscriber\/([^/]+)$/);
    const customerMatch = path.match(/^\/api\/v1\/customers\/([^/]+)$/);

    if (method === 'GET' && personsMatch) {
      const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
      const scenario = scenarioFromEmail(email);
      if (scenario === 'fail-posthog') {
        json(res, 500, { detail: 'posthog lookup failed' });
        return;
      }
      if (!email || scenario === 'missing') {
        json(res, 200, { results: [] });
        return;
      }
      const person = ensurePerson(email);
      if (person.deleted) {
        json(res, 200, { results: [] });
        return;
      }
      json(res, 200, {
        results: [{ id: person.id, distinct_ids: person.distinctIds, properties: { email } }],
      });
      return;
    }

    if (method === 'POST' && bulkDeleteMatch) {
      const body = await readBody(req);
      const ids =
        isRecord(body) && Array.isArray(body.distinct_ids) ? body.distinct_ids.map(String) : [];
      const matched = findPersonsByDistinctIds(ids);
      const emailHints = ids.filter(id => id.includes('@'));
      if (
        matched.some(person => scenarioFromEmail(person.email) === '429-posthog') ||
        emailHints.some(email => scenarioFromEmail(email) === '429-posthog')
      ) {
        rateLimited(res);
        return;
      }
      for (const person of matched) {
        person.deleted = true;
        person.verifyPolls = 0;
      }
      json(res, 202, { id: 'deletion-mock' });
      return;
    }

    if (method === 'GET' && personMatch) {
      const person = persons.get(decodeURIComponent(personMatch[1] ?? ''));
      if (!person) {
        json(res, 404, { detail: 'not found' });
        return;
      }
      if (person.deleted) {
        if (scenarioFromEmail(person.email) === 'slow-posthog' && person.verifyPolls < 2) {
          person.verifyPolls += 1;
          json(res, 200, {
            id: person.id,
            distinct_ids: person.distinctIds,
            properties: { email: person.email },
          });
          return;
        }
        json(res, 404, { detail: 'not found' });
        return;
      }
      json(res, 200, {
        id: person.id,
        distinct_ids: person.distinctIds,
        properties: { email: person.email },
      });
      return;
    }

    if (method === 'POST' && path === '/contacts/search') {
      const body = await readBody(req);
      const filter = isRecord(body) && isRecord(body.filter) ? body.filter : null;
      const email = String(filter?.value ?? '')
        .trim()
        .toLowerCase();
      const scenario = scenarioFromEmail(email);
      if (scenario === 'fail-pylon') {
        json(res, 500, { errors: ['pylon lookup failed'] });
        return;
      }
      if (!email || scenario === 'missing') {
        json(res, 200, { data: [], pagination: { has_next_page: false } });
        return;
      }
      const contact = ensureContact(email);
      json(res, 200, {
        data: contact.deleted
          ? []
          : [
              {
                id: contact.id,
                email: contact.email,
                emails: [contact.email],
                name: localPart(email),
              },
            ],
        pagination: { has_next_page: false },
      });
      return;
    }

    if (contactMatch) {
      const contact = contacts.get(decodeURIComponent(contactMatch[1] ?? ''));
      if (method === 'DELETE') {
        if (contact && scenarioFromEmail(contact.email) === '429-pylon') {
          rateLimited(res);
          return;
        }
        if (contact) contact.deleted = true;
        json(
          res,
          contact ? 200 : 404,
          contact ? { data: { id: contact.id } } : { errors: ['not found'] }
        );
        return;
      }
      if (!contact || contact.deleted) {
        json(res, 404, { errors: ['not found'] });
        return;
      }
      json(res, 200, { data: { id: contact.id, email: contact.email } });
      return;
    }

    if (method === 'GET' && issueMessagesMatch) {
      const number = parseIssueRef(issueMessagesMatch[1] ?? '');
      if (number == null) {
        json(res, 404, { errors: ['not found'] });
        return;
      }
      const issue = ensureIssue(number);
      json(res, 200, { data: issue.messages, pagination: { has_next_page: false } });
      return;
    }

    if (method === 'POST' && issueReplyMatch) {
      const number = parseIssueRef(issueReplyMatch[1] ?? '');
      if (number == null) {
        json(res, 404, { errors: ['not found'] });
        return;
      }
      const issue = ensureIssue(number);
      if (scenarioFromEmail(issue.email) === '429-pylon-reply') {
        rateLimited(res);
        return;
      }
      const body = await readBody(req);
      const messageId = `msg-${number}-final-${issue.messages.length + 1}`;
      const emailInfo = isRecord(body) && isRecord(body.email_info) ? body.email_info : {};
      issue.messages.push({
        id: messageId,
        message_html: isRecord(body) ? String(body.body_html ?? '') : '',
        timestamp: nowIso(),
        source: 'email',
        is_private: false,
        thread_id: `thread-${number}`,
        author: { user: { id: 'bot-user', email: 'bot@kilocode.ai' } },
        email_info: { to_emails: emailInfo.to_emails ?? [issue.email] },
      });
      json(res, 200, { data: { id: messageId, issue_id: issue.id } });
      return;
    }

    if (issueMatch) {
      const number = parseIssueRef(issueMatch[1] ?? '');
      if (number == null) {
        json(res, 404, { errors: ['not found'] });
        return;
      }
      if (UNRESOLVED_TICKETS.has(number) && (method === 'GET' || method === 'PATCH')) {
        json(res, 200, {
          data: {
            id: `iss_${number}`,
            title: 'GDPR deletion with no requester',
            body_html: '<p>Please delete my data</p>',
            state: 'open',
            source: 'email',
            type: 'ticket',
            number,
            tags: [],
            requester: {},
          },
        });
        return;
      }
      const issue = ensureIssue(number);
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (isRecord(body) && typeof body.state === 'string' && body.state.trim()) {
          issue.state = body.state.trim();
        }
      }
      if (method === 'GET' || method === 'PATCH') {
        json(res, 200, { data: issuePayload(issue) });
        return;
      }
    }

    if (method === 'GET' && path === '/api/v1/subscriber') {
      const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
      const limitRaw = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
      const rows = [...subscribers.values()].filter(subscriber => !subscriber.deleted);
      json(res, 200, {
        subscribers: rows.slice(offset, offset + limit).map(subscriber => ({
          id: subscriber.id,
          email: subscriber.email,
        })),
      });
      return;
    }

    if (method === 'DELETE' && substackSubscriberMatch) {
      const subscriberId = decodeURIComponent(substackSubscriberMatch[1] ?? '');
      if (subscriberId.startsWith('partial-')) {
        json(res, 409, { error: 'refused to delete non-exact subscriber' });
        return;
      }
      const subscriber = subscribers.get(subscriberId);
      if (subscriber?.decoy) {
        json(res, 409, { error: 'refused to delete non-exact subscriber' });
        return;
      }
      if (subscriber && scenarioFromEmail(subscriber.email) === 'expired-substack') {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (subscriber) subscriber.deleted = true;
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && path === '/api/v1/user/profile/self') {
      json(res, 200, { id: 1, name: 'Mock Substack', handle: 'mock' });
      return;
    }

    if (method === 'DELETE' && customerMatch) {
      const email = decodeURIComponent(customerMatch[1] ?? '')
        .trim()
        .toLowerCase();
      const scenario = scenarioFromEmail(email);
      if (scenario === '429-cio') {
        rateLimited(res);
        return;
      }
      if (scenario === 'fail-cio') {
        json(res, 500, { detail: 'customerio delete failed' });
        return;
      }
      if (!email || scenario === 'missing') {
        json(res, 404, { detail: 'not found' });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { detail: `unhandled ${method} ${path}` });
  }

  return { handle };
}

export async function startDeletionProviderMock(opts?: {
  host?: string;
  port?: number;
}): Promise<DeletionProviderMockHandle> {
  const host = opts?.host ?? DEFAULT_HOST;
  const requestedPort = opts?.port ?? DEFAULT_PORT;
  const { handle } = createDeletionProviderMockState();
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) {
        json(res, 500, { detail: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
    throw new Error('deletion-provider-mock failed to bind a TCP port');
  }
  const bound = address satisfies AddressInfo;
  const origin = `http://${host}:${bound.port}`;
  return {
    host,
    port: bound.port,
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  startDeletionProviderMock({ port, host: DEFAULT_HOST })
    .then(handle => {
      console.log(helpText(handle.host, handle.port));
      const shutdown = async (signal: string): Promise<void> => {
        console.log(`received ${signal}, shutting down`);
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', () => {
        void shutdown('SIGINT');
      });
      process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
      });
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
