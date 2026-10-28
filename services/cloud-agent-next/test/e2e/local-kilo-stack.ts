import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { signKiloToken } from '@kilocode/worker-utils';
import { z } from 'zod';
import { loadRepoEnvFiles, type TestUser } from './auth.js';
import type { DriverConfig } from './client.js';
import { openKiloSse, type KiloEvent, type startLocalKilo } from './local-kilo.js';
import { createMessageId } from '../../src/session/message-id.js';

export const PROVIDER = 'kilo-cloud';
export const FAKE_MODEL = 'fake-deterministic';
export const FULL_MODEL = 'kilo/fake-deterministic';
export const GIT_URL = 'https://github.com/octocat/Hello-World.git';
export const HOST = '/kilocode/session-host';
export const BUDGET = 180_000;

export const object = z.record(z.string(), z.unknown());
export const identity = z.object({ providerID: z.string(), sessionID: z.string() });
export const workspaceIdentity = z.object({ providerID: z.string(), workspaceID: z.string() });
export const started = z.object({
  workspace: workspaceIdentity,
  session: identity,
  messageID: z.string(),
  replayed: z.boolean(),
});
export const sessionStarted = z.object({
  session: identity,
  messageID: z.string(),
  delivery: z.enum(['sent', 'queued']),
  replayed: z.boolean(),
});
export const workspaceSessionStarted = z.object({
  workspace: workspaceIdentity,
  session: identity,
  messageID: z.string(),
  replayed: z.boolean(),
});
export const workspaceDetail = z.object({
  id: workspaceIdentity,
  profileID: z.unknown().optional(),
  sessions: z.array(z.object({ id: identity })),
});
export const transcriptPage = z.object({
  items: z.array(z.object({ info: object, parts: z.array(object) })),
});

export type Identity = z.infer<typeof identity>;
export type WorkspaceIdentity = z.infer<typeof workspaceIdentity>;
export type TranscriptItem = z.infer<typeof transcriptPage>['items'][number];
export type FeedStream = Awaited<ReturnType<typeof openKiloSse>>;
export type LocalKilo = Awaited<ReturnType<typeof startLocalKilo>>;

export type RequestOptions = {
  body?: unknown;
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
};

export type RequestResult = {
  status: number;
  value: unknown;
  text: string;
  headers: Headers;
  ok: boolean;
};

export class KiloRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> {
  const parsed = object.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function eventMessage(event: { properties: Record<string, unknown> }): Record<string, unknown> {
  const parsed = object.safeParse(event.properties.info);
  return parsed.success ? parsed.data : {};
}

export async function eventually<T>(
  label: string,
  read: () => Promise<T | undefined>,
  milliseconds = BUDGET
): Promise<T> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function newMessageId(): string {
  return createMessageId();
}

export type Stack = {
  service: string;
  root: string;
  kiloRepo: string;
  bun: string;
  bunVersion: string;
  web: string;
  worker: string;
  gateway: string;
  fake: string;
  postgres: number;
  database: string;
};

export async function discoverStack(input: { kiloRepo: string; bun?: string }): Promise<Stack> {
  const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const root = path.resolve(service, '../..');
  const kiloRepo = path.resolve(input.kiloRepo);
  const manifest = z
    .object({ packageManager: z.string() })
    .parse(JSON.parse(await readFile(path.join(kiloRepo, 'package.json'), 'utf8')));
  const bun = input.bun ?? 'bun';
  const bunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  assert.equal(
    `bun@${bunVersion}`,
    manifest.packageManager,
    'Use the Kilo repository-pinned Bun version'
  );
  const statusSchema = z.object({
    services: z.array(z.object({ name: z.string(), port: z.number(), status: z.string() })),
  });
  const required = [
    'nextjs',
    'cloud-agent-next',
    'ai-gateway',
    'fake-llm',
    'postgres',
    // Sandbox preparation calls this service; a down meter fails a cold start late.
    'container-usage-meter',
  ];
  // The status probe intermittently reports the whole stack down under load.
  const status = await (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const parsed = statusSchema.parse(
          JSON.parse(
            execFileSync('pnpm', ['-s', 'dev:status', '--json'], {
              cwd: root,
              encoding: 'utf8',
              timeout: 30_000,
            })
          )
        );
        if (
          required.every(name =>
            parsed.services.some(entry => entry.name === name && entry.status === 'up')
          )
        ) {
          return parsed;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(2_000);
    }
    throw new Error(
      `Local stack is not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  })();
  const port = (name: string) => {
    const entry = status.services.find(item => item.name === name && item.status === 'up');
    assert(entry && entry.port > 0, `Local service ${name} is not running`);
    return entry.port;
  };
  const web = `http://localhost:${port('nextjs')}`;
  const worker = `http://localhost:${port('cloud-agent-next')}`;
  const gateway = `http://localhost:${port('ai-gateway')}`;
  const fake = `http://localhost:${port('fake-llm')}`;
  const postgres = port('postgres');
  assert(
    (await fetch(`${worker}/health`, { signal: AbortSignal.timeout(10_000) })).ok,
    'Cloud Worker health failed'
  );
  loadRepoEnvFiles(service);
  const database = process.env.POSTGRES_URL;
  assert(database, 'POSTGRES_URL is required');
  const target = new URL(database);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
      Number(target.port) === postgres,
    'Database does not belong to the discovered local stack'
  );
  return { service, root, kiloRepo, bun, bunVersion, web, worker, gateway, fake, postgres, database };
}

export function driverConfig(input: {
  worker: string;
  fake: string;
  user: TestUser;
  token: string;
}): DriverConfig {
  return {
    workerUrl: input.worker,
    fakeLlmUrl: input.fake,
    user: input.user,
    bearerToken: input.token,
    skipBalanceCheck: false,
    gitUrl: GIT_URL,
    model: FULL_MODEL,
  };
}

export function signUserToken(
  nextAuthSecret: string,
  user: Pick<TestUser, 'id' | 'api_token_pepper'>
): Promise<string> {
  return signKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret: nextAuthSecret,
    // Legacy API credential exchange requires the historical five-year lifetime.
    expiresInSeconds: 1825 * 86400,
    env: 'development',
  }).then(value => value.token);
}

export type KiloClient = {
  raw: (route: string, options?: RequestOptions, target?: LocalKilo) => Promise<RequestResult>;
  request: (
    route: string,
    body?: unknown,
    method?: string
  ) => Promise<{ status: number; value: unknown }>;
  requestOn: (target: LocalKilo, route: string, options?: RequestOptions) => Promise<RequestResult>;
  list: () => Promise<Record<string, unknown>>;
  findWorkspace: (
    matches: (item: Record<string, unknown>) => boolean
  ) => Promise<z.infer<typeof workspaceDetail> | undefined>;
  getWorkspace: (workspaceID: string) => Promise<z.infer<typeof workspaceDetail>>;
  attach: (session: Identity) => Promise<string>;
  attachmentRoute: (session: Identity) => string;
  feed: (route: string, attachment: string) => Promise<FeedStream>;
  messages: (session: Identity) => Promise<TranscriptItem[]>;
  completion: (session: Identity, id: string, expected: string) => Promise<TranscriptItem>;
  status: (session: Identity, attachment: string) => Promise<Record<string, unknown>>;
  waitIdle: (session: Identity, attachment: string, milliseconds?: number) => Promise<void>;
  prompt: (
    session: Identity,
    attachment: string,
    text: string,
    messageID?: string,
    modelId?: string
  ) => Promise<RequestResult>;
  startHosted: (
    prompt: string,
    extra?: Record<string, unknown>
  ) => Promise<{ result: RequestResult; messageID: string; operationKey: string }>;
};

export function createKiloClient(input: {
  server: LocalKilo;
  directory: string;
  config: DriverConfig;
  scrub: (value: string) => string;
  streams: FeedStream[];
  attachments: Set<string>;
}): KiloClient {
  const { server, directory, config, scrub, streams, attachments } = input;

  const raw = async (
    route: string,
    options: RequestOptions = {},
    target: LocalKilo = server
  ): Promise<RequestResult> => {
    const url = new URL(route, target.url);
    if (!url.searchParams.has('workspace') && !url.searchParams.has('directory')) {
      url.searchParams.set('directory', directory);
    }
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const response = await fetch(url, {
      method,
      headers: {
        ...target.headers,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-kilo-directory': directory,
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
      redirect: 'error',
    });
    const text = await response.text();
    let value: unknown;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    return { status: response.status, value, text, headers: response.headers, ok: response.ok };
  };

  const request = async (route: string, body?: unknown, method?: string) => {
    const result = await raw(route, { body, method });
    if (!result.ok) {
      throw new KiloRequestError(
        result.status,
        `${method ?? (body === undefined ? 'GET' : 'POST')} ${new URL(route, 'http://x').pathname}: HTTP ${result.status}: ${scrub(result.text).slice(0, 2000)}`
      );
    }
    return { status: result.status, value: result.value };
  };

  const attachmentRoute = (session: Identity) =>
    `${HOST}/session/${session.providerID}/${session.sessionID}/attach`;

  const list = async () => record((await request(`${HOST}/workspace?limit=50`)).value);

  const findWorkspace = async (matches: (item: Record<string, unknown>) => boolean) => {
    let page = await list();
    const cursors = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const found = z.array(object).parse(page.items).find(matches);
      if (found) return workspaceDetail.parse(found);
      if (typeof page.cursor !== 'string') return undefined;
      assert(!cursors.has(page.cursor), 'Workspace pagination repeated its cursor');
      cursors.add(page.cursor);
      page = record(
        (await request(`${HOST}/workspace?limit=50&cursor=${encodeURIComponent(page.cursor)}`)).value
      );
    }
    throw new Error('Workspace catalog exceeded the integration pagination bound');
  };

  const getWorkspace = async (workspaceID: string) =>
    workspaceDetail.parse((await request(`${HOST}/workspace/${PROVIDER}/${workspaceID}`)).value);

  const attach = async (session: Identity) => {
    const result = z
      .object({ attachmentID: z.string().startsWith('wrk_att_'), session: identity })
      .parse((await request(attachmentRoute(session), {})).value);
    assert.deepEqual(result.session, session);
    attachments.add(result.attachmentID);
    return result.attachmentID;
  };

  const feed = async (route: string, attachment: string) => {
    const result = await openKiloSse(
      `${server.url}${route}?workspace=${encodeURIComponent(attachment)}`,
      server.headers
    );
    streams.push(result);
    await result.wait(
      event => (route === '/event' ? event.type === 'server.connected' : true),
      'feed connection'
    );
    return result;
  };

  const messages = async (session: Identity) =>
    transcriptPage.parse(
      (
        await request(`${HOST}/session/${session.providerID}/${session.sessionID}/message?limit=100`)
      ).value
    ).items;

  const completion = (session: Identity, id: string, expected: string) =>
    eventually('persisted assistant reply', async () => {
      const items = await messages(session).catch(error => {
        if (error instanceof KiloRequestError && error.status === 503) return undefined;
        throw error;
      });
      if (!items) return undefined;
      const replies = items.filter(item => item.info.role === 'assistant' && item.info.parentID === id);
      for (const item of replies) {
        assert.equal(item.info.error, undefined, JSON.stringify(item.info.error));
      }
      const reply = replies.find(item =>
        item.parts
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('')
          .includes(expected)
      );
      if (!reply) return undefined;
      return typeof record(reply.info.time).completed === 'number' ? reply : undefined;
    });

  const status = async (session: Identity, attachment: string) => {
    const result = await raw(`/session/status?workspace=${encodeURIComponent(attachment)}`);
    if (result.status !== 200) return {};
    const entry = record(result.value)[session.sessionID];
    return entry === undefined ? {} : record(entry);
  };

  const waitIdle = (session: Identity, attachment: string, milliseconds = BUDGET) =>
    eventually(
      'idle session',
      async () => {
        const result = await raw(`/session/status?workspace=${encodeURIComponent(attachment)}`);
        if (result.status !== 200) return undefined;
        const entry = record(result.value)[session.sessionID];
        if (entry === undefined) return true;
        return record(entry).type === 'idle' ? true : undefined;
      },
      milliseconds
    ).then(() => undefined);

  const prompt = (
    session: Identity,
    attachment: string,
    text: string,
    messageID = createMessageId(),
    modelId = FAKE_MODEL
  ) =>
    raw(`/session/${session.sessionID}/prompt_async?workspace=${encodeURIComponent(attachment)}`, {
      method: 'POST',
      body: {
        messageID,
        agent: 'code',
        model: { providerID: 'kilo', modelID: modelId },
        parts: [{ type: 'text', text }],
      },
    });

  const startHosted = async (promptText: string, extra: Record<string, unknown> = {}) => {
    const messageID = createMessageId();
    const operationKey = randomUUID();
    const result = await raw(`${HOST}/session`, {
      method: 'POST',
      body: {
        repository: { type: 'git', url: config.gitUrl },
        prompt: promptText,
        agent: { mode: 'code', model: config.model },
        messageID,
        operationKey,
        ...extra,
      },
    });
    return { result, messageID, operationKey };
  };

  return {
    raw,
    request,
    requestOn: (target, route, options) => raw(route, options, target),
    list,
    findWorkspace,
    getWorkspace,
    attach,
    attachmentRoute,
    feed,
    messages,
    completion,
    status,
    waitIdle,
    prompt,
    startHosted,
  };
}

export type { KiloEvent };
