import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createProfile, deleteProfile } from '@kilocode/cloud-agent-profile';
import { createDrizzleClient } from '@kilocode/db';
import { signKiloToken } from '@kilocode/worker-utils';
import { z } from 'zod';
import { loadDevVars, loadExistingUserByEmail, loadRepoEnvFiles } from './auth.js';
import { releaseGate, trpcCall, waitForGateEngaged, type DriverConfig } from './client.js';
import { openKiloSse, startLocalKilo, type KiloEvent } from './local-kilo.js';
import { createMessageId } from '../../src/session/message-id.js';

const object = z.record(z.string(), z.unknown());
const identity = z.object({ providerID: z.string(), sessionID: z.string() });
const workspaceIdentity = z.object({ providerID: z.string(), workspaceID: z.string() });
const started = z.object({
  workspace: workspaceIdentity,
  session: identity,
  messageID: z.string(),
  replayed: z.boolean(),
});
const workspace = z.object({
  id: workspaceIdentity,
  sessions: z.array(z.object({ id: identity })),
});
const transcript = z.object({
  items: z.array(z.object({ info: object, parts: z.array(object) })),
});
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(service, '../..');
const run = `local-kilo-${Date.now()}-${randomUUID().slice(0, 8)}`;
const budget = 180_000;

class KiloRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  return object.parse(value);
}

function message(event: KiloEvent): Record<string, unknown> {
  const parsed = object.safeParse(event.properties.info);
  return parsed.success ? parsed.data : {};
}

async function eventually<T>(
  label: string,
  read: () => Promise<T | undefined>,
  milliseconds = budget
): Promise<T> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const args = parseArgs({
    options: {
      'kilo-repo': { type: 'string' },
      bun: { type: 'string', default: 'bun' },
      email: { type: 'string' },
      out: { type: 'string' },
    },
  }).values;
  assert(args['kilo-repo'], '--kilo-repo is required');
  assert(args.email, '--email must name an existing funded local user');
  const kiloRepo = path.resolve(args['kilo-repo']);
  const manifest = z
    .object({ packageManager: z.string() })
    .parse(JSON.parse(await readFile(path.join(kiloRepo, 'package.json'), 'utf8')));
  const bun = args.bun ?? 'bun';
  const version = execFileSync(bun, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  assert.equal(
    `bun@${version}`,
    manifest.packageManager,
    'Use the Kilo repository-pinned Bun version'
  );
  const status = z
    .object({
      services: z.array(z.object({ name: z.string(), port: z.number(), status: z.string() })),
    })
    .parse(
      JSON.parse(
        execFileSync('pnpm', ['-s', 'dev:status', '--json'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
        })
      )
    );
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
  const vars = loadDevVars(service);
  const user = await loadExistingUserByEmail(database, args.email);
  const signed = await signKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret: vars.NEXTAUTH_SECRET,
    // Legacy API credential exchange requires the historical five-year lifetime.
    expiresInSeconds: 1825 * 86400,
    env: 'development',
  });
  const token = signed.token;
  const config: DriverConfig = {
    workerUrl: worker,
    fakeLlmUrl: fake,
    user,
    bearerToken: token,
    skipBalanceCheck: false,
    gitUrl: 'https://github.com/octocat/Hello-World.git',
    model: 'kilo/fake-deterministic',
  };
  const out = path.resolve(args.out ?? path.join(root, 'dev/logs', run));
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 });
  const db = createDrizzleClient({
    connectionString: database,
    poolConfig: { max: 1 },
    ssl: false,
  });
  const checks: { name: string; status: 'pass' | 'fail'; detail?: string }[] = [];
  const streams: Awaited<ReturnType<typeof openKiloSse>>[] = [];
  const attachments: string[] = [];
  let server: Awaited<ReturnType<typeof startLocalKilo>> | undefined;
  let profile: string | undefined;
  let owned: string | undefined;
  let creationOperationKey: string | undefined;
  let reconcileCreation: (() => Promise<void>) | undefined;
  let failure: unknown;
  let current = 'setup';
  const gate = `${run}-initial`;
  const scrub = (value: string) =>
    value
      .replaceAll(token, '[redacted]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
  const pass = (name: string) => {
    checks.push({ name, status: 'pass' });
    console.log(`PASS ${name}`);
  };
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      failure ??= error;
      checks.push({ name, status: 'fail', detail: scrub(String(error)) });
    }
  };
  try {
    profile = (await createProfile(db.db, { type: 'user', id: user.id }, user.id, run)).id;
    const local = await startLocalKilo({
      repo: kiloRepo,
      bun,
      home: path.join(out, 'home'),
      token,
      web,
      worker,
      gateway,
    });
    server = local;
    const request = async (
      route: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST'
    ) => {
      const url = new URL(route, local.url);
      if (!url.searchParams.has('workspace')) url.searchParams.set('directory', kiloRepo);
      const response = await fetch(url, {
        method,
        headers: {
          ...local.headers,
          'content-type': 'application/json',
          'x-kilo-directory': kiloRepo,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      const text = await response.text();
      if (!response.ok)
        throw new KiloRequestError(
          response.status,
          `${method} ${url.pathname}: HTTP ${response.status}: ${scrub(text).slice(0, 2000)}`
        );
      const value: unknown = text ? JSON.parse(text) : undefined;
      return { status: response.status, value };
    };
    const host = '/kilocode/session-host';
    const list = async () => record((await request(`${host}/workspace?limit=50`)).value);
    const findWorkspace = async (matches: (item: Record<string, unknown>) => boolean) => {
      let page = await list();
      const cursors = new Set<string>();
      for (let index = 0; index < 20; index++) {
        const found = z.array(object).parse(page.items).find(matches);
        if (found) return workspace.parse(found);
        if (typeof page.cursor !== 'string') return undefined;
        assert(!cursors.has(page.cursor), 'Workspace pagination repeated its cursor');
        cursors.add(page.cursor);
        page = record(
          (await request(`${host}/workspace?limit=50&cursor=${encodeURIComponent(page.cursor)}`))
            .value
        );
      }
      throw new Error('Workspace catalog exceeded the integration pagination bound');
    };
    const attach = async (session: z.infer<typeof identity>) => {
      const result = z
        .object({ attachmentID: z.string().startsWith('wrk_att_'), session: identity })
        .parse(
          (await request(`${host}/session/${session.providerID}/${session.sessionID}/attach`, {}))
            .value
        );
      assert.deepEqual(result.session, session);
      attachments.push(result.attachmentID);
      return result.attachmentID;
    };
    const feed = async (route: string, attachment: string) => {
      const result = await openKiloSse(
        `${local.url}${route}?workspace=${encodeURIComponent(attachment)}`,
        local.headers
      );
      streams.push(result);
      await result.wait(
        event => (route === '/event' ? event.type === 'server.connected' : true),
        'feed connection'
      );
      return result;
    };
    const validateSystem = (stream: Awaited<ReturnType<typeof openKiloSse>>, sessionID: string) => {
      for (const event of stream.events) {
        assert(['preparing', 'cloud.status', 'cloud.sandbox.status'].includes(event.type));
        assert.equal(event.properties.sessionID, sessionID);
        assert.equal(event.properties.directory, `/cloud-agent/sessions/${sessionID}`);
        assert.equal('cloudAgentSessionId' in event.properties, false);
      }
    };
    const messages = async (session: z.infer<typeof identity>) =>
      transcript.parse(
        (
          await request(
            `${host}/session/${session.providerID}/${session.sessionID}/message?limit=100`
          )
        ).value
      ).items;
    const completion = (session: z.infer<typeof identity>, id: string, expected: string) =>
      eventually('persisted assistant reply', async () => {
        const items = await messages(session).catch(error => {
          if (error instanceof KiloRequestError && error.status === 503) return undefined;
          throw error;
        });
        if (!items) return undefined;
        const replies = items.filter(
          item => item.info.role === 'assistant' && item.info.parentID === id
        );
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

    current = 'list cloud workspaces';
    assert(Array.isArray((await list()).items));
    pass(current);
    current = 'create cloud workspace and discover its root';
    const firstID = createMessageId();
    const marker = `${run}-root`;
    creationOperationKey = randomUUID();
    const creation = {
      repository: { type: 'git', url: config.gitUrl },
      profile: { id: profile },
      prompt: `__fake__:gate:${gate}:${marker}`,
      agent: { mode: 'code', model: config.model },
      messageID: firstID,
      operationKey: creationOperationKey,
    };
    reconcileCreation = async () => {
      const found = await findWorkspace(item => item.profileID === profile);
      if (found) {
        owned = found.id.workspaceID;
        return;
      }
      const replay = started.parse((await request(`${host}/workspace`, creation)).value);
      assert.equal(replay.messageID, firstID);
      owned = replay.workspace.workspaceID;
    };
    const created = started.parse((await request(`${host}/workspace`, creation)).value);
    owned = created.workspace.workspaceID;
    assert.equal(created.messageID, firstID);
    assert.equal(created.replayed, false);
    const replay = started.parse((await request(`${host}/workspace`, creation)).value);
    assert.deepEqual(replay.workspace, created.workspace);
    assert.deepEqual(replay.session, created.session);
    assert.equal(replay.replayed, true);
    const found = await findWorkspace(
      item => workspaceIdentity.parse(item.id).workspaceID === owned
    );
    assert(found && found.sessions.some(item => item.id.sessionID === created.session.sessionID));
    const detail = workspace.parse(
      (await request(`${host}/workspace/${created.workspace.providerID}/${owned}`)).value
    );
    assert.deepEqual(detail.id, created.workspace);
    pass(current);

    current = 'system feed replays preparation and reports an active sandbox';
    const rootAttachment = await attach(created.session);
    const system = await feed('/cloud-agent/event', rootAttachment);
    await system.wait(
      event =>
        event.type === 'preparing' && typeof record(event.properties.preparation).step === 'string',
      'environment preparation steps'
    );
    const preparing = new AbortController();
    const failed = system
      .wait(
        event =>
          (event.type === 'cloud.status' &&
            record(event.properties.cloudStatus).type === 'error') ||
          (event.type === 'preparing' &&
            record(event.properties.preparation).action === 'attempt_failed'),
        'preparation failure',
        0,
        budget
      )
      .then(event => {
        const detail =
          event.type === 'preparing' ? record(event.properties.preparation).safeError : undefined;
        throw new Error(
          `Cloud preparation failed${typeof detail === 'string' ? `: ${detail}` : ''}`
        );
      });
    try {
      assert(
        await Promise.race([
          waitForGateEngaged(
            config,
            gate,
            budget,
            100,
            AbortSignal.any([preparing.signal, AbortSignal.timeout(budget)])
          ),
          failed,
        ]),
        'Initial turn did not reach the deterministic model'
      );
    } finally {
      preparing.abort();
    }
    await system.wait(
      event =>
        event.type === 'cloud.sandbox.status' &&
        record(event.properties.sandbox).status === 'active',
      'active sandbox'
    );
    await system.wait(
      event =>
        event.type === 'cloud.status' && record(event.properties.cloudStatus).type === 'ready',
      'ready cloud lifecycle'
    );
    validateSystem(system, created.session.sessionID);
    pass(current);

    current = 'native session feed joins snapshot and live assistant events';
    const native = await feed('/event', await attach(created.session));
    await native.wait(event => event.type === 'kilo.native.fence', 'native snapshot fence');
    const boundary = native.events.findIndex(event => event.type === 'kilo.native.fence');
    assert(
      native.events.slice(0, boundary).some(event => event.type === 'session.updated'),
      'Native snapshot did not precede its fence'
    );
    const fence = native.events.length;
    await releaseGate(config.fakeLlmUrl, gate, AbortSignal.timeout(10_000));
    await completion(created.session, firstID, marker);
    await native.wait(
      event => event.type === 'message.updated' && message(event).parentID === firstID,
      'live initial assistant event',
      fence
    );
    pass(current);

    current = 'start another session in the existing workspace';
    const secondID = createMessageId();
    const secondMarker = `${run}-sibling`;
    const second = started.parse(
      (
        await request(`${host}/workspace/${created.workspace.providerID}/${owned}/session`, {
          prompt: `__fake__:echo:${secondMarker}`,
          agent: { mode: 'code', model: config.model },
          messageID: secondID,
          operationKey: randomUUID(),
        })
      ).value
    );
    assert.deepEqual(second.workspace, created.workspace);
    assert.notEqual(second.session.sessionID, created.session.sessionID);
    await completion(second.session, secondID, secondMarker);
    pass(current);

    current = 'follow-ups retain session identity and appear live and in durable history';
    const siblingAttachment = await attach(second.session);
    const siblingNative = await feed('/event', siblingAttachment);
    await siblingNative.wait(event => event.type === 'kilo.native.fence', 'sibling native fence');
    const siblingSystem = await feed('/cloud-agent/event', siblingAttachment);
    const turns = [secondID];
    for (let index = 1; index <= 2; index++) {
      const id = createMessageId();
      turns.push(id);
      const expected = `${run}-followup-${index}`;
      const start = siblingNative.events.length;
      const admitted = await request(
        `/session/${second.session.sessionID}/prompt_async?workspace=${siblingAttachment}`,
        {
          messageID: id,
          agent: 'code',
          model: { providerID: 'kilo', modelID: config.model },
          parts: [{ type: 'text', text: `__fake__:echo:${expected}` }],
        }
      );
      assert.equal(admitted.status, 204);
      await completion(second.session, id, expected);
      await siblingNative.wait(
        event => event.type === 'message.updated' && message(event).parentID === id,
        'live follow-up assistant event',
        start
      );
    }
    await siblingSystem.wait(
      event =>
        event.type === 'cloud.sandbox.status' &&
        record(event.properties.sandbox).status === 'active',
      'sibling sandbox snapshot'
    );
    validateSystem(system, created.session.sessionID);
    validateSystem(siblingSystem, second.session.sessionID);
    const history = await messages(second.session);
    for (const id of turns) {
      assert.equal(
        history.filter(item => item.info.role === 'user' && item.info.id === id).length,
        1,
        'Accepted prompt missing or duplicated'
      );
      assert.equal(
        history.filter(item => item.info.role === 'assistant' && item.info.parentID === id).length,
        1,
        'Assistant reply missing or duplicated'
      );
    }
    for (const stream of streams) assert.equal(stream.error(), undefined);
    pass(current);
  } catch (error) {
    failure = error;
    checks.push({
      name: current,
      status: 'fail',
      detail: scrub(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    await releaseGate(config.fakeLlmUrl, gate, AbortSignal.timeout(10_000)).catch(() => undefined);
    for (const stream of streams) await cleanup('SSE cleanup', () => stream.close());
    if (!owned && reconcileCreation)
      await cleanup('workspace creation reconciliation', reconcileCreation);
    if (server) {
      const local = server;
      for (const attachment of attachments) {
        await cleanup('attachment cleanup', async () => {
          const response = await fetch(
            `${local.url}/kilocode/session-host/attachment/${attachment}?directory=${encodeURIComponent(kiloRepo)}`,
            {
              method: 'DELETE',
              headers: local.headers,
              signal: AbortSignal.timeout(10_000),
            }
          );
          assert(
            response.ok || response.status === 404 || response.status === 410,
            `Attachment cleanup returned HTTP ${response.status}`
          );
        });
      }
    }
    let workspaceDeleted = false;
    if (owned) {
      await cleanup('owned workspace cleanup', async () => {
        const response = await fetch(`${web}/api/cloud-agent-next/token`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
        assert(response.ok, `Cleanup token exchange returned HTTP ${response.status}`);
        const control = z
          .object({ token: z.string().min(1), expiresAt: z.iso.datetime() })
          .parse(await response.json());
        assert(Date.parse(control.expiresAt) > Date.now(), 'Cleanup control token already expired');
        await trpcCall(
          { ...config, bearerToken: control.token },
          'deleteWorktree',
          { worktreeId: owned },
          { signal: AbortSignal.timeout(90_000) }
        );
        workspaceDeleted = true;
      });
    }
    if (profile && (!creationOperationKey || workspaceDeleted)) {
      const id = profile;
      await cleanup('profile cleanup', () =>
        deleteProfile(db.db, id, { type: 'user', id: user.id })
      );
    }
    await cleanup('database connection cleanup', () => db.pool.end());
    await cleanup('local Kilo shutdown', async () => server?.close());
    await writeFile(path.join(out, 'kilo.log'), scrub(server?.logs() ?? ''), { mode: 0o600 });
    await writeFile(
      path.join(out, 'events.json'),
      scrub(
        JSON.stringify(
          streams.map(stream => stream.events),
          null,
          2
        )
      ),
      { mode: 0o600 }
    );
    await writeFile(
      path.join(out, 'report.json'),
      JSON.stringify(
        {
          run,
          worker,
          web,
          kiloRepo,
          bun: version,
          workspaceID: owned,
          profileID: profile,
          creationOperationKey,
          workspaceDeleted,
          checks,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    console.log(`Evidence: ${out}`);
  }
  if (failure) {
    console.error(
      scrub(
        failure instanceof Error ? failure.message : 'Integration failed with a non-Error value'
      )
    );
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
