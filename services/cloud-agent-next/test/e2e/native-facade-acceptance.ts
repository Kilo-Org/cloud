import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRIVER_USER_EMAIL_SUFFIX,
  ensureTestUser,
  loadDevVars,
  loadRepoEnvFiles,
  mintApiToken,
} from './auth.js';
import {
  createWorktreeChat,
  DEFAULT_CONFIG,
  deleteSession,
  interruptSession,
  releaseGate,
  trpcCall,
  waitForGateEngaged,
  type DriverConfig,
  type StartSessionResult,
  type WorktreeSessionResult,
} from './client.js';
import {
  findControlPlaneKiloRuntime,
  executeDockerCommand,
  killContainer,
  killSandboxFamily,
  listSandboxContainers,
  waitForSandboxFamilyGone,
  waitForSandboxPrimaryGone,
  type DockerCommandExecutor,
  type SandboxContainer,
} from './sandbox-control.js';
import { createMessageId } from '../../src/session/message-id.js';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoDir = path.resolve(serviceDir, '../..');
const runID = `native-${Date.now()}-${randomUUID().slice(0, 8)}`;
const turnTimeout = Number(process.env.NATIVE_E2E_TURN_TIMEOUT_MS ?? 90_000);
const requestTimeout = 15_000;
const directory = (sessionID: string) => `/cloud-agent/sessions/${sessionID}`;

type RecordValue = Record<string, unknown>;
type HttpResult = { status: number; body: unknown; cursor: string | null };
type Result = { name: string; status: 'pass' | 'fail' | 'blocked'; detail?: unknown };
type NativeEvent = { type: string; properties: RecordValue };
export type MessageEntry = { info: RecordValue; parts: RecordValue[] };
type NativeStream = {
  sessionID: string;
  events: NativeEvent[];
  wait: (
    predicate: (event: NativeEvent) => boolean,
    label: string,
    start?: number
  ) => Promise<NativeEvent>;
  close: () => Promise<void>;
  error: () => string | undefined;
};

export const nativeBurstFixture = {
  prompt: '__fake__:slow:160:10:64',
  text: Array.from({ length: 160 }, (_, index) => {
    const token = ` w${index} `;
    return token.repeat(Math.ceil(64 / token.length)).slice(0, 64);
  }).join(''),
};

class Blocked extends Error {}

/**
 * Checks that prove a criterion this driver owns. `Blocked` is a legitimate
 * outcome for environment-dependent extras, but never for these: if one cannot
 * be observed, the run must report a failure rather than a soft block.
 */
/** `Blocked` is never an acceptable outcome for a criterion this driver owns. */
export function requiredCheckStatus(name: string, blocked: boolean): 'pass' | 'fail' | 'blocked' {
  return blocked && !REQUIRED_CHECKS.has(name) ? 'blocked' : 'fail';
}

/**
 * An aborted turn is settled when no assistant reply for it completed and the
 * session reports idle again. Kilo reverts an aborted turn's user row, so its
 * presence is not required; the caller proves the turn started by observing the
 * fake LLM gate engage before the abort. Native status maps omit idle sessions,
 * so a missing entry requires a matching idle event observed after the abort.
 */
export function interruptedTurnSettled(
  messages: readonly MessageEntry[],
  sessionStatus: RecordValue | undefined,
  messageID: string,
  idleEvidence?: { sessionID: string; events: readonly NativeEvent[] }
): boolean {
  const assistant = messages.find(
    entry => entry.info.role === 'assistant' && entry.info.parentID === messageID
  );
  if (assistant !== undefined && typeof record(assistant.info.time).completed === 'number') {
    return false;
  }
  if (sessionStatus !== undefined) return record(sessionStatus).type === 'idle';
  return (
    idleEvidence?.events.some(
      event =>
        event.properties.sessionID === idleEvidence.sessionID &&
        (event.type === 'session.idle' ||
          (event.type === 'session.status' && record(event.properties.status).type === 'idle'))
    ) ?? false
  );
}

const REQUIRED_CHECKS: ReadonlySet<string> = new Set([
  'setup: funded bearer session bootstrap',
  'same-key start replay creates one session and rejects changed intent',
  'session detail/list projection',
  'warm native status/todo/diff/question/permission reads',
  'abort interrupts one in-flight turn and the session continues',
  'native SSE snapshot precedes fence',
  'prompt_async native live tail after fence',
  'question list and SSE asked event',
  'reconnect snapshot retains pending question through fence',
  'question reply resumes and stale reply fails',
  'question reject clears pending interaction and dismisses tool',
  'human-required skill permission reply and sibling isolation',
  'human-required skill permission rejection prevents shell execution',
  'cold persisted reads/pagination and native no-wake responses',
  'cold native SSE replays durable transcript through fence without waking',
  'public prompt wakes cold owned session',
  'automatic idle shutdown keeps history readable and ordinary input resumes',
]);

export function classifyPermissionReply(
  response: HttpResult,
  pending: unknown,
  permissionID: string
): 'accepted' | 'blocked' {
  assert(Array.isArray(pending), 'expected pending permission array');
  if (response.status === 200) return 'accepted';
  assert.equal(response.status, 409, JSON.stringify(response));
  assert.equal(
    record(response.body).error,
    'KILO_INTERACTION_UNAVAILABLE',
    JSON.stringify(response)
  );
  assert(
    !pending.some(item => record(item).id === permissionID),
    `permission reply rejected while interaction remains pending: ${JSON.stringify({ response, pending })}`
  );
  return 'blocked';
}

export function isLiveRuntimeUnavailable(response: HttpResult): boolean {
  return response.status === 503 && record(response.body).error === 'KILO_LIVE_RUNTIME_UNAVAILABLE';
}

function errorDetail(error: unknown): unknown {
  if (error instanceof AggregateError)
    return { message: error.message, errors: error.errors.map(errorDetail) };
  if (error instanceof Error) return error.message;
  // Cleanup aggregates record structured per-operation failures.
  if (error !== null && typeof error === 'object') return error;
  return String(error);
}

function record(value: unknown): RecordValue {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as RecordValue;
}

function entries(value: unknown): MessageEntry[] {
  assert(Array.isArray(value), 'expected transcript array');
  return value.map(item => {
    const entry = record(item);
    assert(Array.isArray(entry.parts), 'expected message parts');
    return { info: record(entry.info), parts: entry.parts.map(record) };
  });
}

function text(entry: MessageEntry): string {
  return entry.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

function sanitize(value: unknown): unknown {
  const encoded = JSON.stringify(value) ?? 'null';
  return JSON.parse(
    encoded
      .replace(/Bearer\s+[A-Za-z0-9_-]{20,}[A-Za-z0-9_.-]*/g, 'Bearer [redacted]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
  );
}

function projected(value: unknown, key = ''): void {
  if (Array.isArray(value)) {
    for (const entry of value) projected(entry, key);
  } else if (value !== null && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) projected(entry, name);
  } else if (
    typeof value === 'string' &&
    [
      'directory',
      'cwd',
      'root',
      'path',
      'worktree',
      'filePath',
      'filepath',
      'filename',
      'file',
    ].includes(key)
  ) {
    assert(
      !value.startsWith('/workspace/'),
      `public structured ${key} leaked workspace path: ${value}`
    );
    assert(!value.startsWith('/home/'), `public structured ${key} leaked sandbox home: ${value}`);
  }
}

async function poll<T>(label: string, action: () => Promise<T | undefined>, timeout = turnTimeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`${label} timed out after ${timeout}ms`);
}

export function assertColdRuntimeUnchanged(
  containers: SandboxContainer[],
  primary: SandboxContainer,
  proxy: SandboxContainer
): void {
  assert(
    !containers.some(container => container.id === primary.id || container.name === primary.name),
    'cold reads woke the sandbox'
  );
  assert(
    containers.some(container => container.id === proxy.id && container.name === proxy.name),
    'cold fault or reads lost the runtime networking proxy'
  );
}

export async function injectColdPrimaryFault(
  primary: SandboxContainer,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<SandboxContainer> {
  assert(!primary.isProxy, 'cold fault requires an owned primary');
  const containers = await listSandboxContainers(executeDocker);
  assert(
    containers.some(container => container.id === primary.id && container.name === primary.name),
    'owned primary identity changed before cold fault'
  );
  const proxy = containers.find(container => container.name === `${primary.name}-proxy`);
  assert(proxy?.isProxy, 'owned primary networking proxy was not found');
  // workerd caches the warm proxy across primary restarts; killing it breaks subsequent starts.
  await killContainer(primary.id, executeDocker);
  assert(
    await waitForSandboxPrimaryGone(primary, 15_000, executeDocker),
    'cold primary stop was not physically confirmed'
  );
  assertColdRuntimeUnchanged(await listSandboxContainers(executeDocker), primary, proxy);
  return proxy;
}

export function assertColdNativeSnapshot(
  events: NativeEvent[],
  sessionID: string,
  expected: MessageEntry[]
): NativeEvent {
  const fenceIndex = events.findIndex(event => event.type === 'kilo.native.fence');
  assert(fenceIndex >= 0, 'cold SSE omitted snapshot fence');
  const fence = events[fenceIndex];
  assert.equal(fence.properties.snapshotComplete, true);
  assert.equal(fence.properties.sessionID, sessionID);
  assert.equal(fence.properties.directory, directory(sessionID));
  const messages = new Map<string, MessageEntry>();
  const parts = new Map<string, RecordValue>();
  for (const event of events.slice(0, fenceIndex)) {
    if (event.type === 'message.updated') {
      const info = record(event.properties.info);
      assert.equal(info.sessionID, sessionID, 'cold SSE leaked another session');
      messages.set(String(info.id), { info, parts: [] });
    } else if (event.type === 'message.part.updated') {
      const part = record(event.properties.part);
      assert.equal(part.sessionID, sessionID, 'cold SSE leaked another session part');
      parts.set(String(part.id), part);
    } else if (event.type === 'message.removed') {
      messages.delete(String(event.properties.messageID));
    } else if (event.type === 'message.part.removed') {
      parts.delete(String(event.properties.partID));
    }
  }
  for (const part of parts.values()) messages.get(String(part.messageID))?.parts.push(part);
  const comparable = (entries: MessageEntry[]) =>
    entries
      .map(entry => ({
        id: entry.info.id,
        role: entry.info.role,
        parentID: entry.info.parentID,
        completed: record(entry.info.time).completed,
        parts: entry.parts
          .filter(part => record(part.metadata ?? {})['kilocode.lifecycle'] !== 'transient')
          .map(part => ({ id: part.id, type: part.type, text: part.text }))
          .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  assert(expected.length > 0, 'cold transcript baseline was empty');
  assert.deepEqual(comparable([...messages.values()]), comparable(expected));
  return fence;
}

export function assertNativeBurst(
  events: NativeEvent[],
  sessionID: string,
  userMessageID: string,
  persisted: MessageEntry,
  expectedText: string
) {
  assert(expectedText.length > 0 && Buffer.byteLength(expectedText) <= 20 * 1024);
  assert.equal(persisted.info.sessionID, sessionID);
  assert.equal(persisted.info.role, 'assistant');
  assert.equal(persisted.info.parentID, userMessageID);
  assert.equal(persisted.info.error, undefined);
  assert(typeof persisted.info.id === 'string' && persisted.info.id.length > 0);
  const completedAt = record(persisted.info.time).completed;
  assert.equal(typeof completedAt, 'number');
  const textParts = persisted.parts.filter(
    part =>
      part.type === 'text' && record(part.metadata ?? {})['kilocode.lifecycle'] !== 'transient'
  );
  assert.equal(textParts.length, 1, 'burst must persist one stable text part');
  const part = textParts[0];
  assert(typeof part.id === 'string' && part.id.length > 0);
  assert.equal(part.sessionID, sessionID);
  assert.equal(part.messageID, persisted.info.id);
  assert.equal(part.text, expectedText, 'persisted burst text changed');
  let deltaText = '';
  let liveText = '';
  let lastPartText = '';
  let deltaCount = 0;
  let partUpdateCount = 0;
  let liveCompletedAt: unknown;
  const updates: Array<{ type: string; text: string }> = [];
  for (const event of events) {
    assert.notEqual(event.type, 'kilo.native.resnapshot', 'normal burst required a resnapshot');
    assert.notEqual(event.type, 'kilo.native.fence', 'burst unexpectedly restarted its snapshot');
    const properties = record(event.properties);
    if (event.type === 'message.updated') {
      const info = record(properties.info);
      if (info.id !== persisted.info.id && info.parentID !== userMessageID) continue;
      assert.equal(properties.sessionID, sessionID);
      assert.equal(info.id, persisted.info.id, 'burst changed assistant identity');
      assert.equal(info.sessionID, sessionID);
      assert.equal(info.role, 'assistant');
      assert.equal(info.parentID, userMessageID);
      assert.equal(info.error, undefined);
      const completed = record(info.time).completed;
      if (liveCompletedAt !== undefined) assert.equal(completed, liveCompletedAt);
      if (completed !== undefined) liveCompletedAt = completed;
    } else if (event.type === 'message.part.updated') {
      const update = record(properties.part);
      if (update.messageID !== persisted.info.id && update.id !== part.id) continue;
      if (update.type !== 'text' && update.id !== part.id) continue;
      if (record(update.metadata ?? {})['kilocode.lifecycle'] === 'transient') continue;
      assert.equal(properties.sessionID, sessionID);
      assert.equal(update.sessionID, sessionID);
      assert.equal(update.messageID, persisted.info.id);
      assert.equal(update.id, part.id, 'burst changed text part identity');
      assert.equal(update.type, 'text');
      assert.equal(typeof update.text, 'string', 'malformed burst text update');
      assert(typeof update.text === 'string');
      assert(expectedText.startsWith(update.text), 'burst full update corrupted its text');
      assert(update.text.startsWith(lastPartText), 'burst full updates arrived out of order');
      assert(update.text.startsWith(liveText), 'burst full update regressed live assembled text');
      lastPartText = update.text;
      liveText = update.text;
      partUpdateCount += 1;
      updates.push({ type: event.type, text: update.text });
    } else if (event.type === 'message.part.delta') {
      if (properties.messageID !== persisted.info.id && properties.partID !== part.id) continue;
      assert.equal(properties.sessionID, sessionID);
      assert.equal(properties.messageID, persisted.info.id);
      assert.equal(properties.partID, part.id, 'burst delta changed text part identity');
      assert.equal(properties.field, 'text');
      assert(typeof properties.delta === 'string' && properties.delta.length > 0);
      deltaText += properties.delta;
      assert(
        expectedText.startsWith(deltaText),
        'burst delta duplicated, missing, or out of order'
      );
      liveText += properties.delta;
      assert(expectedText.startsWith(liveText), 'burst delta corrupted live assembled text');
      deltaCount += 1;
      updates.push({ type: event.type, text: properties.delta });
    } else if (event.type === 'message.removed') {
      assert.notEqual(properties.messageID, persisted.info.id, 'burst assistant was removed');
    } else if (event.type === 'message.part.removed') {
      assert.notEqual(properties.partID, part.id, 'burst text part was removed');
    }
  }
  assert(deltaCount >= 2, 'burst did not deliver successive native text deltas');
  assert(partUpdateCount > 0, 'burst omitted materialized text updates');
  assert.equal(deltaText, expectedText, 'burst lost deltas despite a materialized full update');
  assert.equal(lastPartText, expectedText, 'burst final text part update was missing');
  assert.equal(liveText, expectedText, 'live assembled burst differs from persisted text');
  assert.equal(
    liveCompletedAt,
    completedAt,
    'burst live completion differs from persisted message'
  );
  return {
    messageID: persisted.info.id,
    partID: part.id,
    text: liveText,
    deltaCount,
    partUpdateCount,
    updates,
  };
}

async function main(): Promise<void> {
  if (process.env.NATIVE_E2E_REPLAY_REPORT) {
    const report = record(JSON.parse(await readFile(process.env.NATIVE_E2E_REPLAY_REPORT, 'utf8')));
    assert(Array.isArray(report.requests));
    assert(Array.isArray(report.streams));
    for (const [name, value] of [
      [
        'public HTTP structured projection',
        report.requests.map(record).map(response => response.body),
      ],
      ['native SSE structured projection', report.streams],
    ] as const) {
      try {
        projected(value);
        console.log(`PASS saved evidence: ${name}`);
      } catch (error) {
        console.log(
          `FAIL saved evidence: ${name}: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
      }
    }
    return;
  }
  loadRepoEnvFiles(serviceDir);
  const vars = loadDevVars(serviceDir);
  const user = await ensureTestUser(
    process.env.DATABASE_URL,
    `kilo-${runID}${DRIVER_USER_EMAIL_SUFFIX}`,
    { funded: true }
  );
  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    fakeLlmUrl: process.env.FAKE_LLM_URL ?? DEFAULT_CONFIG.fakeLlmUrl,
    user,
    nextAuthSecret: vars.NEXTAUTH_SECRET,
    internalApiSecret: vars.INTERNAL_API_SECRET,
    skipBalanceCheck: false,
    model: 'kilo/fake-deterministic',
  };
  const bearer = mintApiToken(user, vars.NEXTAUTH_SECRET);
  const results: Result[] = [];
  const requests: unknown[] = [];
  const streams: NativeStream[] = [];
  const ownedSessions: StartSessionResult[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  const gateTags = new Set<string>();
  const fixtureSnapshots: Array<{ phase: string; sessionID: string; messages: MessageEntry[] }> =
    [];
  const reportPath = path.resolve(
    process.env.NATIVE_E2E_REPORT ?? path.join(repoDir, 'dev/logs', `${runID}.json`)
  );

  async function check(name: string, action: () => Promise<unknown>): Promise<boolean> {
    try {
      const detail = await action();
      results.push({ name, status: 'pass', detail: sanitize(detail) });
      console.log(`PASS ${name}`);
      return true;
    } catch (error) {
      const status = requiredCheckStatus(name, error instanceof Blocked);
      const detail = errorDetail(error);
      results.push({ name, status, detail: sanitize(detail) });
      console.log(
        `${status.toUpperCase()} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(sanitize(detail))}`
      );
      return false;
    }
  }

  async function request(
    route: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      token?: string;
    } = {}
  ): Promise<HttpResult> {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${config.workerUrl}/kilo${route}`, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${options.token ?? bearer}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(requestTimeout),
      });
    } catch (error) {
      requests.push(
        sanitize({
          method: options.method ?? 'GET',
          route,
          ms: Date.now() - started,
          error: errorDetail(error),
        })
      );
      throw error;
    }
    const raw = await response.text();
    let body: unknown = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { invalidJson: raw.slice(0, 2048) };
      }
    }
    const result = { status: response.status, body, cursor: response.headers.get('x-next-cursor') };
    requests.push(
      sanitize({ method: options.method ?? 'GET', route, ms: Date.now() - started, ...result })
    );
    return result;
  }

  function successful(result: HttpResult, status = 200): unknown {
    assert.equal(result.status, status, JSON.stringify(result));
    return result.body;
  }

  const selected = (sessionID: string) => `?directory=${encodeURIComponent(directory(sessionID))}`;
  const transcript = async (sessionID: string) =>
    entries(successful(await request(`/session/${sessionID}/message?limit=100`)));

  async function idle(sessionID: string): Promise<void> {
    await poll(
      `native session ${sessionID} idle with no pending interactions`,
      async () => {
        const statusResponse = await request(`/session/status${selected(sessionID)}`);
        if (isLiveRuntimeUnavailable(statusResponse)) return;
        const status = record(successful(statusResponse));
        const questionResponse = await request(`/question${selected(sessionID)}`);
        if (isLiveRuntimeUnavailable(questionResponse)) return;
        const questions = successful(questionResponse);
        const permissionResponse = await request(`/permission${selected(sessionID)}`);
        if (isLiveRuntimeUnavailable(permissionResponse)) return;
        const permissions = successful(permissionResponse);
        assert(Array.isArray(questions) && Array.isArray(permissions));
        assert(
          Object.keys(status).every(key => key === sessionID),
          'status leaked another session'
        );
        const current = status[sessionID];
        return (current === undefined || record(current).type === 'idle') &&
          questions.length === 0 &&
          permissions.length === 0
          ? true
          : undefined;
      },
      15_000
    );
  }

  async function completed(
    sessionID: string,
    messageID: string,
    expected?: string,
    timeout = turnTimeout
  ) {
    return poll(
      `assistant completion ${messageID}`,
      async () => {
        const result = await request(`/session/${sessionID}/message?limit=100`);
        if (result.status === 503 && record(result.body).error === 'KILO_SESSION_SNAPSHOT_PENDING')
          return;
        const messages = entries(successful(result));
        const correlated = messages.filter(
          entry => entry.info.role === 'assistant' && entry.info.parentID === messageID
        );
        const assistant = correlated.find(
          entry => expected === undefined || text(entry).includes(expected)
        );
        if (!assistant) return;
        assert.equal(assistant.info.error, undefined, JSON.stringify(assistant.info.error));
        if (typeof record(assistant.info.time).completed !== 'number') return;
        return assistant;
      },
      timeout
    );
  }

  async function prompt(sessionID: string, value: string, agent?: string): Promise<string> {
    const messageID = createMessageId();
    successful(
      await request(`/session/${sessionID}/prompt_async`, {
        method: 'POST',
        body: { messageID, parts: [{ type: 'text', text: value }], ...(agent ? { agent } : {}) },
      }),
      204
    );
    return messageID;
  }

  function attach(sessionID: string, global = false): NativeStream {
    const controller = new AbortController();
    const events: NativeEvent[] = [];
    let failure: string | undefined;
    const task = (async () => {
      const response = await fetch(
        `${config.workerUrl}/kilo${global ? '/global/event' : `/event${selected(sessionID)}`}`,
        {
          headers: { Authorization: `Bearer ${bearer}` },
          signal: controller.signal,
        }
      );
      assert.equal(
        response.status,
        200,
        `SSE HTTP ${response.status}: ${await (response.ok ? Promise.resolve('') : response.text())}`
      );
      assert(response.headers.get('content-type')?.includes('text/event-stream'));
      assert(response.body);
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        assert(value instanceof Uint8Array, 'expected SSE byte chunk');
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = frame
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const envelope = record(JSON.parse(data));
          const value = global ? record(envelope.payload) : envelope;
          assert.equal(typeof value.type, 'string');
          events.push({ type: String(value.type), properties: record(value.properties) });
        }
      }
    })().catch(error => {
      if (!controller.signal.aborted)
        failure = error instanceof Error ? error.message : String(error);
    });
    const stream = {
      sessionID,
      events,
      async wait(predicate: (event: NativeEvent) => boolean, label: string, start = 0) {
        return poll(
          label,
          async () => {
            if (failure) throw new Error(failure);
            return events.slice(start).find(predicate);
          },
          30_000
        );
      },
      async close() {
        controller.abort();
        await task;
      },
      error: () => failure,
    };
    streams.push(stream);
    return stream;
  }

  try {
    // The idle leg shortens every control-plane timer (including reconnects), so
    // the long sequence cannot run under the same divisor. Run it alone.
    const idleOnly = process.env.NATIVE_E2E_IDLE_LEG === '1';
    if (!idleOnly) {
      let root: StartSessionResult | undefined;
      const bootstrap = await check('setup: funded bearer session bootstrap', async () => {
        const initialMessageID = createMessageId();
        const prepared = await trpcCall<WorktreeSessionResult>(
          config,
          'prepareSession',
          {
            prompt: '__fake__:echo:native-bootstrap',
            initialMessageId: initialMessageID,
            mode: 'code',
            model: config.model,
            gitUrl: config.gitUrl,
            runtimeAgents: [
              {
                slug: 'native-probe',
                name: 'Native permission probe',
                config: { mode: 'primary', permission: { '*': 'allow', edit: 'ask' } },
              },
            ],
            runtimeSkills: [
              {
                name: 'native-human-permission',
                rawMarkdown:
                  '---\nname: native-human-permission\ndescription: Harmless human permission fixture\n---\n!`printf native-skill-shell-approved`\n',
              },
            ],
            createdOnPlatform: 'cloud-agent-web',
            clientProvenance: 'browser',
            operationKey: randomUUID(),
            autoInitiate: true,
            autoCommit: false,
            shallow: true,
          },
          {
            internalApiSecret: config.internalApiSecret,
            signal: AbortSignal.timeout(requestTimeout),
          }
        );
        root = { ...prepared, messageId: initialMessageID, delivery: 'queued' };
        ownedSessions.push(root);
        assert(root.cloudAgentSessionId.startsWith('workspace_'));
        await poll(
          'bootstrap transcript',
          async () => {
            const read = await request(`/session/${root?.kiloSessionId}/message?limit=100`);
            if (read.status === 503) return;
            const messages = entries(successful(read));
            const assistant = messages.find(
              entry => entry.info.role === 'assistant' && text(entry).includes('native-bootstrap')
            );
            if (!assistant || typeof record(assistant.info.time).completed !== 'number') return;
            assert.equal(assistant.info.error, undefined);
            return assistant;
          },
          150_000
        );
        return { cloudAgentSessionId: root.cloudAgentSessionId, kiloSessionId: root.kiloSessionId };
      });
      if (!bootstrap || !root) throw new Blocked('native scenarios require successful bootstrap');
      const rootID = root.kiloSessionId;
      const rootCloudSessionID = root.cloudAgentSessionId;

      await check(
        'same-key start replay creates one session and rejects changed intent',
        async () => {
          const operationKey = randomUUID();
          const initialMessageID = createMessageId();
          const intent = {
            prompt: `__fake__:echo:native-idempotent-${runID}`,
            initialMessageId: initialMessageID,
            mode: 'code',
            model: config.model,
            gitUrl: config.gitUrl,
            createdOnPlatform: 'cloud-agent-web',
            clientProvenance: 'browser',
            operationKey,
            autoInitiate: true,
            autoCommit: false,
            shallow: true,
          };
          const first = await trpcCall<WorktreeSessionResult>(config, 'prepareSession', intent, {
            internalApiSecret: config.internalApiSecret,
            signal: AbortSignal.timeout(requestTimeout),
          });
          ownedSessions.push({ ...first, messageId: initialMessageID, delivery: 'queued' });

          // The same key and the same intent is a replay, not a second session.
          const replay = await trpcCall<WorktreeSessionResult & { replayed?: boolean }>(
            config,
            'prepareSession',
            intent,
            {
              internalApiSecret: config.internalApiSecret,
              signal: AbortSignal.timeout(requestTimeout),
            }
          );
          assert.equal(replay.cloudAgentSessionId, first.cloudAgentSessionId);
          assert.equal(replay.kiloSessionId, first.kiloSessionId);
          assert.equal(replay.replayed, true, 'the second call must report a ledger replay');

          // A different intent under the same key must be refused, never applied.
          await assert.rejects(
            () =>
              trpcCall<WorktreeSessionResult>(
                config,
                'prepareSession',
                { ...intent, prompt: `__fake__:echo:native-changed-${runID}` },
                {
                  internalApiSecret: config.internalApiSecret,
                  signal: AbortSignal.timeout(requestTimeout),
                }
              ),
            /session_create_intent_conflict/
          );

          // Discovery still exposes exactly one logical session for that key.
          const listed = successful(await request('/session?limit=100'));
          assert(Array.isArray(listed));
          const matches = listed.filter(item => record(item).id === first.kiloSessionId);
          assert.equal(matches.length, 1, 'same-key replay created a duplicate session');
          return {
            cloudAgentSessionId: first.cloudAgentSessionId,
            kiloSessionId: first.kiloSessionId,
            replayed: replay.replayed,
          };
        }
      );

      await check('session detail/list projection', async () => {
        const detail = record(successful(await request(`/session/${rootID}`)));
        assert.equal(detail.id, rootID);
        assert.equal(detail.directory, directory(rootID));
        assert.equal(detail.path, undefined);
        const listed = successful(await request('/session?limit=10'));
        assert(Array.isArray(listed));
        assert(listed.some(item => record(item).id === rootID));
        return detail;
      });
      await check('warm native status/todo/diff/question/permission reads', async () => {
        const values = [];
        for (const route of [
          `/session/status${selected(rootID)}`,
          `/session/${rootID}/todo`,
          `/session/${rootID}/diff`,
          `/question${selected(rootID)}`,
          `/permission${selected(rootID)}`,
        ]) {
          const value = successful(await request(route));
          if (!route.startsWith('/session/status')) assert(Array.isArray(value));
          else
            assert(
              Object.keys(record(value)).every(key => key === rootID),
              'status leaked another session'
            );
          values.push({ route, value });
        }
        return values;
      });
      await check('abort interrupts one in-flight turn and the session continues', async () => {
        const tag = `native-abort-${runID}`;
        gateTags.add(tag);
        const abortStream = attach(rootID);
        let messageID: string;
        try {
          await abortStream.wait(
            event => event.type === 'kilo.native.fence',
            'abort snapshot fence'
          );
          messageID = await prompt(rootID, `__fake__:gate:${tag}`, 'code');
          const engaged = await waitForGateEngaged(config, tag, 60_000);
          assert(engaged, 'the gated turn never reached the fake LLM');
          const abortEventStart = abortStream.events.length;
          const aborted = successful(await request(`/session/${rootID}/abort`, { method: 'POST' }));
          assert.equal(aborted, true);
          // Hold the gate until the interruption is observed. Releasing it first
          // would let the model answer finish and make a failed abort look like a
          // completed turn.

          // The interrupted turn must not complete with an assistant reply, and
          // the session must return to idle so ordinary input can continue it.
          await poll(
            'interrupted turn settles without an assistant reply',
            async () => {
              const messages = await transcript(rootID);
              const status = await request(`/session/status${selected(rootID)}`);
              if (status.status === 503) return;
              const current = record(successful(status))[rootID];
              return interruptedTurnSettled(
                messages,
                current === undefined ? undefined : record(current),
                messageID,
                { sessionID: rootID, events: abortStream.events.slice(abortEventStart) }
              )
                ? true
                : undefined;
            },
            60_000
          );
        } finally {
          await abortStream.close();
          await releaseGate(config.fakeLlmUrl, tag, AbortSignal.timeout(requestTimeout)).catch(
            () => undefined
          );
        }

        const followUp = await prompt(rootID, `__fake__:echo:native-after-abort`, 'code');
        await completed(rootID, followUp, 'native-after-abort', 120_000);
        return { interruptedMessageID: messageID, followUpMessageID: followUp };
      });
      await check('selectors and unsupported blocking prompt fail closed', async () => {
        assert.equal((await request('/session/status')).status, 400);
        assert.equal((await request(`/session/${rootID}/todo?directory=private`)).status, 400);
        assert.equal(
          (await request(`/session/status${selected(rootID)}&workspace=private`)).status,
          400
        );
        assert.equal((await request(`/session/${rootID}/message?limit=-1`)).status, 400);
        const messageID = createMessageId();
        assert.equal(
          (
            await request(`/session/${rootID}/message`, {
              method: 'POST',
              body: { messageID, parts: [{ type: 'text', text: '__fake__:echo:must-not-run' }] },
            })
          ).status,
          501
        );
        assert(!(await transcript(rootID)).some(entry => entry.info.id === messageID));
      });
      await check('other-user root reads/mutations/events are denied', async () => {
        const other = await ensureTestUser(
          process.env.DATABASE_URL,
          `kilo-${runID}-other${DRIVER_USER_EMAIL_SUFFIX}`,
          { funded: true }
        );
        const token = mintApiToken(other, vars.NEXTAUTH_SECRET);
        for (const route of [
          `/session/${rootID}`,
          `/session/${rootID}/todo`,
          `/question${selected(rootID)}`,
          `/event${selected(rootID)}`,
        ]) {
          assert.equal((await request(route, { token })).status, 404);
        }
        assert.equal(
          (
            await request(`/session/${rootID}/command`, {
              token,
              method: 'POST',
              body: { command: 'init' },
            })
          ).status,
          404
        );
      });

      const rootStream = attach(rootID);
      await check('native SSE snapshot precedes fence', async () => {
        const fence = await rootStream.wait(
          event => event.type === 'kilo.native.fence',
          'initial native fence'
        );
        assert.equal(fence.properties.snapshotComplete, true);
        assert.equal(fence.properties.sessionID, rootID);
        assert.equal(fence.properties.directory, directory(rootID));
        const beforeFence = rootStream.events.slice(0, rootStream.events.indexOf(fence));
        assert(
          beforeFence.some(
            event =>
              event.type === 'message.updated' && record(event.properties.info).role === 'user'
          ),
          'fence arrived without bootstrap user snapshot'
        );
        return { fence, count: beforeFence.length };
      });
      await check('native SSE snapshot structured projection', async () => {
        projected(rootStream.events);
      });
      const globalStream = attach(rootID, true);
      await check('global SSE connects', async () => {
        return globalStream.wait(
          event => event.type === 'server.connected',
          'global connected event'
        );
      });
      let liveMessageID: string | undefined;
      await check('prompt_async native live tail after fence', async () => {
        const start = rootStream.events.length;
        const messageID = await prompt(rootID, '__fake__:echo:native-live');
        liveMessageID = messageID;
        const event = await rootStream.wait(
          event =>
            event.type === 'message.updated' &&
            record(event.properties.info).parentID === messageID,
          'live assistant event',
          start
        );
        assert.equal(event.properties.sessionID, rootID);
        await completed(rootID, messageID, 'native-live');
        return { messageID, event };
      });
      await check('global SSE includes hosted native assistant events', async () => {
        if (!liveMessageID) throw new Blocked('requires admitted native prompt');
        return globalStream.wait(
          event =>
            event.type === 'message.updated' &&
            record(event.properties.info).parentID === liveMessageID,
          'global native assistant event'
        );
      });

      await check(
        'native burst preserves scoped/global live text and durable transcript',
        async () => {
          await idle(rootID);
          const scopedStart = rootStream.events.length;
          const globalStart = globalStream.events.length;
          const messageID = await prompt(rootID, nativeBurstFixture.prompt, 'code');
          const assistant = await completed(rootID, messageID, nativeBurstFixture.text);
          for (const [stream, start] of [
            [rootStream, scopedStart],
            [globalStream, globalStart],
          ] as const) {
            await stream.wait(
              event =>
                event.type === 'message.updated' &&
                record(event.properties.info).id === assistant.info.id &&
                typeof record(record(event.properties.info).time).completed === 'number',
              'burst live assistant completion',
              start
            );
            await stream.wait(
              event =>
                event.type === 'message.part.updated' &&
                record(event.properties.part).messageID === assistant.info.id &&
                record(event.properties.part).text === nativeBurstFixture.text,
              'burst final live text part',
              start
            );
          }
          await idle(rootID);
          const messages = await transcript(rootID);
          assert.equal(messages.filter(entry => entry.info.parentID === messageID).length, 1);
          const persisted = messages.find(entry => entry.info.id === assistant.info.id);
          assert(persisted, 'burst disappeared from final transcript');
          const scoped = assertNativeBurst(
            rootStream.events.slice(scopedStart),
            rootID,
            messageID,
            persisted,
            nativeBurstFixture.text
          );
          const global = assertNativeBurst(
            globalStream.events.slice(globalStart),
            rootID,
            messageID,
            persisted,
            nativeBurstFixture.text
          );
          assert.deepEqual(global.updates, scoped.updates, 'scoped/global burst updates diverged');
          const replay = attach(rootID);
          try {
            await replay.wait(event => event.type === 'kilo.native.fence', 'persisted burst fence');
            assertColdNativeSnapshot(replay.events, rootID, messages);
            assert(!replay.events.some(event => event.type === 'kilo.native.resnapshot'));
          } finally {
            await replay.close();
          }
          return {
            messageID,
            assistantID: scoped.messageID,
            partID: scoped.partID,
            bytes: Buffer.byteLength(scoped.text),
            scoped: { deltaCount: scoped.deltaCount, partUpdateCount: scoped.partUpdateCount },
            global: { deltaCount: global.deltaCount, partUpdateCount: global.partUpdateCount },
          };
        }
      );

      let siblingID: string | undefined;
      await check('setup: lazy worktree sibling and native bootstrap', async () => {
        const sibling = await createWorktreeChat(
          config,
          { sourceKiloSessionId: rootID, sourceCloudAgentSessionId: rootCloudSessionID },
          AbortSignal.timeout(requestTimeout)
        );
        ownedSessions.push({ ...sibling, messageId: '', delivery: 'queued' });
        siblingID = sibling.kiloSessionId;
        const messageID = await prompt(siblingID, '__fake__:echo:native-sibling');
        await completed(siblingID, messageID, 'native-sibling');
        return { kiloSessionId: siblingID, cloudAgentSessionId: sibling.cloudAgentSessionId };
      });

      const questionTag = `question-${randomUUID().slice(0, 8)}`;
      let questionID: string | undefined;
      let questionMessageID: string | undefined;
      const questionReady = await check('question list and SSE asked event', async () => {
        questionMessageID = await prompt(
          rootID,
          `__fake__:question:${questionTag}:Continue native E2E?`
        );
        const question = await poll(
          'native question list',
          async () => {
            const response = await request(`/question${selected(rootID)}`);
            if (isLiveRuntimeUnavailable(response)) return;
            const value = successful(response);
            assert(Array.isArray(value));
            return value.length ? record(value[0]) : undefined;
          },
          45_000
        );
        assert.equal(typeof question.id, 'string');
        questionID = String(question.id);
        assert.equal(question.sessionID, rootID);
        await rootStream.wait(
          event => event.type === 'question.asked' && event.properties.id === questionID,
          'question asked event'
        );
        return question;
      });
      await check('sibling cannot read or answer root question', async () => {
        if (!siblingID || !questionReady || !questionID)
          throw new Blocked('requires sibling and pending question');
        const questions = successful(await request(`/question${selected(siblingID)}`));
        assert(Array.isArray(questions));
        assert(!questions.some(item => record(item).id === questionID));
        const rejected = await request(`/question/${questionID}/reply${selected(siblingID)}`, {
          method: 'POST',
          body: { answers: [['Continue']] },
        });
        assert.equal(rejected.status, 409, JSON.stringify(rejected));
        const remaining = successful(await request(`/question${selected(rootID)}`));
        assert(Array.isArray(remaining) && remaining.some(item => record(item).id === questionID));
        return rejected;
      });
      await check('reconnect snapshot retains pending question through fence', async () => {
        if (!questionReady || !questionID) throw new Blocked('requires pending question');
        await rootStream.close();
        const replay = attach(rootID);
        const fence = await replay.wait(
          event => event.type === 'kilo.native.fence',
          'reconnect fence'
        );
        const snapshot = replay.events.slice(0, replay.events.indexOf(fence));
        assert(
          snapshot.some(
            event => event.type === 'question.asked' && event.properties.id === questionID
          ),
          'reconnect omitted pending question'
        );
        assert(
          snapshot.some(
            event =>
              event.type === 'message.updated' &&
              record(event.properties.info).id === questionMessageID
          ),
          'reconnect omitted question user message'
        );
        return { fence, pendingQuestionID: questionID };
      });
      await check('question reply resumes and stale reply fails', async () => {
        if (!questionReady || !questionID || !questionMessageID)
          throw new Blocked('requires pending question');
        successful(
          await request(`/question/${questionID}/reply${selected(rootID)}`, {
            method: 'POST',
            body: { answers: [['Continue']] },
          })
        );
        await completed(rootID, questionMessageID, `done-${questionTag}`);
        const list = successful(await request(`/question${selected(rootID)}`));
        assert(Array.isArray(list) && !list.some(item => record(item).id === questionID));
        const stale = await request(`/question/${questionID}/reply${selected(rootID)}`, {
          method: 'POST',
          body: { answers: [['Continue']] },
        });
        assert.equal(stale.status, 409, JSON.stringify(stale));
        return stale;
      });
      await check('question reject clears pending interaction and dismisses tool', async () => {
        const tag = `reject-${randomUUID().slice(0, 8)}`;
        const messageID = await prompt(rootID, `__fake__:question:${tag}:Reject native E2E?`);
        const question = await poll(
          'rejectable question',
          async () => {
            const response = await request(`/question${selected(rootID)}`);
            if (isLiveRuntimeUnavailable(response)) return;
            const value = successful(response);
            assert(Array.isArray(value));
            return value.length ? record(value[0]) : undefined;
          },
          45_000
        );
        assert.equal(typeof question.id, 'string');
        successful(
          await request(`/question/${String(question.id)}/reject${selected(rootID)}`, {
            method: 'POST',
            body: {},
          })
        );
        await poll(
          'rejected question disappears',
          async () => {
            const value = successful(await request(`/question${selected(rootID)}`));
            assert(Array.isArray(value));
            return value.some(item => record(item).id === question.id) ? undefined : true;
          },
          15_000
        );
        await poll('rejected question tool result', async () => {
          const messages = await transcript(rootID);
          return messages.find(
            entry =>
              entry.info.parentID === messageID &&
              entry.parts.some(
                part =>
                  part.type === 'tool' &&
                  record(part.state).output === 'User dismissed the question.'
              )
          );
        });
        successful(await request(`/session/${rootID}/abort`, { method: 'POST' }));
        await idle(rootID);
        return { questionID: question.id, messageID };
      });

      await check('human-required skill permission reply and sibling isolation', async () => {
        if (!siblingID) throw new Blocked('requires isolated sibling permission fixture');
        const permissionSessionID = siblingID;
        const tag = `permission-${randomUUID().slice(0, 8)}`;
        const messageID = await prompt(
          permissionSessionID,
          `__fake__:skill:${tag}:native-human-permission`,
          'code'
        );
        const permission = await poll(
          'pending native skill shell permission',
          async () => {
            const response = await request(`/permission${selected(permissionSessionID)}`);
            if (isLiveRuntimeUnavailable(response)) return;
            const value = successful(response);
            assert(Array.isArray(value));
            const pending: unknown = value.find(
              item => record(record(item).metadata).skillShell === true
            );
            if (pending) return record(pending);
            const messages = await transcript(permissionSessionID);
            const assistant = messages.find(
              entry =>
                entry.info.parentID === messageID &&
                typeof record(entry.info.time).completed === 'number'
            );
            if (assistant)
              throw new Blocked(
                'trusted runtime skill did not produce a pending skillShell permission'
              );
          },
          45_000
        );
        assert.equal(typeof permission.id, 'string');
        assert.equal(permission.sessionID, permissionSessionID);
        assert.equal(record(permission.metadata).skillShell, true);
        const wrong = await request(
          `/permission/${String(permission.id)}/reply${selected(rootID)}`,
          {
            method: 'POST',
            body: { reply: 'once' },
          }
        );
        assert.equal(wrong.status, 409, JSON.stringify(wrong));
        const reply = await request(
          `/permission/${String(permission.id)}/reply${selected(permissionSessionID)}`,
          {
            method: 'POST',
            body: { reply: 'once' },
          }
        );
        const pending = successful(await request(`/permission${selected(permissionSessionID)}`));
        if (classifyPermissionReply(reply, pending, String(permission.id)) === 'blocked')
          throw new Blocked(
            `automatic-approval race prevents public permission reply coverage: ${JSON.stringify({ permission, reply, pending })}`
          );
        await completed(permissionSessionID, messageID, `skill-complete:${tag}`);
        const messages = await transcript(permissionSessionID);
        assert(
          messages.some(
            entry =>
              entry.info.parentID === messageID &&
              entry.parts.some(
                part =>
                  part.type === 'tool' &&
                  part.tool === 'skill' &&
                  record(part.state).status === 'completed' &&
                  String(record(part.state).output).includes('native-skill-shell-approved')
              )
          ),
          'approved shell substitution did not complete'
        );
        const stale = await request(
          `/permission/${String(permission.id)}/reply${selected(permissionSessionID)}`,
          {
            method: 'POST',
            body: { reply: 'once' },
          }
        );
        assert.equal(stale.status, 409, JSON.stringify(stale));
        return permission;
      });
      await check(
        'human-required skill permission rejection prevents shell execution',
        async () => {
          if (!siblingID) throw new Blocked('requires isolated sibling permission fixture');
          const permissionSessionID = siblingID;
          const tag = `permission-reject-${randomUUID().slice(0, 8)}`;
          const messageID = await prompt(
            permissionSessionID,
            `__fake__:skill:${tag}:native-human-permission`,
            'code'
          );
          const permission = await poll('rejectable skill shell permission', async () => {
            const response = await request(`/permission${selected(permissionSessionID)}`);
            if (isLiveRuntimeUnavailable(response)) return;
            const value = successful(response);
            assert(Array.isArray(value));
            const pending: unknown = value.find(
              item => record(record(item).metadata).skillShell === true
            );
            return pending ? record(pending) : undefined;
          });
          successful(
            await request(
              `/permission/${String(permission.id)}/reply${selected(permissionSessionID)}`,
              {
                method: 'POST',
                body: { reply: 'reject' },
              }
            )
          );
          const messages = await poll('rejected native skill tool', async () => {
            const messages = await transcript(permissionSessionID);
            return messages.some(
              entry =>
                entry.info.parentID === messageID &&
                entry.parts.some(
                  part =>
                    part.type === 'tool' &&
                    part.tool === 'skill' &&
                    record(part.state).status === 'error'
                )
            )
              ? messages
              : undefined;
          });
          assert(
            messages.some(
              entry =>
                entry.info.parentID === messageID &&
                entry.parts.some(
                  part =>
                    part.type === 'tool' &&
                    part.tool === 'skill' &&
                    record(part.state).status === 'error'
                )
            ),
            'rejected skill unexpectedly completed'
          );
          const pending = successful(await request(`/permission${selected(siblingID)}`));
          assert(Array.isArray(pending));
          assert(!pending.some(item => record(item).id === permission.id));
          const stale = await request(
            `/permission/${String(permission.id)}/reply${selected(siblingID)}`,
            {
              method: 'POST',
              body: { reply: 'once' },
            }
          );
          assert.equal(stale.status, 409, JSON.stringify(stale));
          return { permissionID: permission.id, messageID };
        }
      );
      await check(
        'isolated permission fixture is stopped before independent root checks',
        async () => {
          if (!siblingID) throw new Blocked('requires sibling permission fixture');
          successful(await request(`/session/${siblingID}/abort`, { method: 'POST' }));
          await idle(siblingID);
          return { sessionID: siblingID };
        }
      );
      await check('native stale permission reply rejects with 409', async () => {
        const response = await request(`/permission/per_nonexistent/reply${selected(rootID)}`, {
          method: 'POST',
          body: { reply: 'once' },
        });
        assert.equal(response.status, 409, JSON.stringify(response));
        return response;
      });
      await check('native nonempty file diff reflects real write', async () => {
        successful(await request(`/session/${rootID}/abort`, { method: 'POST' }));
        const messageID = await prompt(
          rootID,
          `__fake__:file:write:root-write-${randomUUID().slice(0, 8)}:native-root-write.txt:root-diff-e2e`,
          'code'
        );
        await completed(rootID, messageID, 'file-write:native-root-write.txt');
        await idle(rootID);
        const diff = successful(await request(`/session/${rootID}/diff`));
        assert(Array.isArray(diff));
        assert(
          diff.some(file => record(file).file === 'native-root-write.txt'),
          'diff omitted real file write'
        );
        return { messageID, diff: diff.map(record) };
      });

      await check('native command rejects balance bypass and invalid model', async () => {
        const messageID = createMessageId();
        const bypass = await request(`/session/${rootID}/command`, {
          method: 'POST',
          body: { messageID, command: 'init' },
          headers: { 'x-skip-balance-check': 'true' },
        });
        assert.equal(bypass.status, 400, JSON.stringify(bypass));
        assert.equal(record(bypass.body).error, 'KILO_BALANCE_BYPASS_UNSUPPORTED');
        const invalid = await request(`/session/${rootID}/command`, {
          method: 'POST',
          body: { messageID, command: 'init', model: 'invalid/nonexistent-e2e-model' },
        });
        assert(invalid.status >= 400 && invalid.status < 500, JSON.stringify(invalid));
        assert(!(await transcript(rootID)).some(entry => entry.info.id === messageID));
        return { bypass, invalid };
      });
      await check(
        'native command explicit model, same-ID retry, and durable correlation',
        async () => {
          const tag = `command-${randomUUID().slice(0, 8)}`;
          gateTags.add(tag);
          const messageID = createMessageId();
          const body = {
            messageID,
            command: 'init',
            arguments: `__fake__:gate:${tag}:native-command-done`,
            model: config.model,
            agent: 'code',
          };
          successful(await request(`/session/${rootID}/command`, { method: 'POST', body }), 204);
          assert(
            await waitForGateEngaged(config, tag, 45_000),
            'native command did not engage model gate'
          );
          const retry = await request(`/session/${rootID}/command`, { method: 'POST', body });
          successful(retry, 204);
          await releaseGate(config.fakeLlmUrl, tag);
          gateTags.delete(tag);
          const assistant = await completed(rootID, messageID, 'native-command-done');
          assert.equal(assistant.info.providerID, 'kilo');
          assert.equal(assistant.info.modelID, 'fake-deterministic');
          const messages = await transcript(rootID);
          assert.equal(messages.filter(entry => entry.info.id === messageID).length, 1);
          assert.equal(
            messages.filter(
              entry => entry.info.parentID === messageID && entry.info.role === 'assistant'
            ).length,
            1
          );
          return { messageID, retry, assistant: assistant.info };
        }
      );
      await check('native compact command produces summary', async () => {
        const previous = (await transcript(rootID)).filter(
          entry => entry.info.summary === true
        ).length;
        successful(
          await request(`/session/${rootID}/command`, {
            method: 'POST',
            body: { messageID: createMessageId(), command: 'compact', model: config.model },
          }),
          204
        );
        const summaries = await poll('compact summary', async () => {
          const summary = (await transcript(rootID)).filter(
            entry =>
              entry.info.summary === true && typeof record(entry.info.time).completed === 'number'
          );
          return summary.length > previous ? summary : undefined;
        });
        return summaries.map(entry => entry.info);
      });

      let warmPages: string[] | undefined;
      let warmCursor: string | null = null;
      await check('warm transcript pagination is bounded and nonoverlapping', async () => {
        const first = await request(`/session/${rootID}/message?limit=2`);
        const page1 = entries(successful(first));
        assert.equal(page1.length, 2);
        assert(first.cursor, 'missing next cursor');
        warmCursor = first.cursor;
        const second = await request(
          `/session/${rootID}/message?limit=2&before=${encodeURIComponent(first.cursor)}`
        );
        const page2 = entries(successful(second));
        assert.equal(page2.length, 2);
        warmPages = [...page1, ...page2].map(entry => String(entry.info.id));
        assert.equal(new Set(warmPages).size, 4, 'pagination duplicated messages');
        return { messageIDs: warmPages, cursor: first.cursor };
      });
      let coldReady = false;
      let coldPrimary: SandboxContainer | undefined;
      let coldProxy: SandboxContainer | undefined;
      let coldTranscript: MessageEntry[] | undefined;
      await check('warm durable SSE baseline contains the complete native transcript', async () => {
        await idle(rootID);
        const expected = await transcript(rootID);
        const replay = attach(rootID);
        try {
          await replay.wait(
            event => event.type === 'kilo.native.fence',
            'warm persisted baseline fence'
          );
          return assertColdNativeSnapshot(replay.events, rootID, expected);
        } finally {
          await replay.close();
        }
      });
      await check('cold persisted reads/pagination and native no-wake responses', async () => {
        for (const stream of streams) await stream.close();
        await idle(rootID);
        const warmTranscript = await transcript(rootID);
        const fixtureTranscripts = new Map<string, MessageEntry[]>();
        for (const session of ownedSessions) {
          const messages = await transcript(session.kiloSessionId);
          fixtureTranscripts.set(session.kiloSessionId, messages);
          fixtureSnapshots.push({ phase: 'warm', sessionID: session.kiloSessionId, messages });
        }
        const runtime = await findControlPlaneKiloRuntime(rootID);
        if (!runtime)
          throw new Blocked(
            'owned Kilo runtime discovery returned no match; refusing arbitrary Docker stop'
          );
        ownedFamilies.set(runtime.container.name, runtime.container);
        coldPrimary = runtime.container;
        coldProxy = await injectColdPrimaryFault(runtime.container);
        await poll(
          'cold native status unavailable',
          async () => {
            const status = await request(`/session/status${selected(rootID)}`);
            return status.status === 503 ? status : undefined;
          },
          65_000
        );
        coldReady = true;
        coldTranscript = await transcript(rootID);
        const detail = record(successful(await request(`/session/${rootID}`)));
        assert.equal(detail.directory, directory(rootID));
        const first = await request(`/session/${rootID}/message?limit=2`);
        const page1 = entries(successful(first));
        assert.equal(first.cursor, warmCursor);
        assert(first.cursor);
        const second = await request(
          `/session/${rootID}/message?limit=2&before=${encodeURIComponent(first.cursor)}`
        );
        const page2 = entries(successful(second));
        assert.deepEqual(
          [...page1, ...page2].map(entry => String(entry.info.id)),
          warmPages
        );
        for (const [sessionID, expected] of fixtureTranscripts) {
          const messages = await transcript(sessionID);
          fixtureSnapshots.push({ phase: 'cold', sessionID, messages });
          assert.deepEqual(messages, expected, `cold fixture transcript changed: ${sessionID}`);
        }
        for (const route of [
          `/session/${rootID}/todo`,
          `/session/${rootID}/diff`,
          `/question${selected(rootID)}`,
          `/permission${selected(rootID)}`,
        ]) {
          const response = await request(route);
          assert.equal(response.status, 503, JSON.stringify(response));
          assert.equal(record(response.body).error, 'KILO_LIVE_RUNTIME_UNAVAILABLE');
        }
        coldTranscript = await transcript(rootID);
        assert.deepEqual(
          coldTranscript,
          warmTranscript,
          'cold transcript changed after primary stop'
        );
        assertColdRuntimeUnchanged(await listSandboxContainers(), coldPrimary, coldProxy);
        return { coldCursor: first.cursor, stoppedContainerID: runtime.container.id };
      });
      await check(
        'cold native SSE replays durable transcript through fence without waking',
        async () => {
          if (!coldReady || !coldPrimary || !coldProxy || !coldTranscript)
            throw new Blocked('requires ownership-proven cold state and persisted transcript');
          const replay = attach(rootID);
          try {
            await replay.wait(event => event.type === 'kilo.native.fence', 'cold native fence');
            const fence = assertColdNativeSnapshot(replay.events, rootID, coldTranscript);
            assert.deepEqual(await transcript(rootID), coldTranscript);
            assertColdRuntimeUnchanged(await listSandboxContainers(), coldPrimary, coldProxy);
            return { fence, messageCount: coldTranscript.length, preservedProxyID: coldProxy.id };
          } finally {
            await replay.close();
          }
        }
      );
      await check('public prompt wakes cold owned session', async () => {
        if (!coldReady) throw new Blocked('requires ownership-proven cold state');
        const messageID = await prompt(rootID, '__fake__:echo:native-cold-wake', 'code');
        await completed(rootID, messageID, 'native-cold-wake', 180_000);
        const runtime = await findControlPlaneKiloRuntime(rootID);
        if (runtime) ownedFamilies.set(runtime.container.name, runtime.container);
        for (const session of ownedSessions)
          fixtureSnapshots.push({
            phase: 'restored',
            sessionID: session.kiloSessionId,
            messages: await transcript(session.kiloSessionId),
          });
        const status = await poll(
          'restored native runtime status',
          async () => {
            const response = await request(`/session/status${selected(rootID)}`);
            return isLiveRuntimeUnavailable(response) ? undefined : successful(response);
          },
          15_000
        );
        return { messageID, status };
      });
    }
    if (idleOnly) {
      await check(
        'automatic idle shutdown keeps history readable and ordinary input resumes',
        async () => {
          const idleMessageID = createMessageId();
          const prepared = await trpcCall<WorktreeSessionResult>(
            config,
            'prepareSession',
            {
              prompt: `__fake__:echo:native-idle-${runID}`,
              initialMessageId: idleMessageID,
              mode: 'code',
              model: config.model,
              gitUrl: config.gitUrl,
              // An interactive IDE origin: `sandboxIdlePolicyForOrigins` keeps
              // the interactive window rather than the unattended one.
              createdOnPlatform: 'desktop',
              clientProvenance: 'browser',
              autoInitiate: true,
              autoCommit: false,
              shallow: true,
            },
            {
              internalApiSecret: config.internalApiSecret,
              signal: AbortSignal.timeout(requestTimeout),
            }
          );
          ownedSessions.push({ ...prepared, messageId: idleMessageID, delivery: 'queued' });
          const idleKiloID = prepared.kiloSessionId;
          await completed(idleKiloID, idleMessageID, 'native-idle', 240_000);

          const runtime = await findControlPlaneKiloRuntime(idleKiloID);
          assert(runtime, 'the idle leg could not identify its owned runtime');
          ownedFamilies.set(runtime.container.name, runtime.container);
          const durable = await transcript(idleKiloID);

          // No explicit stop: Cloud's own idle deadline reclaims compute. Only
          // the sandbox primary is Cloud's signal; the dev Docker proxy sidecar
          // outlives it and is not compute for this session.
          const stopped = await waitForSandboxPrimaryGone(runtime.container, 240_000);
          assert(stopped, 'the sandbox was never reclaimed by automatic idle shutdown');

          const detail = record(successful(await request(`/session/${idleKiloID}`)));
          assert.equal(detail.directory, directory(idleKiloID));
          assert.deepEqual(
            await transcript(idleKiloID),
            durable,
            'idle-stopped transcript changed'
          );
          const unavailable = await request(`/session/status${selected(idleKiloID)}`);
          assert.equal(unavailable.status, 503, JSON.stringify(unavailable));
          assert.equal(record(unavailable.body).error, 'KILO_LIVE_RUNTIME_UNAVAILABLE');

          const replay = attach(idleKiloID);
          try {
            await replay.wait(event => event.type === 'kilo.native.fence', 'idle native fence');
            assertColdNativeSnapshot(replay.events, idleKiloID, durable);
          } finally {
            await replay.close();
          }
          // Reading history must not have allocated compute again.
          assert.equal(await waitForSandboxPrimaryGone(runtime.container, 2_000), true);

          // Ordinary input restores compute and continues the same hosted session.
          const wakeID = await prompt(idleKiloID, '__fake__:echo:native-idle-resume', 'code');
          await completed(idleKiloID, wakeID, 'native-idle-resume', 240_000);
          const restored = await findControlPlaneKiloRuntime(idleKiloID);
          assert(restored, 'the resumed session has no live runtime');
          ownedFamilies.set(restored.container.name, restored.container);
          return {
            kiloSessionId: idleKiloID,
            durableMessages: durable.length,
            resumedMessageID: wakeID,
          };
        }
      );
    }
  } catch (error) {
    results.push({
      name: 'dependent native coverage',
      status: error instanceof Blocked ? 'blocked' : 'fail',
      detail: sanitize(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    await check('public HTTP structured projection', async () => {
      for (const evidence of requests) {
        const response = record(evidence);
        try {
          projected(response.body);
        } catch (error) {
          throw new Error(
            `${String(response.route)}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    });
    await check('cleanup: close native streams', async () => {
      for (const stream of streams) await stream.close();
    });
    await check('cleanup: release owned gates and stop/delete owned sessions', async () => {
      const failures: unknown[] = [];
      const attempt = async (operation: string, cleanup: () => Promise<unknown>) => {
        try {
          await cleanup();
        } catch (error) {
          failures.push({ operation, error: errorDetail(error) });
        }
      };
      for (const tag of gateTags)
        await attempt(`release gate ${tag}`, async () => {
          try {
            await releaseGate(config.fakeLlmUrl, tag, AbortSignal.timeout(requestTimeout));
          } catch (error) {
            // A gate the abort already cancelled is gone, not a cleanup failure.
            if (!/404/.test(error instanceof Error ? error.message : String(error))) throw error;
          }
        });
      for (const session of [...ownedSessions].reverse()) {
        await attempt(`discover ${session.kiloSessionId}`, async () => {
          const runtime = await findControlPlaneKiloRuntime(session.kiloSessionId);
          if (runtime) ownedFamilies.set(runtime.container.name, runtime.container);
        });
        await attempt(`interrupt ${session.cloudAgentSessionId}`, () =>
          interruptSession(config, session.cloudAgentSessionId, AbortSignal.timeout(requestTimeout))
        );
        await attempt(`delete ${session.cloudAgentSessionId}`, () =>
          deleteSession(config, session.cloudAgentSessionId, AbortSignal.timeout(requestTimeout))
        );
      }
      for (const sandbox of ownedFamilies.values()) {
        await attempt(`stop family ${sandbox.name} primary ${sandbox.id}`, async () => {
          await killSandboxFamily(sandbox);
          assert(
            await waitForSandboxFamilyGone(sandbox, 15_000),
            'owned sandbox cleanup was not physically confirmed'
          );
        });
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'Native acceptance cleanup failed');
    });
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify(
        sanitize({
          runID,
          workerUrl: config.workerUrl,
          fakeLlmUrl: config.fakeLlmUrl,
          results,
          requests,
          streams: streams.map(stream => ({
            sessionID: stream.sessionID,
            events: stream.events,
            error: stream.error(),
          })),
          ownedSessions,
          fixtureSnapshots,
          gaps: [
            'nonempty todo fixture',
            'status map while sibling is active',
            'permission always branch',
            'org model allowlist and unfunded command rejection',
          ],
        }),
        null,
        2
      )
    );
    console.log(`REPORT ${path.relative(repoDir, reportPath)}`);
    console.log(
      JSON.stringify({
        pass: results.filter(result => result.status === 'pass').length,
        fail: results.filter(result => result.status === 'fail').length,
        blocked: results.filter(result => result.status === 'blocked').length,
      })
    );
    if (results.some(result => result.status !== 'pass')) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(
      'native-facade-acceptance setup failure:',
      sanitize(error instanceof Error ? error.message : String(error))
    );
    process.exitCode = 1;
  });
