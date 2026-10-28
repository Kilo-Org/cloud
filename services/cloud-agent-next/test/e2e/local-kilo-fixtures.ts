import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DriverConfig } from './client.js';
import { waitForGateEngaged } from './client.js';
import {
  BUDGET,
  HOST,
  PROVIDER,
  newMessageId,
  object,
  record,
  sessionStarted,
  started,
  workspaceIdentity,
  workspaceSessionStarted,
  type workspaceDetail,
  type FeedStream,
  type Identity,
  type KiloClient,
  type RequestResult,
  type WorkspaceIdentity,
} from './local-kilo-stack.js';

export type WorkspaceFixture = {
  workspace: WorkspaceIdentity;
  session: Identity;
  messageID: string;
  operationKey: string;
  gate: string;
  marker: string;
  attachment: string;
  system: FeedStream;
  listItems: unknown[];
  createdRaw: RequestResult;
  replayRaw: RequestResult;
  created: z.infer<typeof started>;
  replay: z.infer<typeof started>;
  listed: z.infer<typeof workspaceDetail> | undefined;
  detail: z.infer<typeof workspaceDetail>;
};

export type WorkspaceSessionFixture = {
  session: Identity;
  messageID: string;
  attachment: string;
  native: FeedStream;
};

export type HostedFixture = {
  session: Identity;
  messageID: string;
  operationKey: string;
  prompt: string;
  attachment: string;
  system: FeedStream;
  native: FeedStream;
  start: RequestResult;
  immediateAttach: RequestResult;
  listedAtStart: RequestResult;
};

export type FixtureState = {
  client: KiloClient;
  config: DriverConfig;
  profile: string;
  run: string;
  scrub: (value: string) => string;
  attachments: Set<string>;
  ownedWorkspaces: Set<string>;
  knownSessions: Set<string>;
  gateTags: Set<string>;
};

export function createFixtures(state: FixtureState): {
  workspace: () => Promise<WorkspaceFixture>;
  hosted: () => Promise<HostedFixture>;
  workspaceSession: (label: string, marker: string) => Promise<WorkspaceSessionFixture>;
  reset: () => void;
} {
  const { client, config, profile, run, scrub, attachments, ownedWorkspaces, knownSessions, gateTags } =
    state;
  let workspaceFixture: WorkspaceFixture | undefined;
  let hostedFixture: HostedFixture | undefined;
  const workspaceSessions = new Map<string, WorkspaceSessionFixture>();

  const workspace = async (): Promise<WorkspaceFixture> => {
    if (workspaceFixture) return workspaceFixture;
    const gate = `${run}-initial`;
    gateTags.add(gate);
    const marker = `${run}-root`;
    const messageID = newMessageId();
    const operationKey = randomUUID();
    const creation = {
      repository: { type: 'git', url: config.gitUrl },
      profile: { id: profile },
      prompt: `__fake__:gate:${gate}:${marker}`,
      agent: { mode: 'code', model: config.model },
      messageID,
      operationKey,
    };
    const listItems = z.array(object).parse((await client.list()).items);
    const createdRaw = await client.raw(`${HOST}/workspace`, { method: 'POST', body: creation });
    assert(
      createdRaw.ok,
      `workspace create failed: HTTP ${createdRaw.status} ${createdRaw.text.slice(0, 300)}`
    );
    const created = started.parse(createdRaw.value);
    const replayRaw = await client.raw(`${HOST}/workspace`, { method: 'POST', body: creation });
    assert(
      replayRaw.ok,
      `workspace replay failed: HTTP ${replayRaw.status} ${replayRaw.text.slice(0, 300)}`
    );
    const replay = started.parse(replayRaw.value);
    ownedWorkspaces.add(created.workspace.workspaceID);
    knownSessions.add(created.session.sessionID);
    const listed = await client.findWorkspace(
      item =>
        workspaceIdentity.safeParse(item.id).success &&
        workspaceIdentity.parse(item.id).workspaceID === created.workspace.workspaceID
    );
    const detail = await client.getWorkspace(created.workspace.workspaceID);
    const attachment = await client.attach(created.session);
    const system = await client.feed('/cloud-agent/event', attachment);
    await system.wait(
      event =>
        event.type === 'preparing' && typeof record(event.properties.preparation).step === 'string',
      'environment preparation steps'
    );
    const preparing = new AbortController();
    const failed = system
      .wait(
        event =>
          (event.type === 'cloud.status' && record(event.properties.cloudStatus).type === 'error') ||
          (event.type === 'preparing' &&
            record(event.properties.preparation).action === 'attempt_failed'),
        'preparation failure',
        0,
        BUDGET
      )
      .then(event => {
        const safeDetail =
          event.type === 'preparing' ? record(event.properties.preparation).safeError : undefined;
        throw new Error(
          `Cloud preparation failed${typeof safeDetail === 'string' ? `: ${safeDetail}` : ''}`
        );
      });
    try {
      assert(
        await Promise.race([
          waitForGateEngaged(
            config,
            gate,
            BUDGET,
            100,
            AbortSignal.any([preparing.signal, AbortSignal.timeout(BUDGET)])
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
        event.type === 'cloud.sandbox.status' && record(event.properties.sandbox).status === 'active',
      'active sandbox'
    );
    await system.wait(
      event => event.type === 'cloud.status' && record(event.properties.cloudStatus).type === 'ready',
      'ready cloud lifecycle'
    );
    workspaceFixture = {
      workspace: created.workspace,
      session: created.session,
      messageID,
      operationKey,
      gate,
      marker,
      attachment,
      system,
      listItems,
      createdRaw,
      replayRaw,
      created,
      replay,
      listed,
      detail,
    };
    return workspaceFixture;
  };

  const workspaceSession = async (label: string, marker: string) => {
    const cached = workspaceSessions.get(label);
    if (cached) return cached;
    const fixture = await workspace();
    const messageID = newMessageId();
    const result = await client.raw(
      `${HOST}/workspace/${PROVIDER}/${fixture.workspace.workspaceID}/session`,
      {
        method: 'POST',
        body: {
          prompt: `__fake__:echo:${marker}`,
          agent: { mode: 'code', model: config.model },
          messageID,
          operationKey: randomUUID(),
        },
      }
    );
    assert(result.ok, `workspace session start failed: ${scrub(result.text)}`);
    const parsed = workspaceSessionStarted.parse(result.value);
    knownSessions.add(parsed.session.sessionID);
    const attachment = await client.attach(parsed.session);
    const native = await client.feed('/event', attachment);
    await native.wait(event => event.type === 'kilo.native.fence', `${label} native fence`);
    await client.completion(parsed.session, messageID, marker);
    await client.waitIdle(parsed.session, attachment);
    const entry = { session: parsed.session, messageID, attachment, native };
    workspaceSessions.set(label, entry);
    return entry;
  };

  const hosted = async (): Promise<HostedFixture> => {
    if (hostedFixture) return hostedFixture;
    const promptText = `__fake__:echo:${run}-hosted`;
    const messageID = newMessageId();
    const operationKey = randomUUID();
    const start = await client.raw(`${HOST}/session`, {
      method: 'POST',
      body: {
        repository: { type: 'git', url: config.gitUrl },
        prompt: promptText,
        agent: { mode: 'code', model: config.model },
        messageID,
        operationKey,
      },
    });
    assert(start.ok, `hosted start failed: HTTP ${start.status} ${start.text.slice(0, 300)}`);
    const session = sessionStarted.parse(start.value).session;
    knownSessions.add(session.sessionID);
    const immediateAttach = await client.raw(client.attachmentRoute(session), {
      method: 'POST',
      body: {},
    });
    const listedAtStart = await client.raw(`${HOST}/session?limit=50`);
    let attachment = '';
    if (immediateAttach.ok) {
      const candidate = record(immediateAttach.value).attachmentID;
      if (typeof candidate === 'string') {
        attachment = candidate;
        attachments.add(attachment);
      }
    }
    if (!attachment) attachment = await client.attach(session);
    const system = await client.feed('/cloud-agent/event', attachment);
    const native = await client.feed('/event', attachment);
    await native.wait(event => event.type === 'kilo.native.fence', 'hosted native fence');
    await client.completion(session, messageID, `${run}-hosted`);
    await client.waitIdle(session, attachment);
    hostedFixture = {
      session,
      messageID,
      operationKey,
      prompt: promptText,
      attachment,
      system,
      native,
      start,
      immediateAttach,
      listedAtStart,
    };
    return hostedFixture;
  };

  const reset = () => {
    workspaceFixture = undefined;
    hostedFixture = undefined;
    workspaceSessions.clear();
  };

  return { workspace, hosted, workspaceSession, reset };
}
