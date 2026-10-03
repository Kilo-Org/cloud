import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerWebSocket } from 'bun';
import { createControlPlaneConnection } from '../../wrapper/src/control-plane/connection.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  controlPlaneWrapperFrameSchema,
} from '../../src/shared/control-plane-protocol.js';
import { resolveControlPlaneTimers } from '../../src/shared/control-plane-timers.js';

const timers = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '100' });
const budgetMs = 3_000;

async function run(mode: 'bidirectional-drop' | 'uplink-drop' | 'downlink-drop'): Promise<void> {
  let peerError: Error | undefined;

  async function until(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!predicate()) {
      if (peerError) throw peerError;
      if (Date.now() >= deadline) throw new Error(`${label}: exceeded ${budgetMs}ms`);
      await delay(10);
    }
    if (peerError) throw peerError;
  }

  let accepts = 0;
  let connected = 0;
  let disconnected = 0;
  let dropped = 0;
  let droppedUplink = 0;
  let droppedDownlink = 0;
  let cutHeartbeats = 0;
  let cutDownlinkFrames = 0;
  let heartbeats = 0;
  let blackholed: ServerWebSocket<{ index: number }> | undefined;
  let cut = false;
  const identities: string[] = [];
  const closeBeforeCut: number[] = [];
  const logs: string[] = [];
  const disconnectReasons: string[] = [];

  const sockets = new Set<ServerWebSocket<{ index: number }>>();
  const boundSockets = new WeakSet<ServerWebSocket<{ index: number }>>();
  const peer = Bun.serve<{ index: number }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (request.headers.get('authorization') !== 'Bearer test-owned-local-credential') {
        return new Response('Unauthorized', { status: 401 });
      }
      if (server.upgrade(request, { data: { index: accepts + 1 } })) return;
      return new Response('WebSocket required', { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      open(socket) {
        accepts += 1;
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
        if (!cut) closeBeforeCut.push(socket.data.index);
      },
      message(socket, bytes) {
        try {
          if (socket === blackholed && mode !== 'downlink-drop') {
            dropped += 1;
            droppedUplink += 1;
            return;
          }
          const parsed = controlPlaneWrapperFrameSchema.safeParse(JSON.parse(bytes.toString()));
          assert(parsed.success, 'actual wrapper emitted an invalid frame');
          const frame = parsed.data;
          if (frame.type === 'hello') {
            if (boundSockets.has(socket) || frame.heartbeatAck !== true) return;
            boundSockets.add(socket);
            identities.push(`${frame.wrapperId}/${frame.allocationId}`);
            sendDownlink(socket, {
              type: 'welcome',
              protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
              heartbeatAck: true,
            });
          } else if (frame.type === 'heartbeat') {
            heartbeats += 1;
            if (socket === blackholed) cutHeartbeats += 1;
            sendDownlink(socket, { type: 'heartbeat_ack' });
          }
        } catch (error) {
          peerError ??= error instanceof Error ? error : new Error(String(error));
        }
      },
    },
  });

  function sendDownlink(socket: ServerWebSocket<{ index: number }>, frame: object): void {
    if (socket === blackholed && mode !== 'uplink-drop') {
      dropped += 1;
      droppedDownlink += 1;
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      peerError ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  const downlinkTraffic = setInterval(() => {
    for (const socket of sockets) {
      sendDownlink(socket, { type: 'events_dropped', dropped: 0 });
    }
  }, timers.wrapper.heartbeatIntervalMs);

  const connection = createControlPlaneConnection({
    url: `ws://127.0.0.1:${peer.port}`,
    credential: 'test-owned-local-credential',
    allocationId: 'test-owned-allocation',
    timers,
    random: () => 0,
    getHeartbeat: () => ({ active: true, degraded: false }),
    onConnected: () => {
      connected += 1;
    },
    onDisconnected: reason => {
      disconnected += 1;
      disconnectReasons.push(reason);
    },
    onFrame: () => {
      if (cut && accepts === 1) cutDownlinkFrames += 1;
    },
    log: message => logs.push(message),
  });

  try {
    connection.start();
    await until(() => connected === 1 && heartbeats >= 2, 'healthy welcome and heartbeats');
    await delay(timers.wrapper.heartbeatAckTimeoutMs * 2);
    assert.equal(accepts, 1, 'healthy connection must not reconnect');
    assert.deepEqual(closeBeforeCut, [], 'healthy peer must remain open');
    blackholed = [...sockets][0];
    assert(blackholed);
    assert.equal(blackholed.readyState, WebSocket.OPEN);
    cut = true;
    const cutAt = Date.now();
    await until(
      () => accepts >= 2 && connected >= 2,
      'autonomous reconnect after application-frame blackhole'
    );
    const reconnectMs = Date.now() - cutAt;
    assert(dropped > 0, 'the peer must actually drop application frames');
    assert.equal(
      new Set(identities).size,
      1,
      'reconnect must preserve wrapper/allocation identity'
    );
    assert.equal(disconnected, 1);
    assert.deepEqual(disconnectReasons, ['heartbeat acknowledgement timeout']);
    if (mode === 'uplink-drop') {
      assert(droppedUplink > 0 && cutDownlinkFrames > 0, 'downlink must survive the uplink cut');
      assert.equal(droppedDownlink, 0);
    } else if (mode === 'downlink-drop') {
      assert(droppedDownlink > 0 && cutHeartbeats > 0, 'uplink must survive the downlink cut');
      assert.equal(droppedUplink, 0);
    } else {
      assert(droppedUplink > 0 && droppedDownlink > 0, 'both application directions must drop');
    }
    const recoveredAccepts = accepts;
    const recoveredHeartbeats = heartbeats;
    await until(() => heartbeats >= recoveredHeartbeats + 2, 'recovered heartbeat delivery');
    await delay(timers.wrapper.heartbeatAckTimeoutMs * 2);
    assert.equal(accepts, recoveredAccepts, 'healthy recovered connection must remain stable');
    assert(!logs.some(message => message.includes('invalid frame')), 'peer frames must be valid');
    if (peerError) throw peerError;
    console.log(
      JSON.stringify({
        mode,
        ok: true,
        accepts,
        connected,
        disconnected,
        dropped,
        droppedUplink,
        droppedDownlink,
        cutHeartbeats,
        cutDownlinkFrames,
        reconnectMs,
        heartbeatAckTimeoutMs: timers.wrapper.heartbeatAckTimeoutMs,
        scope: 'actual Bun wrapper connection only; not full wrapper/DO/held-turn acceptance',
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        mode,
        ok: false,
        accepts,
        connected,
        disconnected,
        dropped,
        error: error instanceof Error ? error.message : String(error),
        logs,
      })
    );
    process.exitCode = 1;
  } finally {
    clearInterval(downlinkTraffic);
    connection.close();
    await peer.stop(true);
  }
}

await run('bidirectional-drop');
await run('uplink-drop');
await run('downlink-drop');
