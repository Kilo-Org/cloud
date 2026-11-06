import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { sha256 } from './perf-common.mjs';

const [configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
assert.equal(config.mode, 'local');
const keys = JSON.parse(readFileSync(config.keysFile, 'utf8'));
const signingKey = new TextEncoder().encode(keys.SESSION_SYNC_SECRET);
const heartbeatSchema = z.strictObject({
  type: z.literal('heartbeat'),
  instanceID: z.string().min(1).max(128),
  advertisement: z.strictObject({
    name: z.string().max(256),
    projectName: z.string().max(256),
    version: z.string().max(64),
    kind: z.enum(['cli', 'remote']),
    startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    gitBranch: z.string().max(256).nullable(),
    capabilities: z.array(z.string().min(1).max(64)).max(32),
    sessions: z.array(z.string().min(1).max(128)).max(100),
  }),
});
const sessions = new Map();
const tickets = new Map();
const presence = new Map();
const stats = {
  kind: 'synthetic-local-relay-not-service',
  requests: 0,
  events: 0,
  checkpoints: 0,
  peakBufferedBytes: 0,
  backpressure: 0,
  sockets: 0,
  peakSockets: 0,
  ticketsMinted: 0,
  ticketsConsumed: 0,
  ticketsExpired: 0,
  reauthorized: 0,
  rejectedAuth: 0,
  rejectedReauth: 0,
  rejectedHeartbeat: 0,
};
function pruneTickets() {
  const now = Date.now();
  for (const [id, ticket] of tickets)
    if (ticket.expiresAt <= now) {
      tickets.delete(id);
      stats.ticketsExpired++;
    }
}
function consumeTicket(id, expected) {
  const ticket = tickets.get(id);
  if (!ticket) return undefined;
  tickets.delete(id);
  if (ticket.expiresAt <= Date.now()) {
    stats.ticketsExpired++;
    return undefined;
  }
  stats.ticketsConsumed++;
  if (
    ticket.presence !== expected.presence ||
    ticket.id !== expected.id ||
    (expected.user !== undefined && ticket.user !== expected.user) ||
    (expected.role !== undefined && ticket.role !== expected.role)
  )
    return undefined;
  return ticket;
}
async function authenticate(authorization) {
  try {
    assert(authorization?.startsWith('Bearer '));
    const { payload: claims } = await jwtVerify(authorization.slice(7), signingKey, {
      algorithms: ['HS256'],
      issuer: 'session-sync',
      audience: 'session-sync',
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const now = Math.floor(Date.now() / 1000);
    assert.equal(claims.version, 1);
    assert.equal(claims.env, config.audience);
    assert(Number.isInteger(claims.iat) && claims.iat <= now + 30);
    assert(
      Number.isInteger(claims.exp) && claims.exp > claims.iat && claims.exp - claims.iat <= 300
    );
    assert.equal(claims.tenant?.type, config.organizationID ? 'organization' : 'user');
    assert.equal(claims.tenant?.id, config.organizationID ?? claims.sub);
    return claims;
  } catch {
    stats.rejectedAuth++;
    return undefined;
  }
}
function state(id) {
  const value = sessions.get(id);
  assert(value, 'Session must be registered');
  return value;
}
function frame(socket, type, body, channel = 'control', seq = 0) {
  if (socket.readyState === 1)
    socket.send(JSON.stringify({ v: 1, channel, seq, from: 'server', at: Date.now(), type, body }));
}
function watch(id) {
  const s = state(id);
  const socket = presence.get(s.user);
  if (socket) frame(socket, 'watch', { sessionID: id, watching: s.viewers.size > 0 });
}
function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
  try {
    stats.requests++;
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
      assert(chunks.reduce((n, part) => n + part.length, 0) <= 512 * 1024);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const url = new URL(request.url, config.baseURL);
    const claims = await authenticate(request.headers.authorization);
    if (!claims) return json(response, { error: { code: 'invalid_grant' } }, 401);
    const parts = url.pathname.split('/');
    const id = parts[3];
    if (url.pathname.endsWith('/ticket') || url.pathname.endsWith('/live-ticket')) {
      const isPresence = url.pathname === '/v1/presence/ticket';
      assert(['runner', 'viewer', 'controller'].includes(body.role));
      if (!isPresence) assert.equal(state(id).user, claims.sub);
      const ticket = crypto.randomUUID();
      const expiresAt = Math.min(Date.now() + 120000, claims.exp * 1000);
      tickets.set(ticket, {
        id: isPresence ? undefined : id,
        role: body.role,
        user: claims.sub,
        presence: isPresence,
        expiresAt,
      });
      stats.ticketsMinted++;
      return json(response, { ticket, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (request.method === 'PUT') {
      if (!sessions.has(id))
        sessions.set(id, {
          source: body.sourceID,
          user: claims.sub,
          position: 0,
          revision: 0,
          seq: 0,
          viewers: new Set(),
          receipts: new Map(),
        });
      assert.equal(state(id).user, claims.sub);
      return json(response, {
        version: 1,
        sessionID: id,
        position: state(id).position,
        revision: state(id).revision,
        deleted: false,
      });
    }
    const s = state(id);
    assert.equal(s.user, claims.sub);
    if (url.pathname.endsWith('/batches')) {
      const previous = s.receipts.get(body.batchID);
      if (previous) {
        assert.equal(previous.hash, sha256(JSON.stringify(body)));
        return json(response, previous.receipt);
      }
      assert.equal(body.sourceID, s.source);
      assert.equal(body.after, s.position);
      s.value = body.changes[0].value;
      s.position = body.through;
      s.revision++;
      stats.checkpoints++;
      const receipt = {
        version: 1,
        sessionID: id,
        batchID: body.batchID,
        after: body.after,
        through: s.position,
        revision: s.revision,
        changes: body.changes.length,
        digest: sha256(JSON.stringify(body)),
        committedAt: Date.now(),
      };
      s.receipts.set(body.batchID, { hash: sha256(JSON.stringify(body)), receipt });
      if (s.receipts.size > 256) s.receipts.delete(s.receipts.keys().next().value);
      return json(response, receipt);
    }
    if (url.pathname.endsWith('/entities'))
      return json(response, {
        version: 1,
        sessionID: id,
        position: s.position,
        revision: s.revision,
        entities: [
          { kind: 'message', id: s.value.message.id, revision: s.revision, value: s.value },
        ],
        next: null,
      });
    return json(response, {
      version: 1,
      sessionID: id,
      position: s.position,
      revision: s.revision,
      deleted: false,
    });
  } catch {
    json(response, { error: { code: 'local_fixture_error' } }, 500);
  }
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 });
server.on('upgrade', (request, socket, head) => {
  const protocol = request.headers['sec-websocket-protocol'];
  const url = new URL(request.url, config.baseURL);
  const isPresence = url.pathname === '/v1/presence';
  const id = isPresence ? undefined : /^\/v1\/sessions\/([^/]+)\/live$/.exec(url.pathname)?.[1];
  const ticket =
    typeof protocol === 'string' &&
    protocol.startsWith('kilo-session-ticket.') &&
    (isPresence || id !== undefined)
      ? consumeTicket(protocol.slice('kilo-session-ticket.'.length), { presence: isPresence, id })
      : undefined;
  if (!ticket) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => {
    stats.sockets++;
    stats.peakSockets = Math.max(stats.peakSockets, stats.sockets);
    const s = ticket.presence ? undefined : state(ticket.id);
    if (ticket.presence) presence.set(ticket.user, ws);
    else if (ticket.role === 'runner') {
      s.runner = ws;
      for (const viewer of s.viewers)
        frame(viewer, 'runner_status', { runnerConnected: true }, 'control', s.seq);
    } else s.viewers.add(ws);
    let expiryTimer;
    const lifetime = () => {
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(
        () => ws.close(1008, 'ticket_expired'),
        ticket.expiresAt - Date.now()
      );
      return {
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        reauthAt: new Date(ticket.expiresAt - 30000).toISOString(),
      };
    };
    frame(
      ws,
      'hello',
      {
        seq: s?.seq ?? 0,
        runnerConnected: Boolean(s?.runner),
        ...lifetime(),
        reconnectAfterMs: 1000,
      },
      'control',
      s?.seq ?? 0
    );
    if (s && ticket.role !== 'runner') watch(ticket.id);
    ws.on('message', text => {
      let message;
      try {
        message = JSON.parse(text.toString());
      } catch {
        frame(ws, 'error', { code: 'invalid_request' });
        return;
      }
      if (ticket.expiresAt <= Date.now()) {
        if (message.type === 'reauth') stats.rejectedReauth++;
        frame(ws, 'error', { code: 'invalid_ticket' });
        ws.close(1008, 'ticket_expired');
        return;
      }
      if (ticket.presence && message.type === 'heartbeat') {
        const parsed = heartbeatSchema.safeParse(message);
        if (
          !parsed.success ||
          parsed.data.advertisement.sessions.some(id => sessions.get(id)?.user !== ticket.user)
        ) {
          stats.rejectedHeartbeat++;
          frame(ws, 'error', { code: 'invalid_request' });
          return;
        }
        for (const id of parsed.data.advertisement.sessions) watch(id);
      }
      if (message.type === 'reauth') {
        const next = consumeTicket(message.ticket, ticket);
        if (!next) {
          stats.rejectedReauth++;
          frame(ws, 'error', { code: 'invalid_ticket' });
          ws.close(1008, 'invalid_ticket');
          return;
        }
        ticket.expiresAt = next.expiresAt;
        stats.reauthorized++;
        frame(ws, 'reauthorized', lifetime());
      }
      if (s && ticket.role === 'runner' && message.channel === 'events') {
        stats.events++;
        s.seq++;
        const encoded = JSON.stringify({
          v: 1,
          seq: s.seq,
          channel: 'events',
          from: ticket.user,
          at: Date.now(),
          type: message.type,
          body: message.body,
        });
        for (const viewer of s.viewers)
          if (viewer.subscribed && viewer.readyState === 1) {
            stats.peakBufferedBytes = Math.max(stats.peakBufferedBytes, viewer.bufferedAmount);
            if (viewer.bufferedAmount > 1048576) {
              stats.backpressure++;
              viewer.close(1009);
            } else viewer.send(encoded);
          }
      }
      if (message.type === 'subscribe') ws.subscribed = true;
    });
    ws.on('close', () => {
      stats.sockets--;
      clearTimeout(expiryTimer);
      if (ticket.presence) presence.delete(ticket.user);
      else {
        s.viewers.delete(ws);
        if (s.runner === ws) s.runner = undefined;
        watch(ticket.id);
      }
    });
    ws.on('error', () => {});
  });
});
await new Promise(resolve =>
  server.listen(Number(new URL(config.baseURL).port), '127.0.0.1', resolve)
);
console.log(`LOCAL_RELAY_READY ${server.address().port}`);
const ticketPruner = setInterval(pruneTickets, 1000);
const timer = setTimeout(close, config.stopAt - Date.now());
function close() {
  clearTimeout(timer);
  clearInterval(ticketPruner);
  for (const ws of wss.clients) ws.terminate();
  server.close();
  writeFileSync(
    `${config.root}/relay.json`,
    JSON.stringify({
      ...stats,
      ticketsRemaining: tickets.size,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    })
  );
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
