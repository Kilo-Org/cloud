import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  event,
  fixture,
  grant,
  histogram,
  observe,
  Pending,
  prefix,
  readConfig,
  seedText,
  session,
  sha256,
  summarize,
  arrivalAllowed,
  validateReceipt,
  assertReceiptRetry,
  populationMatches,
} from './perf-common.mjs';
import { observeSDKSource } from './perf-sdk-hooks.mjs';
import { WebSocket as RawWebSocket } from 'ws';

const [role, configFile] = process.argv.slice(2);
assert(
  ['seed', 'producer', 'raw', 'sdk'].includes(role),
  'Role must be seed, producer, raw or sdk'
);
const config = readConfig(configFile);
const keys = JSON.parse(readFileSync(config.keysFile, 'utf8'));
const stateFile = `${config.root}/sessions-${config.shard}.json`;
assert.equal(
  existsSync(stateFile),
  role !== 'seed',
  'Seed once into a fresh run directory before connecting'
);
const sessions = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : Array.from({ length: config.sessions }, (_, index) => session(config, index)).filter(
      s => s.index % config.shards === config.shard
    );
assert(
  sessions.every(
    s =>
      s.id === session(config, s.index).id &&
      s.source === session(config, s.index).source &&
      s.index % config.shards === config.shard
  ),
  'Saved session identity must match this shard and run'
);
assert.equal(
  sessions.length,
  Math.max(0, Math.ceil((config.sessions - config.shard) / config.shards)),
  'Saved shard must contain its entire declared session population'
);
assert.equal(new Set(sessions.map(s => s.index)).size, sessions.length);
const selected =
  role === 'sdk'
    ? sessions.filter(s => s.index < config.sdkViewers)
    : role === 'raw'
      ? sessions
          .filter(s =>
            config.rawMirror
              ? s.index < config.rawViewers
              : s.index >= config.sdkViewers && s.index < config.sdkViewers + config.rawViewers
          )
          .flatMap(s =>
            Array.from({ length: config.rawCopies }, (_, copy) => ({
              ...s,
              viewerKey: `${s.index}:${copy}`,
            }))
          )
      : sessions;
const watched = sessions.filter(s => s.index < config.watched);
const streaming = sessions.filter(s => s.index < config.streamingSources);
const stats = {
  version: 1,
  role,
  shard: config.shard,
  runID: config.runID,
  started: Date.now(),
  sourceTrafficMode: config.sourceTrafficMode,
  streamingSources: streaming.length,
  watchedSessions: watched.length,
  offeredEventsPerSecond: streaming.length * config.eventHz,
  requestCount: 0,
  inFlight: 0,
  peakInFlight: 0,
  errors: {},
  samples: [],
  http: {},
  localSignedGrants: 0,
  localExchangeResponses: 0,
  attempted: 0,
  sent: 0,
  skipped: 0,
  received: 0,
  measuredReceived: 0,
  duplicate: 0,
  outOfOrder: 0,
  resets: 0,
  // Unexpected closes before drain, not completed reconnects.
  reconnects: 0,
  callbacks: 0,
  projectionFailures: 0,
  checkpoints: 0,
  reconciledReceipts: 0,
  warmSent: 0,
  measuredSent: 0,
  lateReceived: 0,
  afterDrain: 0,
  maxBufferedBytes: 0,
  scheduleLag: histogram(),
  wireLatency: histogram(),
  callbackLatency: histogram(),
  scheduledLatency: histogram(),
  wireToCallback: histogram(),
  listener: histogram(),
  sdkQueue: histogram(),
  sdkProjection: histogram(),
  checkpointQueueLag: histogram(),
  checkpointQueueDepth: 0,
  maxCheckpointQueueDepth: 0,
  requestLatency: histogram(),
  live: {},
  queue: [],
  bodyBytes: { min: 512, max: 512 },
};
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const pending = new Pending(config.pendingLimit, config.pendingTTLms);
const live = new Map();
const entryFor = s => live.get(s.viewerKey ?? s.index);
const controllers = new Set();
const done = new Set();
const checkpointQueue = [];
let checkpointHead = 0;
let failure;
let stopping = false;
let window;
const stop = reason => {
  if (!failure) failure = reason;
  stopping = true;
  for (const controller of controllers) controller.abort();
};
const category = name => {
  stats.errors[name] = (stats.errors[name] ?? 0) + 1;
};
const atomic = (file, value) => {
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file + '.tmp', file);
};
const watchdog = setTimeout(() => stop('absolute_watchdog'), config.stopAt - Date.now());
process.on('SIGTERM', () => stop('signal'));
process.on('SIGINT', () => stop('signal'));
process.on('unhandledRejection', () => stop('unhandled_rejection'));
let projectionStart = 0;
if (role === 'sdk' && config.instrumentSDK)
  observeSDKSource(config.sdkModule, (stage, input) => {
    if (!arrivalAllowed(window, Date.now())) return;
    const frame = stage === 'dequeue' ? JSON.parse(input) : input;
    const id = frame.body?.data?.id;
    if (stage === 'dequeue' && id) {
      const arrival = pending.entries.get(id);
      if (arrival !== undefined) observe(stats.sdkQueue, performance.now() - arrival);
    }
    if (stage === 'projection_start') projectionStart = performance.now();
    if (stage === 'projection_end')
      observe(stats.sdkProjection, performance.now() - projectionStart);
  });
function bearer(s) {
  stats.localSignedGrants++;
  return grant(
    s,
    keys.SESSION_SYNC_SECRET,
    config.audience,
    config.organizationID,
    config.grantTTLseconds
  );
}
async function request(s, route, method = 'GET', body, caller) {
  assert(!stopping, 'Run stopped');
  if (++stats.requestCount > config.maxRequests || stats.inFlight >= config.requestConcurrency) {
    stop('request_budget');
    throw Error('Request budget');
  }
  stats.inFlight++;
  stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
  const start = performance.now();
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), Math.min(10000, config.stopAt - Date.now()));
  try {
    const response = await fetch(new URL(route, config.baseURL), {
      method,
      redirect: 'error',
      headers: caller?.headers ?? {
        authorization: `Bearer ${bearer(s)}`,
        'content-type': 'application/json',
      },
      body: caller?.body ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: caller?.signal
        ? AbortSignal.any([controller.signal, caller.signal])
        : controller.signal,
    });
    const type = response.headers.get('content-type') ?? '';
    const ray = response.headers.get('cf-ray');
    const code = response.ok
      ? 'ok'
      : response.status === 429
        ? 'rate_limit'
        : response.status === 503
          ? 'overload'
          : response.status === 403
            ? 'denied'
            : 'http_error';
    const key = `${method}:${route.replace(s.id, ':id').split('?')[0]}:${response.status}`;
    stats.http[key] = (stats.http[key] ?? 0) + 1;
    if (!response.ok || !type.includes('application/json')) {
      category(code);
      if (stats.samples.length < 32)
        stats.samples.push({
          at: Date.now(),
          status: response.status,
          category: code,
          ray,
          retryAfter: response.headers.get('retry-after'),
          contentType: type.split(';')[0],
        });
      await response.body?.cancel();
      stop(code);
      throw Error(code);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
    stats.inFlight--;
    observe(stats.requestLatency, performance.now() - start);
  }
}
async function pool(items, fn) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(config.requestConcurrency, items.length) }, async () => {
      while (index < items.length && !stopping) await fn(items[index++]);
    })
  );
}
async function checkpoint(s) {
  if (s.busy) {
    stats.skipped++;
    stop('checkpoint_overlap');
    return;
  }
  s.busy = true;
  const throughSequence = s.counter;
  const value = fixture(s, throughSequence);
  const batch = {
    version: 1,
    sourceID: s.source,
    batchID: randomUUID(),
    after: s.position,
    through: s.position + 1,
    changes: [{ op: 'put', kind: 'message', id: s.messageID, value }],
  };
  try {
    const receipt = validateReceipt(
      s,
      batch,
      await request(s, `/v1/sessions/${s.id}/batches`, 'POST', batch)
    );
    s.position = receipt.through;
    s.revision = receipt.revision;
    s.committed = throughSequence;
    s.lastBatch = batch;
    s.lastReceipt = receipt;
    stats.checkpoints++;
  } finally {
    s.busy = false;
  }
}
function dispatchCheckpoints() {
  while (
    !stopping &&
    checkpointHead < checkpointQueue.length &&
    stats.inFlight < config.requestConcurrency - 64
  ) {
    const { source, scheduled } = checkpointQueue[checkpointHead++];
    const lag = Date.now() - scheduled;
    if (lag > 1000) {
      stop('checkpoint_schedule_deadline');
      break;
    }
    observe(stats.checkpointQueueLag, lag);
    const promise = checkpoint(source)
      .catch(() => stop('checkpoint'))
      .finally(() => done.delete(promise));
    done.add(promise);
  }
  if (checkpointHead > 1024) {
    checkpointQueue.splice(0, checkpointHead);
    checkpointHead = 0;
  }
  stats.checkpointQueueDepth = checkpointQueue.length - checkpointHead;
  stats.maxCheckpointQueueDepth = Math.max(
    stats.maxCheckpointQueueDepth,
    stats.checkpointQueueDepth
  );
}
function socketReason(value) {
  if (typeof value !== 'string') return undefined;
  const bounded = value.length > 2048 ? value.slice(0, 2048).replace(/\S*$/, '[truncated]') : value;
  return bounded
    .replace(/\bauthorization\b(?:\s*[:=]|\s+)[\s\S]*/gi, '[redacted]')
    .replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s"'<>]+/gi, '[redacted]')
    .replace(/\bkilo-session-ticket\.[^\s"',;<>]+/gi, '[redacted]')
    .replace(/\bbearer\s+(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"'<>;,]+)/gi, '[redacted]')
    .replace(
      /\b(?:[\w-]*ticket|sec-websocket-protocol|protocols?)\b\s*[:=]?\s*(?:\[[^\]]*(?:\]|$)|"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/gi,
      '[redacted]'
    )
    .replace(/\b[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/[a-z\d._~+/=-]{24,}/gi, '[redacted]')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256);
}
function socketErrorCode(value) {
  return typeof value === 'string' &&
    /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(
      value
    )
    ? value
    : undefined;
}
function socketHTTPStatus(event, reason) {
  for (const error of [event.error, event.error?.cause, event]) {
    for (const status of [error?.status, error?.statusCode, error?.response?.status])
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const match =
    /\b(?:unexpected server response|(?:http(?:\/[12](?:\.[01])?)?\s+)?status(?:\s+code)?)\s*[:=]?\s*([1-5]\d{2})\b/i.exec(
      reason ?? ''
    ) ?? /\bHTTP\/[12](?:\.[01])?\s+([1-5]\d{2})\b/i.exec(reason ?? '');
  return match ? Number(match[1]) : undefined;
}
function socketContext(socket, s, presence) {
  return {
    at: Date.now(),
    sessionIndex: s.index,
    socketRole: role === 'producer' ? (presence ? 'presence' : 'runner') : 'viewer',
    readyState:
      Number.isInteger(socket.readyState) && socket.readyState >= 0 && socket.readyState <= 3
        ? socket.readyState
        : undefined,
  };
}
function trackSocket(socket, s, presence = false) {
  socket.addEventListener('open', () => {
    const entry = entryFor(s);
    if (entry) entry.opens++;
  });
  socket.addEventListener('close', event => {
    const unexpected = !stopping && !!window && Date.now() < window.drainAt;
    // Only the wire event, never RemoteSocket's synthetic internal disconnect(1011).
    if (unexpected)
      stats.firstSocketClose ??= {
        ...socketContext(socket, s, presence),
        event: 'websocket_close',
        nativeCloseCode:
          Number.isInteger(event.code) && event.code >= 0 && event.code <= 4999
            ? event.code
            : undefined,
        wasClean: typeof event.wasClean === 'boolean' ? event.wasClean : undefined,
        reason: socketReason(event.reason),
        unexpected,
      };
    if (!stopping && window && Date.now() < window.drainAt) {
      stats.reconnects++;
      stop('unexpected_socket_close');
    }
  });
  socket.addEventListener('error', event => {
    if (!stats.firstSocketError) {
      const reason = socketReason(event.error?.message ?? event.message);
      stats.firstSocketError = {
        ...socketContext(socket, s, presence),
        event: 'websocket_error',
        reason,
        errorCode: socketErrorCode(event.error?.code ?? event.code),
        causeCode: socketErrorCode(event.error?.cause?.code ?? event.cause?.code),
        httpStatus: socketHTTPStatus(event, reason),
      };
    }
    if (!stopping) category('socket_error');
  });
}
const { RemoteSocket } = await import(pathToFileURL(config.nativeModule).href);
async function remote(s, presence = false, onFrame) {
  let wire;
  const entry = entryFor(s);
  class NativeWire extends WebSocket {
    constructor(url, options) {
      super(url, ['kilo-session-ticket.' + options.headers.Authorization.slice(7)]);
      wire = this;
      trackSocket(this, s, presence);
    }
  }
  const path = presence ? '/v1/presence' : `/v1/sessions/${s.id}/live`;
  const transport = new RemoteSocket({
    url: new URL(path, config.baseURL).href,
    socket: NativeWire,
    terminalReplacement: !presence,
    ticket: () =>
      request(s, presence ? '/v1/presence/ticket' : `/v1/sessions/${s.id}/live-ticket`, 'POST', {
        role: 'runner',
      }),
    onState: connected => {
      entry[presence ? 'presence' : 'runner'] = connected;
    },
    onFrame: frame => {
      if (frame.type === 'reset_required') stats.resets++;
      if (frame.type === 'error') {
        const code = ['watch_unavailable', 'service_overloaded', 'rate_limited'].includes(
          frame.body?.code
        )
          ? frame.body.code
          : 'control_error';
        category(code);
        stop(code);
      }
      onFrame?.(frame);
    },
  });
  transport.start();
  const deadline = Date.now() + 15000;
  while (!transport.connected && !stopping && Date.now() < deadline) await sleep(10);
  assert(transport.connected, 'Native socket readiness deadline');
  return {
    transport,
    get bufferedAmount() {
      return wire?.bufferedAmount ?? 0;
    },
  };
}
function heartbeat(s, entry) {
  if (!entry.presence) return;
  entry.presenceSocket.transport.send({
    type: 'heartbeat',
    instanceID: `load-${s.index}`,
    advertisement: {
      name: 'synthetic',
      projectName: 'synthetic-load',
      version: config.nativeSHA,
      kind: 'cli',
      startedAt: stats.started,
      gitBranch: null,
      capabilities: ['native-live-v1'],
      sessions: [s.id],
    },
  });
}
function arrived(s, frame, sdk = false) {
  if (frame.channel !== 'events') return;
  const metadata = frame.body?.load;
  if (!metadata) return;
  const now = Date.now();
  if (!arrivalAllowed(window, now)) {
    stats.afterDrain++;
    return;
  }
  assert.equal(frame.body.data.id, `${s.index}:${metadata.sequence}`);
  assert.equal(frame.body.data.data.delta.length, 5);
  const entry = entryFor(s);
  if (metadata.sequence >= entry.seen.length) {
    stop('sequence_budget');
    return;
  }
  if (entry.seen[metadata.sequence]) {
    stats.duplicate++;
    return;
  }
  entry.seen[metadata.sequence] = 1;
  if (metadata.sequence !== entry.last + 1) stats.outOfOrder++;
  entry.last = metadata.sequence;
  stats.received++;
  if (window) {
    if (now > window.sendUntil) stats.lateReceived++;
    if (metadata.scheduled >= window.warmUntil && metadata.scheduled < window.sendUntil) {
      stats.measuredReceived++;
      observe(stats.wireLatency, now - metadata.sent);
    }
  }
  if (sdk) pending.add(`${s.index}:${metadata.sequence}`, performance.now());
}
async function viewer(s) {
  const entry = entryFor(s);
  if (role === 'raw') {
    let socket;
    let timer;
    const connect = async () => {
      if (stopping) return;
      const ticket = await request(s, `/v1/sessions/${s.id}/live-ticket`, 'POST', {
        role: 'viewer',
      });
      const url = new URL(`/v1/sessions/${s.id}/live`, config.baseURL);
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      socket = new RawWebSocket(url, ['kilo-session-ticket.' + ticket.ticket], {
        maxPayload: 65536,
        perMessageDeflate: false,
      });
      trackSocket(socket, s);
      entry.pause = () => socket.pause();
      entry.resume = () => socket.resume();
      socket.addEventListener('close', () => {
        entry.ready = false;
        if (!stopping)
          timer = setTimeout(() => void connect().catch(() => stop('raw_reconnect')), 1000);
      });
      socket.addEventListener('message', message => {
        const frame = JSON.parse(message.data);
        if (frame.channel === 'events') arrived(s, frame);
        if (frame.type === 'hello') {
          socket.send(JSON.stringify({ type: 'subscribe', afterSeq: frame.seq }));
          entry.ready = true;
        }
        if (frame.type === 'hello' || frame.type === 'reauthorized') {
          clearTimeout(timer);
          timer = setTimeout(
            () =>
              void request(s, `/v1/sessions/${s.id}/live-ticket`, 'POST', { role: 'viewer' })
                .then(next => socket.send(JSON.stringify({ type: 'reauth', ticket: next.ticket })))
                .catch(() => stop('raw_renewal')),
            Math.max(1, Date.parse(frame.body.reauthAt) - Date.now())
          );
        }
        if (frame.type === 'error') {
          category('raw_control_error');
          stop('raw_control_error');
        }
        if (frame.type === 'reset_required') {
          stats.resets++;
          stop('raw_reset');
        }
      });
    };
    await connect();
    entry.close = () => {
      clearTimeout(timer);
      socket?.close();
    };
  } else {
    const { NativeSyncClient } = await import(pathToFileURL(config.sdkModule).href);
    class ObservedSocket extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        trackSocket(this, s);
        this.addEventListener('message', message => {
          const frame = JSON.parse(message.data);
          if (frame.type === 'reset_required') stats.resets++;
          arrived(s, frame, true);
        });
      }
    }
    const client = new NativeSyncClient({
      baseUrl: config.baseURL,
      WebSocket: ObservedSocket,
      getCredential: async () => 'synthetic-scale-signing-not-real-exchange',
      fetch: async (url, init) => {
        assert.equal(new URL(url).origin, new URL(config.baseURL).origin);
        if (new URL(url).pathname === '/v1/auth/exchange') {
          stats.localExchangeResponses++;
          const token = bearer(s);
          const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
          return Response.json({
            token,
            expiresAt: new Date(exp * 1000).toISOString(),
          });
        }
        const path = new URL(url).pathname + new URL(url).search;
        return Response.json(
          await request(
            s,
            path,
            init?.method ?? 'GET',
            init?.body ? JSON.parse(init.body) : undefined,
            init
          )
        );
      },
    });
    const connection = client.connectSession(
      s.id,
      state => {
        const begin = performance.now();
        if (!arrivalAllowed(window, Date.now())) return;
        stats.callbacks++;
        entry.ready = state.connection === 'connected' && state.messages.length > 0;
        if (state.error) {
          category('sdk_state');
          stop('sdk_state');
        }
        entry.state = state;
        const frame = state.events.at(-1);
        const metadata = frame?.body?.load;
        if (metadata && metadata.sequence > entry.projected) {
          entry.projected = metadata.sequence;
          const arrival = pending.take(`${s.index}:${metadata.sequence}`);
          if (arrival !== undefined) observe(stats.wireToCallback, performance.now() - arrival);
          if (
            window &&
            metadata.scheduled >= window.warmUntil &&
            metadata.scheduled < window.sendUntil
          ) {
            observe(stats.callbackLatency, Date.now() - metadata.sent);
            observe(stats.scheduledLatency, Date.now() - metadata.scheduled);
          }
        }
        observe(stats.listener, performance.now() - begin);
      },
      config.organizationID
    );
    entry.close = () => connection.close();
  }
  const deadline = Date.now() + 15000;
  while (!entry.ready && !stopping && Date.now() < deadline) await sleep(10);
  assert(entry.ready, 'Viewer readiness deadline');
}
function sample() {
  if (existsSync(`${config.root}/stop.json`)) stop('cluster_abort');
  pending.expire(performance.now());
  const population = {
    presence: 0,
    runners: 0,
    streamingSources: 0,
    viewers: 0,
    sdkViewers: 0,
    watched: 0,
  };
  for (const entry of live.values()) {
    if (entry.presence) population.presence++;
    if (entry.runner) {
      population.runners++;
      population.streamingSources++;
    }
    if (entry.ready) {
      population.viewers++;
      if (role === 'sdk') population.sdkViewers++;
    }
    if (entry.watching) population.watched++;
  }
  stats.live = population;
  const row = {
    at: Date.now(),
    role,
    shard: config.shard,
    ...population,
    requests: stats.inFlight,
    pending: pending.entries.size,
    sent: stats.sent,
    received: stats.received,
    checkpointQueue: stats.checkpointQueueDepth,
    scheduleBacklogMax: stats.backlogSinceSample ?? 0,
    rss: process.memoryUsage().rss,
  };
  if (stats.queue.length < 1800) stats.queue.push(row);
  stats.backlogSinceSample = 0;
  atomic(`${config.root}/status-${role}-${config.shard}.json`, {
    ...row,
    failed: failure,
    ready:
      role === 'producer'
        ? populationMatches(population, {
            presence: sessions.length,
            runners: streaming.length,
            streamingSources: streaming.length,
            watched: watched.length,
          })
        : population.viewers === selected.length,
  });
}
const sampler = setInterval(sample, 500);
try {
  if (role === 'seed') {
    await pool(selected, async s => {
      const result = await request(s, `/v1/sessions/${s.id}`, 'PUT', {
        version: 1,
        sourceID: s.source,
      });
      s.position = result.position;
      await checkpoint(s);
    });
    atomic(stateFile, sessions);
  } else {
    const maxSequence =
      Math.ceil((config.warmSeconds + config.measuredSeconds) * config.eventHz) + 2;
    for (const s of selected)
      live.set(s.viewerKey ?? s.index, {
        sourceIndex: s.index,
        opens: 0,
        last: 0,
        projected: 0,
        seen: new Uint8Array(maxSequence),
      });
    await pool(selected, async s => {
      const entry = entryFor(s);
      if (role === 'producer') {
        entry.presenceSocket = await remote(s, true, frame => {
          if (frame.type === 'watch' && frame.body.sessionID === s.id)
            entry.watching = frame.body.watching;
        });
        if (s.index < config.streamingSources) entry.runnerSocket = await remote(s);
      } else await viewer(s);
    });
    const heartbeatTimer =
      role === 'producer'
        ? setInterval(() => {
            for (const s of selected) heartbeat(s, entryFor(s));
          }, 30000)
        : undefined;
    if (role === 'producer') {
      const initialHeartbeat = setInterval(() => {
        for (const s of selected)
          if (!entryFor(s).advertised && entryFor(s).presence) {
            heartbeat(s, entryFor(s));
            entryFor(s).advertised = true;
          }
      }, 25);
      done.add(initialHeartbeat);
    }
    sample();
    while (!window && !stopping && Date.now() < config.startAt) {
      const file = `${config.root}/window.json`;
      if (existsSync(file)) window = JSON.parse(readFileSync(file, 'utf8'));
      else await sleep(10);
    }
    assert(window && window.startAt >= Date.now(), 'Live barrier missed; no hidden warmup');
    assert.equal(window.runID, config.runID);
    assert.equal(
      window.sendUntil,
      window.startAt + (config.warmSeconds + config.measuredSeconds) * 1000
    );
    assert.equal(window.warmUntil, window.startAt + config.warmSeconds * 1000);
    assert.equal(window.drainAt, window.sendUntil + config.drainSeconds * 1000);
    assert(window.drainAt <= config.stopAt);
    const closeAtDrain = setTimeout(() => {
      for (const entry of live.values()) {
        entry.close?.();
        entry.presenceSocket?.transport.stop();
        entry.runnerSocket?.transport.stop();
      }
    }, window.drainAt - Date.now());
    done.add(closeAtDrain);
    if (role === 'raw' && config.rawPauseSeconds) {
      done.add(
        setTimeout(
          () => {
            for (const entry of live.values()) entry.pause?.();
          },
          Math.max(0, window.startAt + 1000 - Date.now())
        )
      );
      done.add(
        setTimeout(
          () => {
            for (const entry of live.values()) entry.resume?.();
          },
          Math.max(0, window.startAt + 1000 + config.rawPauseSeconds * 1000 - Date.now())
        )
      );
    }
    while (Date.now() < window.startAt && !stopping) await sleep(5);
    while (Date.now() < window.sendUntil && !stopping) {
      if (role === 'producer') {
        const now = Date.now();
        for (const s of streaming) {
          const period = 1000 / config.eventHz;
          let scheduled =
            window.startAt + ((s.index % 100) / 100) * period * 0.9 + s.counter * period;
          const backlog = Math.max(0, Math.floor((now - scheduled) / period) + 1);
          stats.maxScheduleBacklog = Math.max(stats.maxScheduleBacklog ?? 0, backlog);
          stats.backlogSinceSample = Math.max(stats.backlogSinceSample ?? 0, backlog);
          if (backlog > 5) {
            stop('source_schedule_queue_budget');
            break;
          }
          while (scheduled <= now && scheduled < window.sendUntil && !stopping) {
            const sentAt = Date.now();
            stats.attempted++;
            observe(stats.scheduleLag, sentAt - scheduled);
            const entry = entryFor(s);
            const buffered = entry.runnerSocket.bufferedAmount;
            stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, buffered);
            // Synthetic all-streaming-sources overload; real CLI watch suppression is unchanged.
            if (
              !entry.runner ||
              (s.index < config.watched && !entry.watching) ||
              buffered > config.maxBufferedBytes
            ) {
              stop('source_unavailable_or_backpressure');
              break;
            }
            const sequence = s.counter + 1;
            if (!entry.runnerSocket.transport.send(event(s, sequence, scheduled, sentAt))) {
              stop('native_send_rejected');
              break;
            }
            s.counter = sequence;
            stats.sent++;
            if (scheduled < window.warmUntil) stats.warmSent++;
            else stats.measuredSent++;
            scheduled += period;
          }
        }
        dispatchCheckpoints();
        const newlyDue = [];
        for (const s of selected) {
          const offset = (s.index % 5000) * 0.9;
          const due = Math.floor((now - window.startAt - offset) / 5000);
          if (due >= 0 && due !== s.checkpointSlot) {
            const scheduled = window.startAt + offset + due * 5000;
            if (s.checkpointSlot !== undefined && due !== s.checkpointSlot + 1) {
              stats.skipped++;
              stop('missed_checkpoint_tick');
              break;
            }
            if (now - scheduled > 1000) {
              stop('checkpoint_schedule_deadline');
              break;
            }
            s.checkpointSlot = due;
            newlyDue.push({ source: s, scheduled });
          }
        }
        newlyDue.sort((a, b) => a.scheduled - b.scheduled);
        if (checkpointQueue.length - checkpointHead + newlyDue.length > 2048)
          stop('checkpoint_schedule_queue_budget');
        else checkpointQueue.push(...newlyDue);
        dispatchCheckpoints();
      }
      await sleep(2);
    }
    if (role === 'producer' && !stopping) {
      while (checkpointHead < checkpointQueue.length && !stopping && Date.now() < window.drainAt) {
        dispatchCheckpoints();
        await sleep(2);
      }
      await Promise.allSettled([...done].filter(value => value instanceof Promise));
      await pool(selected, s => checkpoint(s));
      atomic(stateFile, sessions);
    }
    while (Date.now() < window.drainAt && !stopping) await sleep(10);
    clearInterval(heartbeatTimer);
    if (role === 'sdk')
      for (const s of selected) {
        const entry = entryFor(s);
        const message = entry.state?.messages.find(item => item.id === s.messageID);
        const text = message?.content?.[0]?.text;
        const expected = seedText(s) + prefix(entry.last);
        if (sha256(text ?? '') !== sha256(expected)) stats.projectionFailures++;
        entry.projectionHash = sha256(text ?? '');
      }
    if (role === 'producer' && !stopping) {
      await pool(selected, async s => {
        if (s.index < config.streamingSources)
          assert.equal(
            s.counter,
            (config.warmSeconds + config.measuredSeconds) * config.eventHz,
            'Every streaming source must emit every scheduled slot'
          );
        assert.equal(
          s.committed,
          s.counter,
          'Final durable checkpoint must cover every source send'
        );
        const state = await request(s, `/v1/sessions/${s.id}`);
        assert.equal(state.position, s.position);
        assert.equal(state.revision, s.revision);
        const receipt = await request(s, `/v1/sessions/${s.id}/batches`, 'POST', s.lastBatch);
        assertReceiptRetry(s.lastReceipt, receipt);
        const entities = await request(s, `/v1/sessions/${s.id}/entities?limit=100`);
        const value = entities.entities.find(item => item.id === s.messageID)?.value;
        assert.equal(value?.sourceSequence, s.committed);
        assert.equal(
          sha256(JSON.stringify(value)),
          sha256(JSON.stringify(fixture(s, s.committed)))
        );
        stats.reconciledReceipts++;
      });
    }
  }
} catch (error) {
  if (config.mode === 'local')
    stats.localFailureDetail = { name: error.name, message: error.message?.slice(0, 256) };
  stop(error instanceof assert.AssertionError ? 'assertion' : (failure ?? 'runtime'));
  category(failure);
} finally {
  stopping = true;
  clearInterval(sampler);
  clearTimeout(watchdog);
  for (const timer of done) if (!(timer instanceof Promise)) clearInterval(timer);
  for (const controller of controllers) controller.abort();
  for (const entry of live.values()) {
    entry.close?.();
    entry.presenceSocket?.transport.stop();
    entry.runnerSocket?.transport.stop();
  }
  loop.disable();
  if (role === 'producer') atomic(stateFile, sessions);
  stats.failure = failure;
  stats.finished = Date.now();
  stats.window = window;
  stats.eventLoop = { p99ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 };
  stats.pending = {
    remaining: pending.entries.size,
    expired: pending.expired,
    peak: pending.peak,
    limit: pending.limit,
  };
  stats.sessions = [...live.values()].map(entry => ({
    index: entry.sourceIndex,
    receivedThrough: entry.last,
    projectedThrough: entry.projected,
    receivedCount: entry.seen.reduce((a, b) => a + b, 0),
    projectionHash: entry.projectionHash,
    opens: entry.opens,
  }));
  for (const name of [
    'scheduleLag',
    'wireLatency',
    'callbackLatency',
    'scheduledLatency',
    'wireToCallback',
    'listener',
    'requestLatency',
    'sdkQueue',
    'sdkProjection',
    'checkpointQueueLag',
  ])
    stats[name] = summarize(stats[name]);
  stats.cpu = process.cpuUsage();
  stats.memory = process.memoryUsage();
  atomic(`${config.root}/result-${role}-${config.shard}.json`, stats);
  console.log(
    JSON.stringify({
      role,
      shard: config.shard,
      failure,
      sent: stats.sent,
      received: stats.received,
      projectionFailures: stats.projectionFailures,
      pending: stats.pending,
    })
  );
  process.exit(failure || stats.projectionFailures ? 1 : 0);
}
