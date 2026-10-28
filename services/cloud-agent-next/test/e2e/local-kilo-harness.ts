import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createProfile, deleteProfile } from '@kilocode/cloud-agent-profile';
import { createDrizzleClient } from '@kilocode/db';
import { z } from 'zod';
import {
  DRIVER_USER_EMAIL_SUFFIX,
  ensureTestUser,
  loadDevVars,
  loadExistingUserByEmail,
  type TestUser,
} from './auth.js';
import { releaseGate, trpcCall, waitForGateEngaged, type DriverConfig } from './client.js';
import { startLocalKilo } from './local-kilo.js';
import {
  createFixtures,
  type HostedFixture,
  type WorkspaceFixture,
  type WorkspaceSessionFixture,
} from './local-kilo-fixtures.js';
import {
  BUDGET,
  FAKE_MODEL,
  HOST,
  createKiloClient,
  discoverStack,
  driverConfig,
  object,
  record,
  signUserToken,
  workspaceDetail,
  type FeedStream,
  type Identity,
  type KiloClient,
  type LocalKilo,
  type RequestOptions,
  type RequestResult,
  type TranscriptItem,
} from './local-kilo-stack.js';

export type { HostedFixture, WorkspaceFixture, WorkspaceSessionFixture };

export type ScenarioResult = {
  name: string;
  status: 'pass' | 'fail';
  optIn: boolean;
  durationMs: number;
  detail?: string;
};

export type Harness = {
  readonly run: string;
  readonly out: string;
  readonly kiloRepo: string;
  readonly web: string;
  readonly config: DriverConfig;
  readonly profile: string;
  readonly host: string;
  readonly model: string;
  readonly database: string;
  readonly nextAuthSecret: string;
  readonly results: ScenarioResult[];
  request(route: string, body?: unknown, method?: string): Promise<{ status: number; value: unknown }>;
  tryRequest(route: string, options?: RequestOptions): Promise<RequestResult>;
  requestOn(kilo: LocalKilo, route: string, options?: RequestOptions): Promise<RequestResult>;
  signToken(user: TestUser): Promise<string>;
  ensureNoBalanceUser(): Promise<TestUser>;
  list(): Promise<Record<string, unknown>>;
  findWorkspace(
    matches: (item: Record<string, unknown>) => boolean
  ): Promise<z.infer<typeof workspaceDetail> | undefined>;
  getWorkspace(workspaceID: string): Promise<z.infer<typeof workspaceDetail>>;
  attach(session: Identity): Promise<string>;
  attachmentRoute(session: Identity): string;
  feed(route: string, attachment: string): Promise<FeedStream>;
  messages(session: Identity): Promise<TranscriptItem[]>;
  completion(session: Identity, id: string, expected: string): Promise<TranscriptItem>;
  status(session: Identity, attachment: string): Promise<Record<string, unknown>>;
  waitIdle(session: Identity, attachment: string, milliseconds?: number): Promise<void>;
  prompt(
    session: Identity,
    attachment: string,
    text: string,
    messageID?: string,
    modelId?: string
  ): Promise<RequestResult>;
  startHosted(
    prompt: string,
    extra?: Record<string, unknown>
  ): Promise<{ result: RequestResult; messageID: string; operationKey: string }>;
  workspace(): Promise<WorkspaceFixture>;
  hosted(): Promise<HostedFixture>;
  workspaceSession(label: string, marker: string): Promise<WorkspaceSessionFixture>;
  releaseGate(tag: string): Promise<void>;
  waitGate(tag: string): Promise<void>;
  startKilo(input: { home: string; token?: string }): Promise<LocalKilo>;
  ownSession(session: Identity): void;
  scrub(value: string): string;
  releaseSandboxes(): Promise<void>;
  close(): Promise<void>;
};

export async function createHarness(args: {
  kiloRepo: string;
  bun?: string;
  email: string;
  out?: string;
}): Promise<Harness> {
  const stack = await discoverStack({ kiloRepo: args.kiloRepo, bun: args.bun });
  const run = `local-kilo-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const out = path.resolve(args.out ?? path.join(stack.root, 'dev/logs', run));
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 });

  const vars = loadDevVars(stack.service);
  const user = await loadExistingUserByEmail(stack.database, args.email);
  const token = await signUserToken(vars.NEXTAUTH_SECRET, user);
  const config = driverConfig({ worker: stack.worker, fake: stack.fake, user, token });
  const db = createDrizzleClient({
    connectionString: stack.database,
    poolConfig: { max: 1 },
    ssl: false,
  });
  const scrub = (value: string) =>
    value
      .replaceAll(token, '[redacted]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');

  const results: ScenarioResult[] = [];
  const streams: FeedStream[] = [];
  const captured: unknown[][] = [];
  const attachments = new Set<string>();
  const ownedWorkspaces = new Set<string>();
  const knownSessions = new Set<string>();
  const extraKilos: LocalKilo[] = [];
  const gateTags = new Set<string>();

  const profile = (await createProfile(db.db, { type: 'user', id: user.id }, user.id, run)).id;
  const server = await startLocalKilo({
    repo: stack.kiloRepo,
    bun: stack.bun,
    home: path.join(out, 'home'),
    token,
    web: stack.web,
    worker: stack.worker,
    gateway: stack.gateway,
  });

  const client: KiloClient = createKiloClient({
    server,
    directory: stack.kiloRepo,
    config,
    scrub,
    streams,
    attachments,
  });
  const fixtures = createFixtures({
    client,
    config,
    profile,
    run,
    scrub,
    attachments,
    ownedWorkspaces,
    knownSessions,
    gateTags,
  });

  const startKilo = async (input: { home: string; token?: string }) => {
    const value = await startLocalKilo({
      repo: stack.kiloRepo,
      bun: stack.bun,
      home: input.home,
      token: input.token,
      web: stack.web,
      worker: stack.worker,
      gateway: stack.gateway,
    });
    extraKilos.push(value);
    return value;
  };

  const release = async (tag: string) => {
    gateTags.delete(tag);
    await releaseGate(stack.fake, tag, AbortSignal.timeout(10_000)).catch(() => undefined);
  };

  const discoverOwnedWorkspaces = async () => {
    try {
      let page = await client.list();
      for (let index = 0; index < 20; index++) {
        for (const item of z.array(object).parse(page.items)) {
          const parsed = workspaceDetail.safeParse(item);
          if (!parsed.success) continue;
          if (parsed.data.profileID === profile) ownedWorkspaces.add(parsed.data.id.workspaceID);
          if (parsed.data.sessions.some(session => knownSessions.has(session.id.sessionID))) {
            ownedWorkspaces.add(parsed.data.id.workspaceID);
          }
        }
        if (typeof page.cursor !== 'string') break;
        page = record(
          (
            await client.request(
              `${HOST}/workspace?limit=50&cursor=${encodeURIComponent(page.cursor)}`
            )
          ).value
        );
      }
    } catch {
      // Catalog discovery is best effort during teardown.
    }
  };

  const listWorkspaceIds = async (): Promise<Set<string>> => {
    const ids = new Set<string>();
    let page = await client.list();
    for (let index = 0; index < 20; index++) {
      for (const item of z.array(object).parse(page.items)) {
        const parsed = workspaceDetail.safeParse(item);
        if (parsed.success) ids.add(parsed.data.id.workspaceID);
      }
      if (typeof page.cursor !== 'string') break;
      page = record(
        (
          await client.request(
            `${HOST}/workspace?limit=50&cursor=${encodeURIComponent(page.cursor)}`
          )
        ).value
      );
    }
    return ids;
  };

  const controlToken = async (): Promise<string> => {
    const response = await fetch(`${stack.web}/api/cloud-agent-next/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    assert(response.ok, `control token request failed: HTTP ${response.status}`);
    return z
      .object({ token: z.string().min(1), expiresAt: z.iso.datetime() })
      .parse(await response.json()).token;
  };

  const deleteOwnedWorkspaces = async (): Promise<boolean> => {
    const ids = [...ownedWorkspaces];
    if (ids.length === 0) return true;
    let allDeleted = true;
    let control: string | undefined;
    for (const workspaceID of ids) {
      try {
        control ??= await controlToken();
        await trpcCall(
          { ...config, bearerToken: control },
          'deleteWorktree',
          { worktreeId: workspaceID },
          { signal: AbortSignal.timeout(90_000) }
        );
        ownedWorkspaces.delete(workspaceID);
      } catch {
        allDeleted = false;
      }
    }
    return allDeleted;
  };

  const waitForWorkspacesGone = async (ids: string[]) => {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const present = await listWorkspaceIds().catch(() => undefined);
      if (present && ids.every(id => !present.has(id))) return;
      await delay(2_000);
    }
  };

  // The local Docker sandbox cannot clone for a second workspace while another
  // sandbox is alive, so each sandbox family is fully released before the next.
  const releaseSandboxes = async () => {
    for (const tag of [...gateTags]) await release(tag);
    for (const stream of streams) {
      captured.push(stream.events);
      await stream.close().catch(() => undefined);
    }
    streams.length = 0;
    for (const attachment of attachments) {
      await client
        .raw(`${HOST}/attachment/${attachment}`, { method: 'DELETE', timeout: 10_000 })
        .catch(() => undefined);
    }
    attachments.clear();
    const ids = [...ownedWorkspaces];
    await deleteOwnedWorkspaces();
    if (ids.length > 0) {
      await waitForWorkspacesGone(ids);
      await delay(5_000);
    }
    fixtures.reset();
  };

  const close = async () => {
    await releaseSandboxes();
    await discoverOwnedWorkspaces();
    const allDeleted = await deleteOwnedWorkspaces();
    if (allDeleted) {
      await deleteProfile(db.db, profile, { type: 'user', id: user.id }).catch(() => undefined);
    }
    for (const kilo of extraKilos) await kilo.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await db.pool.end().catch(() => undefined);
    await writeFile(path.join(out, 'kilo.log'), scrub(server.logs()), { mode: 0o600 });
    await writeFile(path.join(out, 'events.json'), scrub(JSON.stringify(captured, null, 2)), {
      mode: 0o600,
    });
    await writeFile(
      path.join(out, 'report.json'),
      JSON.stringify(
        {
          run,
          worker: stack.worker,
          web: stack.web,
          gateway: stack.gateway,
          fake: stack.fake,
          postgres: stack.postgres,
          kiloRepo: stack.kiloRepo,
          bun: stack.bunVersion,
          profileID: profile,
          workspaces: [...ownedWorkspaces],
          scenarios: results,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  };

  return {
    run,
    out,
    kiloRepo: stack.kiloRepo,
    web: stack.web,
    config,
    profile,
    host: HOST,
    model: FAKE_MODEL,
    database: stack.database,
    nextAuthSecret: vars.NEXTAUTH_SECRET,
    results,
    request: client.request,
    tryRequest: client.raw,
    requestOn: client.requestOn,
    signToken: (target: TestUser) => signUserToken(vars.NEXTAUTH_SECRET, target),
    ensureNoBalanceUser: () =>
      ensureTestUser(stack.database, `e2e-no-balance${DRIVER_USER_EMAIL_SUFFIX}`, { funded: false }),
    list: client.list,
    findWorkspace: client.findWorkspace,
    getWorkspace: client.getWorkspace,
    attach: client.attach,
    attachmentRoute: client.attachmentRoute,
    feed: client.feed,
    messages: client.messages,
    completion: client.completion,
    status: client.status,
    waitIdle: client.waitIdle,
    prompt: client.prompt,
    startHosted: client.startHosted,
    workspace: fixtures.workspace,
    hosted: fixtures.hosted,
    workspaceSession: fixtures.workspaceSession,
    releaseGate: release,
    waitGate: async tag => {
      await waitForGateEngaged(config, tag, BUDGET, 100);
    },
    startKilo,
    ownSession: session => knownSessions.add(session.sessionID),
    scrub,
    releaseSandboxes,
    close,
  };
}
