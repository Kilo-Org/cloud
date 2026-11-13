import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createDrizzleClient } from '@kilocode/db/client';
import { and, eq } from 'drizzle-orm';
import {
  kilocode_users,
  cli_sessions_v2,
  cloud_agent_worktrees,
  cloud_agent_pr_maintenance_attempts,
} from '@kilocode/db/schema';
import { loadDevVars, loadRepoEnvFiles, mintApiToken, type TestUser } from '../auth.js';
import { assertLocalDatabase, REQUIRED_STACK_SERVICES, type LocalStack } from '../fixture-stack.js';
import { redactText, writeRestrictedJson } from '../fixture-contract.js';
import { resolveFakeAdminToken } from '../fake-llm-admin.js';
import {
  type identitySchema,
  stateSchema,
  messageSchema,
  maintenanceStatusSchema,
  LocalApiError,
  type State,
  type Attempt,
} from './contracts.js';
export {
  identitySchema,
  stateSchema,
  messageSchema,
  maintenanceStatusSchema,
  LocalApiError,
  describeMessageFailure,
  type State,
  type Attempt,
} from './contracts.js';

export const MODEL = 'kilo/fake-deterministic';
export const GIT_URL = 'https://github.com/octocat/Hello-World.git';
export const REPO_URL = 'https://github.com/octocat/hello-world';
async function privateFile(file: string) {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), 'Expected a regular private file');
  assert.equal(info.mode & 0o777, 0o600, 'Private files must use mode 600');
  assert.equal(info.uid, process.getuid?.(), 'Private file owner must match this process');
}

export async function readPrivateJson(file: string): Promise<unknown> {
  await privateFile(file);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function discover(): Promise<LocalStack> {
  const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const root = path.resolve(service, '../..');
  const status = z
    .object({
      services: z.array(
        z.object({
          name: z.string(),
          port: z.number().int().positive(),
          status: z.string(),
        })
      ),
    })
    .parse(
      JSON.parse(
        execFileSync(
          'pnpm',
          ['--config.verify-deps-before-run=false', '-s', 'dev:status', '--json'],
          { cwd: root, encoding: 'utf8', timeout: 30_000 }
        )
      )
    );
  const required = [...REQUIRED_STACK_SERVICES, 'cloudflare-session-ingest'];
  for (const name of required)
    assert(
      status.services.some(entry => entry.name === name && entry.status === 'up'),
      `Local service is not ready: ${name}. Parent must start the required stack.`
    );
  function port(name: string) {
    const found = status.services.find(entry => entry.name === name && entry.status === 'up');
    assert(found, `Local service is not ready: ${name}`);
    return found.port;
  }
  const worker = `http://localhost:${port('cloud-agent-next')}`;
  const health = await fetch(`${worker}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert(health.ok, 'Local Worker health check failed');
  loadRepoEnvFiles(service);
  const database = process.env.POSTGRES_URL;
  assert(database, 'This worktree POSTGRES_URL is required');
  assertLocalDatabase(database, port('postgres'));
  return {
    service,
    root,
    worker,
    database,
    postgres: port('postgres'),
    web: `http://localhost:${port('nextjs')}`,
    gateway: `http://localhost:${port('ai-gateway')}`,
    fake: `http://localhost:${port('fake-llm')}`,
    sessionIngest: `http://localhost:${port('cloudflare-session-ingest')}`,
  };
}

export async function openContext(directory: string, phase: string) {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(170_000);
  const stack = await discover();
  assert.notEqual(
    process.env.USE_PRODUCTION_DB,
    'true',
    'Production database selection is forbidden'
  );
  const out = path.resolve(directory);
  const relative = path.relative(path.join(stack.root, 'dev/logs'), out);
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Evidence must be under this worktree dev/logs'
  );
  if (phase === 'prepare') await mkdir(out, { mode: 0o700 });
  const info = await lstat(out);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Evidence must be a regular directory');
  assert.equal(await realpath(out), out, 'Symlinked evidence paths are forbidden');
  assert.equal(info.mode & 0o777, 0o700, 'Evidence directories must use mode 700');
  assert.equal(info.uid, process.getuid?.(), 'Evidence owner must match this process');
  const vars = loadDevVars(stack.service);
  assert(vars.INTERNAL_API_SECRET, 'Worker local INTERNAL_API_SECRET is required');
  const secrets = [
    vars.NEXTAUTH_SECRET,
    vars.INTERNAL_API_SECRET,
    resolveFakeAdminToken(),
    stack.database,
    new URL(stack.database).password,
  ];
  const database = createDrizzleClient({
    connectionString: stack.database,
    ssl: false,
    poolConfig: {
      application_name: 'pr-maintenance-local-acceptance',
      max: 1,
      statement_timeout: 10_000,
    },
  });
  const checks: Array<{ name: string; status: 'passed' | 'blocked' | 'failed'; detail?: string }> =
    [];
  const requests: Array<unknown> = [];
  const evidenceFile = path.join(out, `${phase}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  let bearer = '';
  let state: State | undefined;

  async function evidence() {
    await writeRestrictedJson(evidenceFile, {
      phase,
      elapsedMs: Date.now() - startedAt,
      coverage:
        'local Worker/DO/PostgreSQL with synthetic GitHub observations and deterministic inference; no live GitHub publication',
      checks,
      requests,
    });
  }

  async function request(
    target: 'worker' | 'web' | 'fake',
    route: string,
    input?: unknown,
    authorization: 'internal' | 'user' = 'user'
  ) {
    signal.throwIfAborted();
    assert(route.startsWith('/') && !route.startsWith('//'), 'Expected a local relative API path');
    const url = new URL(
      route,
      target === 'worker' ? stack.worker : target === 'web' ? stack.web : stack.fake
    );
    assert(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
      'Only loopback APIs are allowed'
    );
    const begin = Date.now();
    const receipt = {
      target,
      route,
      status: 0,
      elapsedMs: 0,
      response: 'Acknowledgement pending',
      input: input === undefined ? undefined : redactText(JSON.stringify(input), secrets),
    };
    requests.push(receipt);
    await evidence();
    const response = await fetch(url, {
      method: input === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: {
        'Content-Type': 'application/json',
        ...(authorization === 'internal'
          ? { 'x-internal-api-key': vars.INTERNAL_API_SECRET }
          : {
              Authorization: `Bearer ${target === 'fake' ? resolveFakeAdminToken() : bearer}`,
            }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    const scrubbed = redactText(text, secrets);
    Object.assign(receipt, {
      status: response.status,
      elapsedMs: Date.now() - begin,
      response: scrubbed.slice(0, 20_000),
    });
    await evidence();
    if (!response.ok) {
      let responseError: string | undefined;
      try {
        const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(scrubbed));
        if (parsed.success) responseError = parsed.data.error;
      } catch {
        responseError = undefined;
      }
      throw new LocalApiError(route.split('?')[0], response.status, responseError);
    }
    const value: unknown = text ? JSON.parse(text) : null;
    return value;
  }

  async function trpc<T>(
    procedure: string,
    input: unknown,
    schema: z.ZodType<T>,
    method: 'GET' | 'POST' = 'POST'
  ) {
    const route = `/trpc/${procedure}${method === 'GET' ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const envelope = z
      .object({ result: z.object({ data: z.unknown() }) })
      .parse(await request('worker', route, method === 'GET' ? undefined : input));
    return schema.parse(envelope.result.data);
  }

  async function save(value: State) {
    state = stateSchema.parse(value);
    await writeRestrictedJson(path.join(out, 'state.json'), state);
  }

  async function authenticate(user: TestUser) {
    bearer = mintApiToken(user, vars.NEXTAUTH_SECRET);
    secrets.push(bearer);
    await writeRestrictedJson(path.join(out, 'auth.json'), {
      local: true,
      userId: user.id,
      token: bearer,
    });
  }

  async function load() {
    const file = path.join(out, 'state.json');
    state = stateSchema.parse(await readPrivateJson(file));
    assert(!state.cleaned, 'This fixture has already been cleaned');
    const [user] = await database.db
      .select({
        id: kilocode_users.id,
        email: kilocode_users.google_user_email,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, state.userId));
    assert(
      user && user.email === `${state.tag}@cloud-agent-next-e2e.example.com`,
      'Fixture identity ownership changed'
    );
    const [root] = await database.db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, state.root.kiloSessionId),
          eq(cli_sessions_v2.kilo_user_id, state.userId)
        )
      );
    const [workspace] = await database.db
      .select()
      .from(cloud_agent_worktrees)
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, state.workspaceId),
          eq(cloud_agent_worktrees.kilo_user_id, state.userId)
        )
      );
    assert(
      root &&
        root.cloud_agent_worktree_id === state.workspaceId &&
        root.profile_id === state.profileId,
      'Fixture chat ownership changed'
    );
    assert(workspace && workspace.deletion_started_at === null, 'Fixture workspace is unavailable');
    await authenticate(user);
    return { state, user };
  }

  async function until<T>(
    label: string,
    read: () => Promise<T | undefined>,
    budget = 50_000
  ): Promise<T> {
    const end = Math.min(startedAt + 165_000, Date.now() + budget);
    while (Date.now() < end) {
      signal.throwIfAborted();
      const result = await read();
      if (result !== undefined) return result;
      await delay(250, undefined, { signal });
    }
    throw new Error(`Deadline waiting for ${label}`);
  }

  async function result(identity: z.infer<typeof identitySchema>) {
    const value = await trpc(
      'getMessageResult',
      {
        cloudAgentSessionId: identity.cloudAgentSessionId,
        messageId: identity.messageId,
      },
      messageSchema,
      'GET'
    );
    assert.equal(value.messageId, identity.messageId);
    assert.equal(value.cloudAgentSessionId, identity.cloudAgentSessionId);
    return value;
  }

  return {
    stack,
    out,
    vars,
    secrets,
    db: database.db,
    signal,
    request,
    trpc,
    save,
    load,
    authenticate,
    until,
    result,
    async observe(name: string, value: unknown) {
      requests.push({
        observation: name,
        value: redactText(JSON.stringify(value), secrets).slice(0, 20_000),
      });
      await evidence();
    },
    pass(name: string) {
      checks.push({ name, status: 'passed' });
    },
    blocked(name: string, detail: string) {
      checks.push({ name, status: 'blocked', detail });
    },
    async status(attempt: Attempt) {
      assert(state, 'Fixture state must be loaded');
      const [owned] = await database.db
        .select()
        .from(cloud_agent_pr_maintenance_attempts)
        .where(
          and(
            eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
            eq(cloud_agent_pr_maintenance_attempts.watch_id, state.watchId)
          )
        );
      assert(
        owned &&
          owned.cloud_agent_session_id === attempt.cloudAgentSessionId &&
          owned.session_id === attempt.kiloSessionId &&
          owned.message_id === attempt.messageId,
        'Maintenance runtime identity must match the owned persisted attempt'
      );
      return request(
        'worker',
        '/internal/pr-maintenance/status',
        {
          userId: state.userId,
          cloudAgentSessionId: attempt.cloudAgentSessionId,
          messageId: attempt.messageId,
        },
        'internal'
      ).then(value => maintenanceStatusSchema.parse(value));
    },
    dispatch(watchId: string) {
      return request(
        'web',
        '/api/internal/cloud-agent/pr-maintenance/dispatch',
        { watchId, limit: 1 },
        'internal'
      );
    },
    async finish(error?: unknown) {
      if (error)
        checks.push({
          name: 'phase',
          status: 'failed',
          detail: redactText(
            error instanceof Error ? error.message : 'Unexpected non-Error failure',
            secrets
          ),
        });
      await evidence();
      await database.pool.end();
      return {
        phase,
        assertionsPassed: checks.filter(check => check.status === 'passed').length,
        blocked: checks.filter(check => check.status === 'blocked').map(check => check.name),
        failures: checks.filter(check => check.status === 'failed').map(check => check.detail),
        evidence: evidenceFile,
      };
    },
  };
}

export type Context = Awaited<ReturnType<typeof openContext>>;
