/**
 * tRPC + WebSocket primitives for the local E2E driver.
 *
 * Hits the real cloud-agent-next Worker (`pnpm dev:start cloud-agent`) over
 * HTTP/WS — no in-process shortcuts. Real kilo runs inside the sandbox; only
 * LLM inference is deterministic, handled by the fake gateway in
 * `test/e2e/fake-llm-server.ts`. Scenarios are driven by directives embedded
 * in the prompt (`__fake__:<scenario>[:<args>]`) and interpreted by that fake.
 */

import WebSocket from 'ws';
import { mintApiToken, mintStreamTicket, type TestUser } from './auth.js';

/**
 * Which tRPC surface the driver exercises.
 *
 * - `unified`: the new `start` / `send` procedures that replace the legacy
 *   prepare+initiate dance with one grouped start operation after its external
 *   ownership-row prerequisite succeeds.
 * - `legacy`:  the existing `prepareSession` + `initiateFromKilocodeSessionV2`
 *   / `sendMessageV2` procedures the web UI still uses today. Keeping both
 *   covered means a regression in either surface is caught by the harness.
 */
export type ApiVersion = 'unified' | 'legacy';

export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

export type DriverConfig = {
  workerUrl: string;
  user: TestUser;
  nextAuthSecret: string;
  /**
   * Shared internal-API secret required by `prepareSession` /
   * `updateSession`. Only the legacy flow needs it; unified `start` is
   * `protectedProcedure`. Loaded from `.dev.vars` in the runner.
   */
  internalApiSecret?: string;
  /** HTTPS git URL to bootstrap the workspace. Public tiny repos work fine. */
  gitUrl: string;
  /**
   * Model ID sent to tRPC `start`. Must be accepted by the fake LLM gateway's
   * `/api/openrouter/models/validate` response - the default
   * `kilo/fake-deterministic` is the only accepted model.
   */
  model: string;
  /** Kilo organization ID — null for personal sessions. */
  kilocodeOrganizationId?: string;
  /**
   * Base URL of the fake LLM gateway, as seen **from the driver** (the host).
   * Runtime setup translates the separately configured provider URL for kilo
   * inside the sandbox. Used for fake-server side channels such as
   * `/test/release`, `/test/gate-status`, and `/test/requests`.
   */
  fakeLlmUrl: string;
};

export const DEFAULT_CONFIG: Omit<DriverConfig, 'user' | 'nextAuthSecret'> = {
  workerUrl: 'http://localhost:8794',
  gitUrl: 'https://github.com/octocat/Hello-World.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: process.env.FAKE_LLM_URL ?? 'http://localhost:8811',
};

// ---------------------------------------------------------------------------
// tRPC helpers
// ---------------------------------------------------------------------------

/**
 * Minimal tRPC HTTP-link client. The cloud-agent-next server mounts tRPC
 * without a superjson transformer, so un-batched requests use raw shapes:
 *
 *   POST /trpc/<procedure>          body: <input>
 *   GET  /trpc/<procedure>?input=…  querystring: JSON-encoded <input>
 *
 * Response shape for un-batched requests is `{ result: { data: <value> } }`.
 * The web client uses `httpLink` (see apps/web/src/lib/cloud-agent/
 * cloud-agent-client.ts) so we match that exact wire format.
 */
export async function trpcCall<T>(
  config: DriverConfig,
  procedure: string,
  input: unknown,
  opts?: { internalApiSecret?: string; method?: 'GET' | 'POST' }
): Promise<T> {
  const method = opts?.method ?? 'POST';
  const url = new URL(`/trpc/${procedure}`, config.workerUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${mintApiToken(config.user, config.nextAuthSecret)}`,
    // cloud-agent-client.ts sends this for App Builder callers; it cleanly
    // skips dev billing checks and is safe to always send from the driver.
    'x-skip-balance-check': 'true',
  };
  if (opts?.internalApiSecret) {
    headers['x-internal-api-key'] = opts.internalApiSecret;
  }
  const fetchOpts: RequestInit = { method, headers };
  if (method === 'POST') {
    fetchOpts.body = JSON.stringify(input);
  } else {
    url.searchParams.set('input', JSON.stringify(input));
  }
  const response = await fetch(url, fetchOpts);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `tRPC ${procedure} failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  const parsed = JSON.parse(text);
  return parsed?.result?.data as T;
}

// ---------------------------------------------------------------------------
// High-level session operations
// ---------------------------------------------------------------------------

export type StartSessionResult = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  executionId?: string;
  messageId: string;
  delivery: 'sent' | 'queued';
};

export type StartSessionArgs = {
  prompt: string;
  mode?: string;
  shallow?: boolean;
  callbackTarget?: CallbackTarget;
  messageId?: string;
};

/**
 * Start a new session using whichever API surface the scenario asked for.
 *
 * Both branches return the same `StartSessionResult` shape so downstream
 * scenario code (event assertions, callback assertions, etc.) doesn't care
 * which surface produced it.
 */
export async function startSession(
  config: DriverConfig,
  args: StartSessionArgs,
  api: ApiVersion = 'unified'
): Promise<StartSessionResult> {
  if (api === 'legacy') return startSessionLegacy(config, args);
  return startSessionUnified(config, args);
}

async function startSessionUnified(
  config: DriverConfig,
  args: StartSessionArgs
): Promise<StartSessionResult> {
  return trpcCall<StartSessionResult>(config, 'start', {
    message: {
      prompt: args.prompt,
      ...(args.messageId ? { id: args.messageId } : {}),
    },
    agent: {
      mode: args.mode ?? 'code',
      model: config.model,
    },
    repository: {
      type: 'git',
      url: config.gitUrl,
    },
    ...(args.callbackTarget || config.kilocodeOrganizationId
      ? {
          options: {
            ...(args.callbackTarget ? { callbackTarget: args.callbackTarget } : {}),
            ...(config.kilocodeOrganizationId
              ? { kilocodeOrganizationId: config.kilocodeOrganizationId }
              : {}),
          },
        }
      : {}),
  });
}

/**
 * Legacy two-step flow: `prepareSession` (internal-API-protected) then
 * `initiateFromKilocodeSessionV2` (user-token-protected). Returns the same
 * shape as the unified `start` procedure so callers can be version-agnostic.
 *
 * `initialMessageId` isn't exposed by the legacy prepare response shape — if
 * the caller needs to correlate the first message, passing `args.messageId`
 * threads it through `prepareSession.initialMessageId`. Initiate then queues
 * the prepared prompt using that stored ID.
 */
async function startSessionLegacy(
  config: DriverConfig,
  args: StartSessionArgs
): Promise<StartSessionResult> {
  if (!config.internalApiSecret) {
    throw new Error(
      'legacy startSession requires INTERNAL_API_SECRET from .dev.vars — add it or pass api=unified'
    );
  }

  type PrepareResult = {
    cloudAgentSessionId: string;
    kiloSessionId: string;
  };
  const prepared = await trpcCall<PrepareResult>(
    config,
    'prepareSession',
    {
      prompt: args.prompt,
      mode: args.mode ?? 'code',
      model: config.model,
      gitUrl: config.gitUrl,
      shallow: args.shallow ?? true,
      ...(args.callbackTarget ? { callbackTarget: args.callbackTarget } : {}),
      ...(args.messageId ? { initialMessageId: args.messageId } : {}),
      ...(config.kilocodeOrganizationId
        ? { kilocodeOrganizationId: config.kilocodeOrganizationId }
        : {}),
    },
    { internalApiSecret: config.internalApiSecret }
  );

  type InitiateResult = {
    cloudAgentSessionId: string;
    executionId: string;
    messageId: string;
    delivery: 'sent' | 'queued';
    streamUrl?: string;
    status?: string;
  };
  const initiated = await trpcCall<InitiateResult>(config, 'initiateFromKilocodeSessionV2', {
    cloudAgentSessionId: prepared.cloudAgentSessionId,
  });

  return {
    cloudAgentSessionId: prepared.cloudAgentSessionId,
    kiloSessionId: prepared.kiloSessionId,
    executionId: initiated.executionId,
    messageId: initiated.messageId,
    delivery: initiated.delivery,
  };
}

export type SendMessageResult = {
  executionId?: string;
  messageId: string;
  delivery: 'sent' | 'queued';
};

export type SendMessageArgs = {
  cloudAgentSessionId: string;
  prompt: string;
  mode?: string;
  messageId?: string;
};

export async function sendMessage(
  config: DriverConfig,
  args: SendMessageArgs,
  api: ApiVersion = 'unified'
): Promise<SendMessageResult> {
  if (api === 'legacy') {
    return trpcCall<SendMessageResult>(config, 'sendMessageV2', {
      cloudAgentSessionId: args.cloudAgentSessionId,
      prompt: args.prompt,
      mode: args.mode ?? 'code',
      model: config.model,
      ...(args.messageId ? { messageId: args.messageId } : {}),
    });
  }
  return trpcCall<SendMessageResult>(config, 'send', {
    cloudAgentSessionId: args.cloudAgentSessionId,
    message: {
      prompt: args.prompt,
      ...(args.messageId ? { id: args.messageId } : {}),
    },
    agent: {
      mode: args.mode ?? 'code',
      model: config.model,
    },
  });
}

// ---------------------------------------------------------------------------
// Control-plane helpers
// ---------------------------------------------------------------------------

export type InterruptResult = {
  success: boolean;
  message?: string;
  processesFound?: number;
};

export async function interruptSession(
  config: DriverConfig,
  sessionId: string
): Promise<InterruptResult> {
  return trpcCall<InterruptResult>(config, 'interruptSession', { sessionId });
}

export async function answerPermission(
  config: DriverConfig,
  sessionId: string,
  permissionId: string,
  response: 'once' | 'always' | 'reject'
): Promise<{ success: boolean }> {
  return trpcCall<{ success: boolean }>(config, 'answerPermission', {
    sessionId,
    permissionId,
    response,
  });
}

// ---------------------------------------------------------------------------
// Fake-LLM gate helpers
// ---------------------------------------------------------------------------

/**
 * Release a `gate:<tag>` scenario parked on the fake LLM server. The driver
 * uses this to unblock a turn that's been holding the wrapper busy, typically
 * after queueing follow-up messages.
 */
export async function releaseGate(fakeLlmUrl: string, tag: string): Promise<void> {
  const url = `${fakeLlmUrl.replace(/\/$/, '')}/test/release?tag=${encodeURIComponent(tag)}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`releaseGate(${tag}) failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Snapshot of parked waiters on the fake LLM server. Useful for asserting
 * that no stale gate/hang requests remain after a scenario completes.
 */
export type FakeWaitersSnapshot = {
  tags: Array<{ tag: string; count: number }>;
  liveResponses: number;
};

export async function fetchFakeWaiters(fakeLlmUrl: string): Promise<FakeWaitersSnapshot> {
  const url = `${fakeLlmUrl.replace(/\/$/, '')}/test/waiters`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchFakeWaiters failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as FakeWaitersSnapshot;
}

export type FakeRequestSnapshot = {
  chatCompletions: number;
};

export async function fetchFakeRequests(fakeLlmUrl: string): Promise<FakeRequestSnapshot> {
  const url = `${fakeLlmUrl.replace(/\/$/, '')}/test/requests`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchFakeRequests failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as FakeRequestSnapshot;
}

/**
 * Poll the fake LLM server until a `gate:<tag>` scenario is actively parked —
 * meaning kilo has dialed the fake and the turn is blocked mid-stream.
 * Returns true on success, false on timeout.
 */
export async function waitForGateEngaged(
  config: DriverConfig,
  tag: string,
  timeoutMs = 90_000,
  pollIntervalMs = 100
): Promise<boolean> {
  const base = config.fakeLlmUrl.replace(/\/$/, '');
  const url = `${base}/test/gate-status?tag=${encodeURIComponent(tag)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { engaged?: boolean };
        if (body.engaged === true) return true;
      }
    } catch {
      // Server not ready yet — keep polling until the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// WebSocket stream
// ---------------------------------------------------------------------------

export type StreamEvent = {
  eventId: number;
  executionId: string | null;
  sessionId: string;
  streamEventType: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export type StreamConnection = {
  events: StreamEvent[];
  close: () => void;
  /** Resolves when a terminal event arrives or timeout elapses. */
  waitForTerminal: (timeoutMs: number) => Promise<StreamEvent | null>;
  /** Resolves the first event matching the predicate. */
  waitFor: (
    predicate: (event: StreamEvent) => boolean,
    timeoutMs: number
  ) => Promise<StreamEvent | null>;
  /** Number of events received so far. */
  get receivedCount(): number;
  /** Whether the socket is still open. */
  get isOpen(): boolean;
};

export type StreamOptions = {
  replay?: boolean;
  onEvent?: (event: StreamEvent) => void;
};

/** Event types we treat as terminal for scenario purposes. */
const TERMINAL_STREAM_TYPES = new Set(['complete', 'error', 'interrupted', 'cloud.message.failed']);

export function openStream(
  config: DriverConfig,
  cloudAgentSessionId: string,
  options: StreamOptions = {}
): StreamConnection {
  const wsBase = config.workerUrl.replace(/^http/, 'ws');
  const url = new URL(`/stream`, wsBase);
  url.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);
  url.searchParams.set(
    'ticket',
    mintStreamTicket(config.user, cloudAgentSessionId, config.nextAuthSecret)
  );
  if (options.replay === false) {
    url.searchParams.set('replay', 'false');
  }

  const ws = new WebSocket(url.toString());
  const events: StreamEvent[] = [];
  let closed = false;
  const listeners: Array<{
    predicate: (event: StreamEvent) => boolean;
    resolve: (event: StreamEvent | null) => void;
  }> = [];

  ws.on('message', raw => {
    let parsed: StreamEvent;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    events.push(parsed);
    options.onEvent?.(parsed);
    for (let i = listeners.length - 1; i >= 0; i--) {
      const listener = listeners[i];
      if (listener && listener.predicate(parsed)) {
        listener.resolve(parsed);
        listeners.splice(i, 1);
      }
    }
  });

  ws.on('close', () => {
    closed = true;
    for (const listener of listeners.splice(0)) {
      listener.resolve(null);
    }
  });

  ws.on('error', err => {
    console.error('stream error:', err);
  });

  function close(): void {
    if (closed) return;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    closed = true;
  }

  function waitFor(
    predicate: (event: StreamEvent) => boolean,
    timeoutMs: number
  ): Promise<StreamEvent | null> {
    // Check existing events first so the predicate wins immediately when
    // the target is already in history.
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const idx = listeners.findIndex(l => l.resolve === resolveOnce);
        if (idx >= 0) listeners.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      function resolveOnce(event: StreamEvent | null): void {
        clearTimeout(timer);
        resolve(event);
      }
      listeners.push({ predicate, resolve: resolveOnce });
    });
  }

  return {
    events,
    close,
    waitFor,
    waitForTerminal: timeoutMs =>
      waitFor(event => TERMINAL_STREAM_TYPES.has(event.streamEventType), timeoutMs),
    get receivedCount() {
      return events.length;
    },
    get isOpen() {
      return !closed;
    },
  };
}

/** Wait for the WebSocket to actually open (not just for instantiation). */
export function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type AssertionResult = { ok: boolean; message: string };

/**
 * Lightweight sequence matcher: each matcher must pass in order, skipping
 * non-matching events. Returns the first failure as a human-readable message.
 */
export function expectEventSequence(
  events: StreamEvent[],
  matchers: Array<(event: StreamEvent) => boolean | string>,
  matcherNames: string[]
): AssertionResult {
  let cursor = 0;
  for (let m = 0; m < matchers.length; m++) {
    const matcher = matchers[m];
    if (!matcher) continue;
    const name = matcherNames[m] ?? `matcher[${m}]`;
    let matched = false;
    while (cursor < events.length) {
      const event = events[cursor];
      cursor++;
      if (!event) continue;
      const result = matcher(event);
      if (result === true) {
        matched = true;
        break;
      }
      if (typeof result === 'string') {
        return {
          ok: false,
          message: `matcher "${name}" rejected event: ${result}`,
        };
      }
    }
    if (!matched) {
      return {
        ok: false,
        message: `matcher "${name}" did not match any event; got ${events.length} events total`,
      };
    }
  }
  return { ok: true, message: `matched ${matchers.length} events in sequence` };
}
