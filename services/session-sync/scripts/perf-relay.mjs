import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { sha256 } from './perf-common.mjs';

const [configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
assert.equal(config.mode, 'local');
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
};
const lifetime = Math.min(120000, (config.grantTTLseconds ?? 300) * 1000);
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
    const claims = JSON.parse(
      Buffer.from(request.headers.authorization.split('.')[1], 'base64url')
    );
    const parts = url.pathname.split('/');
    const id = parts[3];
    if (url.pathname.endsWith('/ticket') || url.pathname.endsWith('/live-ticket')) {
      const ticket = crypto.randomUUID();
      tickets.set(ticket, {
        id,
        role: body.role,
        user: claims.sub,
        presence: url.pathname === '/v1/presence/ticket',
      });
      return json(response, { ticket, expiresAt: new Date(Date.now() + 120000).toISOString() });
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
      return json(response, {
        version: 1,
        sessionID: id,
        position: state(id).position,
        revision: state(id).revision,
        deleted: false,
      });
    }
    const s = state(id);
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
  const ticket = tickets.get(protocol?.replace('kilo-session-ticket.', ''));
  if (!ticket) {
    socket.destroy();
    return;
  }
  tickets.delete(protocol.replace('kilo-session-ticket.', ''));
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
    frame(
      ws,
      'hello',
      {
        seq: s?.seq ?? 0,
        runnerConnected: Boolean(s?.runner),
        expiresAt: new Date(Date.now() + lifetime).toISOString(),
        reauthAt: new Date(Date.now() + lifetime - 30000).toISOString(),
        reconnectAfterMs: 1000,
      },
      'control',
      s?.seq ?? 0
    );
    if (s && ticket.role !== 'runner') watch(ticket.id);
    ws.on('message', text => {
      const message = JSON.parse(text.toString());
      if (ticket.presence && message.type === 'heartbeat')
        for (const id of message.advertisement.sessions) watch(id);
      if (message.type === 'reauth')
        frame(ws, 'reauthorized', {
          expiresAt: new Date(Date.now() + lifetime).toISOString(),
          reauthAt: new Date(Date.now() + lifetime - 30000).toISOString(),
        });
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
      if (ticket.presence) presence.delete(ticket.user);
      else {
        s.viewers.delete(ws);
        if (s.runner === ws) s.runner = undefined;
      }
    });
    ws.on('error', () => {});
  });
});
await new Promise(resolve =>
  server.listen(Number(new URL(config.baseURL).port), '127.0.0.1', resolve)
);
console.log('LOCAL_RELAY_READY');
const timer = setTimeout(close, config.stopAt - Date.now());
function close() {
  clearTimeout(timer);
  for (const ws of wss.clients) ws.terminate();
  server.close();
  writeFileSync(
    `${config.root}/relay.json`,
    JSON.stringify({ ...stats, memory: process.memoryUsage(), cpu: process.cpuUsage() })
  );
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
