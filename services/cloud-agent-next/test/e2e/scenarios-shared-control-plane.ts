/**
 * New-plane (`workspace_*`) scenarios — plan B11.
 *
 * Every scenario declares `controlPlaneV2` (operator opt-in) AND
 * `controlPlaneRuntime` (a local-Docker proof that the owned container runs the
 * new-plane wrapper). The opt-in alone is not proof: the legacy plane also
 * issues `workspace_*` ids, so each scenario proves the runtime before it
 * asserts anything and cannot false-pass on the old plane.
 *
 * - `control-plane-callbacks`: registers the callback target through the internal
 *   `updateSession` endpoint (the public grouped `start` rejects callback
 *   targets), then requires one warm turn to produce a terminal callback and the
 *   persisted `cloud_agent_session_runs` report row.
 * - `command`: runs a `/compact` command turn and requires the live Kilo history
 *   summary count to increase — a real summarization, not just a completed turn.
 * - `attachment`: seeds an attachment and requires its content to reach the
 *   model request; the `attachments` seeding capability has no implementation
 *   yet, so this scenario is `unsupported` until one exists.
 * - `contained-credentials`: with containment advertised from the Worker
 *   `.dev.vars`, requires clone, model, and checkout read to complete and proves
 *   no raw SCM credential is in the container environment or git remote.
 */

import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  failureReasonFromEvent,
  fakeDirective,
  fetchFakeLastPrompt,
  isMessageCompleted,
  openConnectedStream,
  sendCommand,
  sendMessage,
  updateSessionCallbackTarget,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { mintPreviewTicket } from './auth.js';
import { cleanupRemoteSession, type SharedScenario } from './scenarios-shared.js';
import { isReservedPreviewPort } from '../../src/shared/reserved-ports.js';
import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN, previewLabel } from '../../src/preview/host.js';
import { PREVIEW_SESSION_MISSING_TEXT } from '../../src/preview/container-port-fetch.js';
import {
  PREVIEW_BIG_RESPONSE_BYTES,
  PREVIEW_FIXTURE_PORT_CANDIDATES,
  buildPreviewBigResponseBody,
  previewBigResponseSha256,
} from './preview-fixture.js';
import {
  connectWebSocket,
  WS_OPCODE_BINARY,
  WS_OPCODE_CLOSE,
  WS_OPCODE_TEXT,
} from './preview-ws.js';
import {
  awaitDurableTerminal,
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  sendTurn,
  trackCreations,
  waitForPresentAllocation,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { prepareSession } from './scenarios-shared-faults.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import { CONTROL_PLANE_WRAPPER_BASENAME } from './sandbox-control.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type {
  CallbackSink,
  PreviewFixtureHandle,
  SandboxFaultAllocation,
  ScenarioEnvironment,
} from './scenario-capabilities.js';

const CONTROL_PLANE_TIMEOUT_MS = 15 * 60_000;
const BOOT_BUDGET_MS = 240_000;
const TURN_BUDGET_MS = 180_000;
const CALLBACK_BUDGET_MS = 60_000;
const REPORT_BUDGET_MS = 60_000;
const LATE_SETTLE_MS = 30_000;
/** A low, non-ephemeral port inside 1024..65535 that nothing listens on. */
const PREVIEW_CLOSED_PORT = 18_999;
/** Bound for a preview round trip that must fail fast (closed/blocked port). */
const PREVIEW_FAST_FAIL_BUDGET_MS = 5_000;
/** Substrings that must never appear in a contained container's env or remote. */
const RAW_CREDENTIAL_MARKERS = [
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'github_pat_',
  'glpat-',
  'ATATT',
  'x-access-token:',
] as const;
/** Token-named env vars that must not exist at all in a contained container. */
const RAW_CREDENTIAL_ENV_NAMES =
  /^(GH_TOKEN|GITHUB_TOKEN|GIT_TOKEN|GITLAB_TOKEN|BITBUCKET_TOKEN|GITHUB_APP_INSTALLATION_TOKEN)$/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A preview HTTP response buffered from a raw `node:http` request. */
type PreviewHttpResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
};

/** One preview host (the `Host` header) plus its browser-visible origin. */
type PreviewHostTarget = {
  workerUrl: URL;
  /** `Host` header value, e.g. `p8765-<hex>.localhost:8794`. */
  host: string;
  /** `Origin` header value, e.g. `http://p8765-<hex>.localhost:8794`. */
  origin: string;
};

type PreviewCookieJar = Map<string, string>;

/** Every `Set-Cookie` value in a raw HTTP response. */
function responseSetCookies(headers: IncomingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function previewSetCookie(headers: IncomingHttpHeaders, name: string): string | null {
  return responseSetCookies(headers).find(raw => raw.startsWith(`${name}=`)) ?? null;
}

function storePreviewCookies(jar: PreviewCookieJar, headers: IncomingHttpHeaders): void {
  for (const raw of responseSetCookies(headers)) {
    const pair = raw.split(';', 1)[0]?.trim() ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function previewCookieHeader(jar: PreviewCookieJar): string | undefined {
  if (jar.size === 0) return undefined;
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function previewEntryPath(ticket: string): string {
  return `/.kilo-preview/enter?ticket=${encodeURIComponent(ticket)}`;
}

/** Never surface an entry ticket in an error message, even on a request timeout. */
function redactPreviewPath(path: string): string {
  return path.replace(/([?&]ticket=)[^&]*/i, '$1<redacted>');
}

type RawWorkerRequest = {
  workerUrl: URL;
  path: string;
  /** Explicit `Host` header; Node `fetch` cannot set one. */
  host: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
};

type OpenRawWorkerResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  res: IncomingMessage;
};

function rawWorkerTarget(workerUrl: URL): { host: string; port: number } {
  const defaultPort = workerUrl.protocol === 'https:' ? '443' : '80';
  return { host: workerUrl.hostname, port: Number(workerUrl.port || defaultPort) };
}

/**
 * Open a raw `node:http` request to the Worker's TCP host/port with an explicit
 * `Host` header, resolving once the response headers arrive. Redirects are
 * never followed by `node:http`, so the caller owns every hop.
 */
function openRawWorkerRequest(options: RawWorkerRequest): Promise<OpenRawWorkerResponse> {
  const target = rawWorkerTarget(options.workerUrl);
  const headers: Record<string, string> = { Host: options.host, ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(options.body));
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  const request = http.request({
    host: target.host,
    port: target.port,
    path: options.path,
    method: options.method ?? 'GET',
    headers,
  });
  return new Promise<OpenRawWorkerResponse>((resolve, reject) => {
    let settled = false;
    const timeoutError = (): Error =>
      new Error(
        `preview request ${redactPreviewPath(options.path)} timed out after ${timeoutMs}ms`
      );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy(timeoutError());
      reject(timeoutError());
    }, timeoutMs);
    request.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    request.on('response', response => {
      if (settled) {
        response.resume();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: response.statusCode ?? 0, headers: response.headers, res: response });
    });
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function readResponseBody(res: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/** Buffer a complete raw Worker request into a status/headers/body tuple. */
async function rawWorkerRequest(options: RawWorkerRequest): Promise<PreviewHttpResponse> {
  const response = await openRawWorkerRequest(options);
  const body = await readResponseBody(response.res);
  return { status: response.status, headers: response.headers, body, text: body.toString('utf8') };
}

/** Buffer a full preview request, storing any cookies into `options.jar`. */
function previewRequest(
  target: PreviewHostTarget,
  path: string,
  options: {
    jar?: PreviewCookieJar;
    method?: string;
    body?: Buffer | string;
    origin?: string;
    timeoutMs?: number;
  } = {}
): Promise<PreviewHttpResponse> {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) headers.Origin = options.origin;
  const cookie = options.jar ? previewCookieHeader(options.jar) : undefined;
  if (cookie !== undefined) headers.Cookie = cookie;
  return rawWorkerRequest({
    workerUrl: target.workerUrl,
    path,
    host: target.host,
    method: options.method,
    headers,
    body: options.body,
    timeoutMs: options.timeoutMs,
  }).then(response => {
    if (options.jar) storePreviewCookies(options.jar, response.headers);
    return response;
  });
}

/**
 * Like `previewRequest` but returns the streaming `IncomingMessage` so a caller
 * can observe a first chunk before the origin finishes. `previewRequest` must
 * not be used for a body that stays open.
 */
function previewStreamResponse(
  target: PreviewHostTarget,
  path: string,
  options: { jar?: PreviewCookieJar; timeoutMs?: number } = {}
): Promise<OpenRawWorkerResponse> {
  const headers: Record<string, string> = {};
  const cookie = options.jar ? previewCookieHeader(options.jar) : undefined;
  if (cookie !== undefined) headers.Cookie = cookie;
  return openRawWorkerRequest({
    workerUrl: target.workerUrl,
    path,
    host: target.host,
    headers,
    timeoutMs: options.timeoutMs,
  });
}

/** Attach one `data` listener and expose first-chunk and full-body promises. */
function collectStream(res: IncomingMessage): { first: Promise<Buffer>; done: Promise<Buffer> } {
  const chunks: Buffer[] = [];
  let resolveFirst: ((chunk: Buffer) => void) | undefined;
  let firstSeen = false;
  const first = new Promise<Buffer>(resolve => {
    resolveFirst = resolve;
  });
  const done = new Promise<Buffer>((resolve, reject) => {
    res.on('data', (chunk: Buffer) => {
      const buffer: Buffer = chunk;
      chunks.push(buffer);
      if (!firstSeen) {
        firstSeen = true;
        resolveFirst?.(buffer);
      }
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
  return { first, done };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function checkPreview(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * The provider's reserved control port for `cloudflare`, derived from the same
 * table the Worker's route reads so a fixture/route drift is impossible to
 * hardcode past.
 */
function reservedCloudflarePreviewPort(): number {
  for (let port = PREVIEW_PORT_MIN; port <= PREVIEW_PORT_MAX; port += 1) {
    if (isReservedPreviewPort('cloudflare', port)) return port;
  }
  throw new Error('no reserved cloudflare preview port is defined');
}

function requireCallbacks(env: ScenarioEnvironment): NonNullable<ScenarioEnvironment['callbacks']> {
  if (!env.callbacks) throw new Error('callbacks capability is required');
  return env.callbacks;
}

function requireReports(env: ScenarioEnvironment): NonNullable<ScenarioEnvironment['reports']> {
  if (!env.reports) throw new Error('reports capability is required');
  return env.reports;
}

function requireSandbox(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['sessionSandbox']> {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

function requireControlPlaneRuntime(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['controlPlaneRuntime']> {
  if (!env.controlPlaneRuntime) throw new Error('controlPlaneRuntime capability is required');
  return env.controlPlaneRuntime;
}

/**
 * The allocation reference used by `proveNewPlane` and the container
 * inspections, after waiting for the owned container to appear.
 */
async function controlPlaneAllocation(
  deadline: ScenarioDeadline,
  sandbox: NonNullable<ScenarioEnvironment['sessionSandbox']>,
  runtime: NonNullable<ScenarioEnvironment['controlPlaneRuntime']>,
  session: WorktreeSessionResult,
  label: string
): Promise<{ allocation: string; instanceId: string; pid: number }> {
  const allocation = await waitForPresentAllocation(
    deadline,
    sandbox,
    session,
    label,
    BOOT_BUDGET_MS
  );
  if (allocation === null) throw new Error(`${label} did not expose an allocation reference`);
  const proof = await runtime.proveNewPlane({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    expectedAllocationRef: allocation,
    wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
  });
  return { allocation, instanceId: proof.instanceId, pid: proof.pid };
}

type BootedControlPlane = {
  owned: ReturnType<typeof createOwnedSessionRegistry>;
  scenarioConfig: ReturnType<typeof createOwnedSessionRegistry>['config'];
  deadline: ScenarioDeadline;
  creations: ReturnType<typeof trackCreations<WorktreeSessionResult>>;
  session: WorktreeSessionResult;
  booted: Awaited<ReturnType<typeof bootToCompletion>>;
  allocation: string;
};

async function bootControlPlane(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  scenarioName: string,
  runId: string
): Promise<BootedControlPlane> {
  const { config } = args;
  const sandbox = requireSandbox(env);
  const runtime = requireControlPlaneRuntime(env);
  const startedAt = Date.now();
  const timeoutMs = args.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS;
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  assertScenarioPreconditions(scenarioConfig, args.api);
  const session = await prepareSession(
    creations,
    scenarioConfig,
    fakeDirective(`echo:boot-${runId}`)
  );
  owned.register(session);
  const booted = await bootToCompletion(deadline, scenarioConfig, session, 'boot', text =>
    text.includes(`boot-${runId}`)
  );
  const { allocation } = await controlPlaneAllocation(deadline, sandbox, runtime, session, 'boot');
  return { owned, scenarioConfig, deadline, creations, session, booted, allocation };
}

function assertWorkspaceSession(sessionId: string, label: string): void {
  if (!/^workspace_[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new Error(`${label} did not receive a control-plane workspace_* identity: ${sessionId}`);
  }
}

async function closeCallbackSink(sink: CallbackSink | undefined): Promise<void> {
  try {
    await sink?.close();
  } catch {
    /* best-effort release */
  }
}

/**
 * Callback/report collection on the new plane. The report is the persisted
 * `cloud_agent_session_runs` row (what the queue consumer stored, so a dropped
 * schema-invalid report fails the scenario), and the callback is the grouped
 * execution callback. Both must exist for the same warm message.
 */
async function runControlPlaneCallbacks(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'control-plane-callbacks';
  const callbacks = requireCallbacks(env);
  const reports = requireReports(env);
  const runId = randomUUID();
  const events: StreamEvent[] = [];
  let sink: CallbackSink | undefined;
  let owned: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    sink = await callbacks.open();
    const boot = await bootControlPlane(args, env, scenarioName, runId);
    owned = boot;
    assertWorkspaceSession(boot.session.cloudAgentSessionId, scenarioName);
    events.push(...boot.booted.stream.events);

    // The public grouped `start` rejects `callbackTarget`; the new plane
    // registers it through the internal updateSession endpoint.
    const registered = await updateSessionCallbackTarget(
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      { url: sink.callbackUrl }
    );
    if (!registered.success) {
      throw new Error('updateSession did not accept the control-plane callback target');
    }

    const warm = await sendTurn(
      boot.deadline,
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      fakeDirective(`echo:cp-cb-${runId}`),
      'cp callback warm turn',
      TURN_BUDGET_MS
    );
    events.push(...warm.stream.events);
    warm.stream.close();

    const callback = await sink.waitFor(
      payload => payload.messageId === warm.messageId,
      Math.max(1, Math.min(CALLBACK_BUDGET_MS, boot.deadline.remaining('cp callback wait')))
    );
    if (callback === null) {
      throw new Error(`no callback arrived for control-plane message ${warm.messageId}`);
    }
    if (callback.status !== 'completed') {
      throw new Error(`control-plane callback status=${String(callback.status)} was not completed`);
    }

    const report = await reports.waitForReportRow({
      cloudAgentSessionId: boot.session.cloudAgentSessionId,
      messageId: warm.messageId,
      timeoutMs: Math.max(1, Math.min(REPORT_BUDGET_MS, boot.deadline.remaining('cp report wait'))),
    });
    if (report === null) {
      throw new Error(`no persisted report row for control-plane ${warm.messageId}`);
    }
    if (report.status !== 'completed') {
      throw new Error(`persisted report status=${report.status} was not completed`);
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; warmMessage=${warm.messageId}; ` +
        `callback=completed; report=${report.status}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (owned) {
      for (const late of await owned.creations.settleAll(LATE_SETTLE_MS)) {
        owned.owned.register(late);
      }
      await owned.owned.cleanup(scenarioName);
    }
    await closeCallbackSink(sink);
  }
  return result;
}

/**
 * `/compact` on the new plane. The command turn goes through `sendMessageV2`
 * (the unified `send` accepts prompts only), and the scenario requires the live
 * Kilo history summary count to increase: a completed turn alone does not prove
 * the session was summarised.
 */
async function runCommand(args: LifecycleArgs, env: ScenarioEnvironment): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'command';
  const runtime = requireControlPlaneRuntime(env);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let boot: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    const active = await bootControlPlane(args, env, scenarioName, runId);
    boot = active;
    assertWorkspaceSession(active.session.cloudAgentSessionId, scenarioName);
    events.push(...active.booted.stream.events);
    const allocationRef = {
      cloudAgentSessionId: active.session.cloudAgentSessionId,
      kiloSessionId: active.session.kiloSessionId,
      expectedAllocationRef: active.allocation,
      wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
    };
    const summariesBefore = await runtime.summaryCount(allocationRef);

    const commandStream = await active.deadline.within('command stream', signal =>
      openConnectedStream(
        active.scenarioConfig,
        active.session.cloudAgentSessionId,
        false,
        undefined,
        signal
      )
    );
    streams.push(commandStream);
    const command = await sendCommand(active.scenarioConfig, {
      cloudAgentSessionId: active.session.cloudAgentSessionId,
      command: 'compact',
    });
    const terminal = await commandStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, active.deadline.remaining('command terminal'))),
      command.messageId
    );
    if (!isMessageCompleted(terminal, command.messageId)) {
      throw new Error(
        `command ${command.messageId} failed: reason=${failureReasonFromEvent(terminal) ?? 'none'}`
      );
    }
    const status = await awaitDurableTerminal(
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      command.messageId,
      Math.max(1, Math.min(TURN_BUDGET_MS, boot.deadline.remaining('command durable')))
    );
    if (status !== 'completed') throw new Error(`command durable status=${status}`);

    const summariesAfter = await runtime.summaryCount(allocationRef);
    if (summariesAfter <= summariesBefore) {
      throw new Error(
        `compact completed but the Kilo summary count did not increase (${summariesBefore} -> ${summariesAfter})`
      );
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; command=${command.messageId}/completed; ` +
        `summaries=${summariesBefore}->${summariesAfter}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

/**
 * An attachment turn on the new plane. Requires the `attachments` seeding
 * capability (no profile provides R2 write access yet), so without it the whole
 * scenario is `unsupported`; it never sends an unreachable reference. With it,
 * the staged content must appear in the fake LLM's last user prompt, proving it
 * reached the model rather than only being read from disk.
 */
async function runAttachment(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'attachment';
  const runId = randomUUID().slice(0, 8);
  const content = `attachment-content-${runId}`;
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let boot: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    if (!env.attachments) throw new Error('attachments capability is required');
    const active = await bootControlPlane(args, env, scenarioName, runId);
    boot = active;
    assertWorkspaceSession(active.session.cloudAgentSessionId, scenarioName);
    events.push(...active.booted.stream.events);

    const seeded = await env.attachments.seed({
      userId: active.scenarioConfig.user.id,
      name: `${runId}.txt`,
      contents: content,
    });
    const attachmentStream = await active.deadline.within('attachment stream', signal =>
      openConnectedStream(
        active.scenarioConfig,
        active.session.cloudAgentSessionId,
        false,
        undefined,
        signal
      )
    );
    streams.push(attachmentStream);
    const sent = await sendMessage(
      active.scenarioConfig,
      {
        cloudAgentSessionId: active.session.cloudAgentSessionId,
        prompt: fakeDirective(`echo:attach-${runId}`),
        attachments: seeded,
      },
      'unified'
    );
    const terminal = await attachmentStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, active.deadline.remaining('attachment terminal'))),
      sent.messageId
    );
    if (!isMessageCompleted(terminal, sent.messageId)) {
      throw new Error(
        `attachment turn ${sent.messageId} failed: reason=${failureReasonFromEvent(terminal) ?? 'none'}`
      );
    }
    const lastPrompt = await fetchFakeLastPrompt(active.scenarioConfig.fakeLlmUrl);
    if (!lastPrompt.includes(content)) {
      throw new Error(
        `attachment content ${content} did not reach the model prompt (last prompt length ${lastPrompt.length})`
      );
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; attachment=${sent.messageId}/completed; ` +
        `contentReachedModel=true`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

/**
 * Contained-credentials run (spec §11 scenario 7). Containment is read from the
 * Worker `.dev.vars`, so the scenario only runs when the Worker actually has it
 * enabled. A pass requires clone + model + checkout read to complete and proves
 * the negative: no raw SCM credential in the container environment or the git
 * remote. The harness cannot observe the credential lookup itself; a failure of
 * either check is the signal that containment did not apply.
 */
async function runContainedCredentials(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'contained-credentials';
  const runtime = requireControlPlaneRuntime(env);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let boot: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    boot = await bootControlPlane(args, env, scenarioName, runId);
    assertWorkspaceSession(boot.session.cloudAgentSessionId, scenarioName);
    events.push(...boot.booted.stream.events);

    const read = await sendTurn(
      boot.deadline,
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      fakeDirective(`file:read:contained-${runId}:README`),
      'contained checkout read',
      TURN_BUDGET_MS
    );
    streams.push(read.stream);
    events.push(...read.stream.events);
    read.stream.close();

    const allocationRef = {
      cloudAgentSessionId: boot.session.cloudAgentSessionId,
      kiloSessionId: boot.session.kiloSessionId,
      expectedAllocationRef: boot.allocation,
      wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
    };
    const environment = await runtime.containerEnvironment(allocationRef);
    for (const [name, value] of Object.entries(environment)) {
      if (RAW_CREDENTIAL_ENV_NAMES.test(name)) {
        throw new Error(`contained container exposes a raw credential env var ${name}`);
      }
      const marker = RAW_CREDENTIAL_MARKERS.find(candidate => value.includes(candidate));
      if (marker !== undefined) {
        throw new Error(
          `contained container env ${name} still carries a raw credential (${marker})`
        );
      }
    }
    const remoteUrl = await runtime.gitRemoteUrl(allocationRef);
    if (remoteUrl !== null) {
      const marker = RAW_CREDENTIAL_MARKERS.find(candidate => remoteUrl.includes(candidate));
      if (marker !== undefined || /^[^/]*:[^@/]*@/.test(remoteUrl.replace(/^[a-z]+:\/\//i, ''))) {
        throw new Error('contained git remote still embeds a raw credential');
      }
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; clone=completed; model=completed; ` +
        `checkoutRead=${read.messageId}=completed; envRawCredential=none; gitRemoteRawCredential=none`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

/**
 * HTTP preview end to end for the hostname-dispatched v2 proxy. Boots a
 * control-plane session, starts the owned-container Node fixture, then drives
 * the Worker with raw `node:http` requests carrying an explicit preview `Host`
 * (Node `fetch` cannot set `Host`) and a manual cookie jar. A precondition
 * probe proves the running Worker dispatches preview hosts
 * (`PREVIEW_HOST_SUFFIX=localhost`) before any session work; every observation
 * is recorded in the result message and asserted; the fixture is stopped in the
 * `finally`.
 */
async function runPreviewHttp(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'preview-http';
  const runtime = requireControlPlaneRuntime(env);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const observations: string[] = [];
  let boot: BootedControlPlane | undefined;
  let fixture: PreviewFixtureHandle | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message: observations.length > 0 ? `${message}; ${observations.join('; ')}` : message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    const startFixture = runtime.startPreviewFixture;
    if (!startFixture) {
      throw new Error('preview-http requires the local owned-container fixture capability');
    }
    const secret = args.config.nextAuthSecret;
    if (!secret) {
      throw new Error('preview-http requires the local NEXTAUTH_SECRET to mint preview tickets');
    }

    const workerUrl = new URL(args.config.workerUrl);
    const workerPort = workerUrl.port || (workerUrl.protocol === 'https:' ? '443' : '80');
    const workerHostHeader = `${workerUrl.hostname}:${workerPort}`;

    // Precondition: a preview host with no ticket must answer 401 with the
    // route's fixed text. A normal worker 404 means preview dispatch is off
    // (the running Worker has no PREVIEW_HOST_SUFFIX=localhost).
    const probeSession = `workspace_${randomUUID()}`;
    const probeLabel = previewLabel(probeSession, PREVIEW_FIXTURE_PORT_CANDIDATES[0]);
    if (probeLabel === null)
      throw new Error('preview-http: could not derive a probe preview label');
    const probeHost = `${probeLabel}.localhost`;
    const probe = await rawWorkerRequest({
      workerUrl,
      path: '/.kilo-preview/enter',
      host: `${probeHost}:${workerPort}`,
    });
    if (probe.status !== 401 || !probe.text.includes('Preview ticket is missing or invalid')) {
      throw new Error(
        `preview host dispatch is off: ${probeHost} returned ${probe.status} ` +
          `${JSON.stringify(probe.text.slice(0, 80))}. Set PREVIEW_HOST_SUFFIX=localhost in ` +
          'services/cloud-agent-next/.dev.vars and restart the Worker.'
      );
    }
    observations.push('precondition=401(no-ticket entry on a preview host)');

    boot = await bootControlPlane(args, env, scenarioName, runId);
    assertWorkspaceSession(boot.session.cloudAgentSessionId, scenarioName);
    events.push(...boot.booted.stream.events);

    const allocationRef: SandboxFaultAllocation = {
      cloudAgentSessionId: boot.session.cloudAgentSessionId,
      kiloSessionId: boot.session.kiloSessionId,
      expectedAllocationRef: boot.allocation,
      wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
    };
    fixture = await startFixture(allocationRef);
    observations.push(`fixture=started(port=${fixture.port})`);

    const sessionId = boot.session.cloudAgentSessionId;
    const userId = boot.scenarioConfig.user.id;
    const label = previewLabel(sessionId, fixture.port);
    if (label === null) throw new Error(`preview-http: no preview label for port ${fixture.port}`);
    const previewHost = `${label}.localhost`;
    const previewOrigin = `${workerUrl.protocol}//${previewHost}:${workerPort}`;
    const target: PreviewHostTarget = {
      workerUrl,
      host: `${previewHost}:${workerPort}`,
      origin: previewOrigin,
    };

    const jar: PreviewCookieJar = new Map();
    const entryTicket = mintPreviewTicket({ id: userId }, sessionId, fixture.port, secret);
    const entry = await previewRequest(target, previewEntryPath(entryTicket), { jar });
    checkPreview(entry.status === 303, `entry status=${entry.status} was not 303`);
    const entryLocation = entry.headers.location;
    checkPreview(!(entryLocation ?? '').includes(entryTicket), 'entry Location leaked the ticket');
    checkPreview(entryLocation === '/', `entry Location=${String(entryLocation)} was not /`);
    checkPreview(
      entry.headers['referrer-policy'] === 'no-referrer',
      'entry did not send Referrer-Policy: no-referrer'
    );
    const entryCookie = previewSetCookie(entry.headers, 'kilo_preview');
    checkPreview(entryCookie !== null, 'entry did not set the kilo_preview cookie');
    checkPreview(
      (entryCookie ?? '').toLowerCase().includes('httponly'),
      'preview cookie was not HttpOnly'
    );
    checkPreview(!(entryCookie ?? '').includes('Secure'), 'preview cookie was Secure over http');
    observations.push('entry=303(location=/, no-ticket, cookie=kilo_preview HttpOnly)');

    const root = await previewRequest(target, '/', { jar });
    checkPreview(root.status === 200, `GET / status=${root.status}`);
    checkPreview(
      root.text.includes('<script type="module" src="/app.js">'),
      'GET / did not serve the module script tag'
    );
    checkPreview(root.text.includes('action="/submit"'), 'GET / did not serve the form action');
    checkPreview(root.text.includes('/big'), 'GET / did not link to /big');
    checkPreview(
      root.headers['referrer-policy'] !== 'no-referrer',
      'proxied / must not set Referrer-Policy: no-referrer (form POSTs would send Origin: null)'
    );
    observations.push('root=200(module-script+form+big, no no-referrer)');

    const appJs = await previewRequest(target, '/app.js', { jar });
    checkPreview(
      appJs.status === 200 && appJs.text.includes("import { x } from '/lib.js'"),
      `GET /app.js status=${appJs.status}`
    );
    const libJs = await previewRequest(target, '/lib.js', { jar });
    checkPreview(
      libJs.status === 200 && libJs.text.includes('export const x'),
      `GET /lib.js status=${libJs.status}`
    );
    observations.push('app.js=200(imports /lib.js); lib.js=200');

    const submit = await previewRequest(target, '/submit', {
      jar,
      method: 'POST',
      body: 'q=hello',
      origin: previewOrigin,
    });
    checkPreview(submit.status === 200, `POST /submit (same-origin) status=${submit.status}`);
    checkPreview(
      submit.text.includes('body=q=hello'),
      `POST /submit did not echo the body: ${submit.text.slice(0, 80)}`
    );
    checkPreview(!submit.text.includes('kilo_preview'), 'POST /submit saw the kilo_preview cookie');
    observations.push('submit=200(body echoed; kilo_preview dropped)');

    const foreign = await previewRequest(target, '/submit', {
      jar,
      method: 'POST',
      body: 'q=evil',
      origin: 'http://foreign.example',
    });
    checkPreview(foreign.status === 403, `POST /submit foreign Origin status=${foreign.status}`);
    const nullOrigin = await previewRequest(target, '/submit', {
      jar,
      method: 'POST',
      body: 'q=null',
      origin: 'null',
    });
    checkPreview(nullOrigin.status === 403, `POST /submit Origin:null status=${nullOrigin.status}`);
    observations.push('foreignOrigin=403; nullOrigin=403');

    const relativeRedirect = await previewRequest(target, '/redirect-me', { jar });
    checkPreview(
      relativeRedirect.status === 302,
      `GET /redirect-me status=${relativeRedirect.status}`
    );
    checkPreview(
      relativeRedirect.headers.location === '/login',
      `GET /redirect-me Location=${String(relativeRedirect.headers.location)} was not /login`
    );
    const absoluteRedirect = await previewRequest(target, '/abs', { jar });
    checkPreview(absoluteRedirect.status === 302, `GET /abs status=${absoluteRedirect.status}`);
    checkPreview(
      absoluteRedirect.headers.location === `${previewOrigin}/login`,
      `GET /abs Location=${String(absoluteRedirect.headers.location)} was not ${previewOrigin}/login`
    );
    observations.push(`redirect-me=302(/login); abs=302(${previewOrigin}/login)`);

    const login = await previewRequest(target, '/login', { jar });
    checkPreview(login.status === 200, `GET /login status=${login.status}`);
    const appCookie = previewSetCookie(login.headers, 'app');
    checkPreview((appCookie ?? '').startsWith('app=1'), 'GET /login did not set app=1');
    checkPreview(
      !(appCookie ?? '').toLowerCase().includes('domain'),
      'app cookie carried a Domain'
    );
    checkPreview(
      !(appCookie ?? '').toLowerCase().includes('secure'),
      'app cookie was Secure over http'
    );
    checkPreview(jar.get('app') === '1', 'cookie jar did not record app=1');
    const echo = await previewRequest(target, '/echo-cookie', { jar });
    checkPreview(echo.status === 200, `GET /echo-cookie status=${echo.status}`);
    checkPreview(
      echo.text.includes('app=1'),
      `GET /echo-cookie did not echo app=1: ${echo.text.slice(0, 80)}`
    );
    checkPreview(
      !echo.text.includes('kilo_preview'),
      'GET /echo-cookie echoed the kilo_preview cookie'
    );
    observations.push(
      'login=SetCookie(app=1, no Domain/Secure); echo-cookie=app=1(kilo_preview dropped)'
    );

    const health = await rawWorkerRequest({ workerUrl, path: '/health', host: workerHostHeader });
    checkPreview(health.status === 200, `GET /health status=${health.status}`);
    checkPreview(
      (health.headers['content-type'] ?? '').includes('application/json'),
      `GET /health content-type=${String(health.headers['content-type'])}`
    );
    checkPreview(
      health.text.includes('"status":"ok"'),
      `GET /health body=${health.text.slice(0, 80)}`
    );
    checkPreview(!health.text.includes('preview-fixture'), 'GET /health returned the fixture HTML');
    observations.push('health=200(worker host json, not fixture)');

    // A reserved provider port is refused before any upstream fetch.
    const reservedPort = reservedCloudflarePreviewPort();
    const reservedLabel = previewLabel(sessionId, reservedPort);
    if (reservedLabel === null) {
      throw new Error(`preview-http: no label for reserved port ${reservedPort}`);
    }
    const reservedTarget: PreviewHostTarget = {
      workerUrl,
      host: `${reservedLabel}.localhost:${workerPort}`,
      origin: `${workerUrl.protocol}//${reservedLabel}.localhost:${workerPort}`,
    };
    const reservedJar: PreviewCookieJar = new Map();
    const reservedEntry = await previewRequest(
      reservedTarget,
      previewEntryPath(mintPreviewTicket({ id: userId }, sessionId, reservedPort, secret)),
      { jar: reservedJar }
    );
    checkPreview(
      reservedEntry.status === 303,
      `reserved-port entry status=${reservedEntry.status}`
    );
    const reservedStarted = Date.now();
    const reserved = await previewRequest(reservedTarget, '/', { jar: reservedJar });
    const reservedMs = Date.now() - reservedStarted;
    checkPreview(
      reserved.status === 403,
      `reserved-port GET / status=${reserved.status} was not 403`
    );
    checkPreview(
      reserved.text.includes('That port is reserved'),
      `reserved-port body=${reserved.text.slice(0, 80)}`
    );
    checkPreview(
      reservedMs < PREVIEW_FAST_FAIL_BUDGET_MS,
      `reserved-port GET / took ${reservedMs}ms`
    );
    observations.push(`reservedPort=${reservedPort}:403(${reservedMs}ms)`);

    const closedLabel = previewLabel(sessionId, PREVIEW_CLOSED_PORT);
    if (closedLabel === null) {
      throw new Error(`preview-http: no label for closed port ${PREVIEW_CLOSED_PORT}`);
    }
    const closedTarget: PreviewHostTarget = {
      workerUrl,
      host: `${closedLabel}.localhost:${workerPort}`,
      origin: `${workerUrl.protocol}//${closedLabel}.localhost:${workerPort}`,
    };
    const closedJar: PreviewCookieJar = new Map();
    const closedEntry = await previewRequest(
      closedTarget,
      previewEntryPath(mintPreviewTicket({ id: userId }, sessionId, PREVIEW_CLOSED_PORT, secret)),
      { jar: closedJar }
    );
    checkPreview(closedEntry.status === 303, `closed-port entry status=${closedEntry.status}`);
    const closedStarted = Date.now();
    const closed = await previewRequest(closedTarget, '/', { jar: closedJar });
    const closedMs = Date.now() - closedStarted;
    checkPreview(closed.status === 502, `closed-port GET / status=${closed.status} was not 502`);
    checkPreview(
      closed.text.includes('Nothing is listening on that port'),
      `closed-port body=${closed.text.slice(0, 80)}`
    );
    checkPreview(closedMs < PREVIEW_FAST_FAIL_BUDGET_MS, `closed-port GET / took ${closedMs}ms`);
    observations.push(`closedPort=${PREVIEW_CLOSED_PORT}:502(${closedMs}ms)`);

    // The session's own kilo serve listens on loopback, so the preview reaches
    // it; its per-process password must make Kilo itself answer 401.
    const kiloServerPort = runtime.kiloServerPort;
    if (!kiloServerPort) {
      throw new Error('preview-http requires the local kiloServerPort capability');
    }
    const kiloPort = await kiloServerPort(allocationRef);
    const kiloLabel = previewLabel(sessionId, kiloPort);
    if (kiloLabel === null) {
      throw new Error(`preview-http: no label for the kilo serve port ${kiloPort}`);
    }
    const kiloTarget: PreviewHostTarget = {
      workerUrl,
      host: `${kiloLabel}.localhost:${workerPort}`,
      origin: `${workerUrl.protocol}//${kiloLabel}.localhost:${workerPort}`,
    };
    const kiloJar: PreviewCookieJar = new Map();
    const kiloEntry = await previewRequest(
      kiloTarget,
      previewEntryPath(mintPreviewTicket({ id: userId }, sessionId, kiloPort, secret)),
      { jar: kiloJar }
    );
    checkPreview(kiloEntry.status === 303, `kilo-serve entry status=${kiloEntry.status}`);
    const kiloSession = await previewRequest(kiloTarget, '/session', { jar: kiloJar });
    checkPreview(
      kiloSession.status === 401,
      `kilo-serve GET /session status=${kiloSession.status} was not 401`
    );
    checkPreview(
      !kiloSession.text.includes(PREVIEW_SESSION_MISSING_TEXT) &&
        !kiloSession.text.includes('Preview ticket is missing or invalid'),
      'kilo-serve 401 came from the preview route, not from Kilo'
    );
    observations.push(`kiloServe=${kiloPort}:401(from Kilo)`);

    // Chunked response: the first chunk must reach the client while the origin
    // withholds the rest until a later request to /release.
    const streamed = await previewStreamResponse(target, '/stream', { jar, timeoutMs: 20_000 });
    checkPreview(streamed.status === 200, `GET /stream status=${streamed.status}`);
    const stream = collectStream(streamed.res);
    const firstChunk = await withTimeout(stream.first, 10_000, 'streamed first chunk');
    checkPreview(
      firstChunk.toString('utf8').includes('first-chunk'),
      `first streamed chunk=${firstChunk.toString('utf8').slice(0, 40)}`
    );
    const release = await previewRequest(target, '/release', { jar });
    checkPreview(release.status === 200, `GET /release status=${release.status}`);
    const streamedBody = await withTimeout(stream.done, 20_000, 'streamed completion');
    checkPreview(
      streamedBody.toString('utf8').includes('second-chunk'),
      'streamed remainder did not include second-chunk'
    );
    observations.push('stream=first-chunk-before-release+second-chunk');

    const big = await previewStreamResponse(target, '/big', { jar, timeoutMs: 60_000 });
    checkPreview(big.status === 200, `GET /big status=${big.status}`);
    const bigBody = await withTimeout(readResponseBody(big.res), 60_000, 'big response body');
    checkPreview(
      bigBody.length === PREVIEW_BIG_RESPONSE_BYTES,
      `GET /big bytes=${bigBody.length} expected ${PREVIEW_BIG_RESPONSE_BYTES}`
    );
    const bigHash = createHash('sha256').update(bigBody).digest('hex');
    checkPreview(
      bigHash === previewBigResponseSha256(),
      `GET /big sha256=${bigHash} did not match ${previewBigResponseSha256()}`
    );
    observations.push(`big=${bigBody.length}B sha256=${bigHash.slice(0, 12)}`);

    const uploadBody = buildPreviewBigResponseBody().subarray(0, 1024 * 1024 + 4096);
    const uploadHash = createHash('sha256').update(uploadBody).digest('hex');
    const upload = await previewRequest(target, '/upload', {
      jar,
      method: 'POST',
      body: uploadBody,
      origin: previewOrigin,
      timeoutMs: 60_000,
    });
    checkPreview(upload.status === 200, `POST /upload status=${upload.status}`);
    checkPreview(
      upload.text.includes(`bytes=${uploadBody.length}`),
      `POST /upload response=${upload.text.slice(0, 80)}`
    );
    checkPreview(
      upload.text.includes(`sha256=${uploadHash}`),
      `POST /upload hash mismatch: ${upload.text.slice(0, 120)}`
    );
    observations.push(`upload=${uploadBody.length}B sha256=${uploadHash.slice(0, 12)}`);

    const ws = await connectWebSocket({
      host: previewHost,
      connectHost: workerUrl.hostname,
      port: Number(workerPort),
      path: '/ws',
      origin: previewOrigin,
      cookie: previewCookieHeader(jar),
      subprotocol: 'kilo-test',
      timeoutMs: 15_000,
    });
    checkPreview(ws.status === 101, `websocket status=${ws.status}`);
    checkPreview(
      ws.headers['sec-websocket-protocol'] === 'kilo-test',
      `websocket subprotocol=${String(ws.headers['sec-websocket-protocol'])}`
    );
    const textPayload = `ws-echo-${runId}`;
    ws.sendText(textPayload);
    const textFrame = await ws.nextFrame(10_000);
    checkPreview(
      textFrame.opcode === WS_OPCODE_TEXT && textFrame.payload.toString('utf8') === textPayload,
      `websocket text echo opcode=${textFrame.opcode}`
    );
    const binaryPayload = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
    ws.sendBinary(binaryPayload);
    const binaryFrame = await ws.nextFrame(10_000);
    checkPreview(
      binaryFrame.opcode === WS_OPCODE_BINARY && binaryFrame.payload.equals(binaryPayload),
      `websocket binary echo opcode=${binaryFrame.opcode}`
    );
    ws.sendClose(1000);
    const closeFrame = await ws.nextFrame(10_000);
    checkPreview(
      closeFrame.opcode === WS_OPCODE_CLOSE,
      `websocket close opcode=${closeFrame.opcode}`
    );
    ws.destroy();
    observations.push('websocket=101(subprotocol kilo-test; text+binary echo; close)');

    for (const [name, badOrigin] of [
      ['foreign', 'http://foreign.example'],
      ['null', 'null'],
      ['missing', undefined],
    ] as const) {
      const rejected = await connectWebSocket({
        host: previewHost,
        connectHost: workerUrl.hostname,
        port: Number(workerPort),
        path: '/ws',
        origin: badOrigin,
        subprotocol: 'kilo-test',
        timeoutMs: 10_000,
      });
      checkPreview(
        rejected.status === 403,
        `websocket ${name} Origin status=${rejected.status} was not 403`
      );
      rejected.destroy();
    }
    observations.push('websocketOrigin=foreign/null/missing:403');

    const wrongAudience = mintPreviewTicket({ id: userId }, sessionId, fixture.port, secret, {
      audience: 'cloud-agent-stream',
    });
    const wrongAudienceEntry = await previewRequest(target, previewEntryPath(wrongAudience));
    checkPreview(
      wrongAudienceEntry.status === 401,
      `wrong-audience entry status=${wrongAudienceEntry.status}`
    );
    const valid = mintPreviewTicket({ id: userId }, sessionId, fixture.port, secret);
    const tampered = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');
    const tamperedEntry = await previewRequest(target, previewEntryPath(tampered));
    checkPreview(tamperedEntry.status === 401, `tampered entry status=${tamperedEntry.status}`);
    const expired = mintPreviewTicket({ id: userId }, sessionId, fixture.port, secret, {
      expiresInSeconds: -60,
    });
    const expiredEntry = await previewRequest(target, previewEntryPath(expired));
    checkPreview(expiredEntry.status === 401, `expired entry status=${expiredEntry.status}`);
    observations.push('wrongAudience=401; tampered=401; expired=401');

    const crossSession = `workspace_${randomUUID()}`;
    const crossTicket = mintPreviewTicket({ id: userId }, crossSession, fixture.port, secret);
    const crossEntry = await previewRequest(target, previewEntryPath(crossTicket));
    checkPreview(
      crossEntry.status === 401,
      `cross-session ticket entry status=${crossEntry.status} was not 401`
    );
    observations.push('crossSession=401');

    const wrongPortTicket = mintPreviewTicket({ id: userId }, sessionId, fixture.port + 1, secret);
    const wrongPortEntry = await previewRequest(target, previewEntryPath(wrongPortTicket));
    checkPreview(
      wrongPortEntry.status === 401,
      `wrong-port ticket entry status=${wrongPortEntry.status} was not 401`
    );
    observations.push('wrongPort=401');

    const ticketCookieJar: PreviewCookieJar = new Map([['kilo_preview', entryTicket]]);
    const ticketCookie = await previewRequest(target, '/', { jar: ticketCookieJar });
    checkPreview(
      ticketCookie.status === 401,
      `entry-ticket-as-cookie GET / status=${ticketCookie.status} was not 401`
    );
    observations.push('entryTicketCookie=401');

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message: `session=${sessionId}; ${observations.join('; ')}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (fixture) {
      await fixture.stop().catch(() => undefined);
    }
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
  }
  return result;
}

export const CONTROL_PLANE_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'control-plane-callbacks': {
    name: 'control-plane-callbacks',
    requires: ['sessionSandbox', 'callbacks', 'reports', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runControlPlaneCallbacks,
  },
  command: {
    name: 'command',
    requires: ['sessionSandbox', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runCommand,
  },
  'preview-http': {
    name: 'preview-http',
    requires: ['sessionSandbox', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runPreviewHttp,
  },
  attachment: {
    name: 'attachment',
    requires: ['sessionSandbox', 'attachments', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runAttachment,
  },
  'contained-credentials': {
    name: 'contained-credentials',
    requires: ['sessionSandbox', 'controlPlaneRuntime', 'controlPlaneV2', 'credentialContainment'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runContainedCredentials,
  },
};
