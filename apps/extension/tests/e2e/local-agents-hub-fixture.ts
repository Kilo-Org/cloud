/* eslint-disable eslint/id-length, eslint/sort-keys, import/no-nodejs-modules, max-lines, typescript-eslint/consistent-type-definitions -- wire field names, fixture object order, and a local HTTP + WebSocket hub; AGENTS.md prefers type over interface */
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import type { WebSocket as ClientWebSocket } from 'ws';

/*
 * A fake loopback hub for the local-agents E2E: it serves the pairing page and
 * speaks just enough WebSocket to run the SPEC handshake, auth, ext.hello, and
 * JSON-RPC envelopes. The framing is hand-rolled so the test adds no runtime
 * dependency to the extension package.
 */

export type FakeHubFrame = Record<string, unknown>;

const frameSchema = z.record(z.string(), z.unknown());

export type FakeHub = {
  close(): Promise<void>;
  connected: boolean;
  frames: FakeHubFrame[];
  origin: string | undefined;
  pairingUrl(hubId: string, token: string): string;
  port: number;
  send(frame: FakeHubFrame): void;
  setAllowedOrigin(origin: string): void;
  setPairing(input: { key: string; token: string }): void;
  wsUrl: string;
};

const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

export const fakeHubBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

export const fakeHubMac = (key: string, message: string): string =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(message, 'utf8').digest('base64url');

export const fakeHubNonce = (fill: number): string =>
  fakeHubBase64Url(new Uint8Array(16).fill(fill));

export const FAKE_HUB_ID = HUB_ID;

type PairingState = {
  allowedOrigin: string | null;
  key: string | null;
  token: string | null;
  wsUrl: string;
};

const startServer = async (state: PairingState): Promise<Server> => {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const { origin } = request.headers;

    if (url.pathname === '/__kilo_browser_pair/key') {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET',
          'access-control-allow-origin': typeof origin === 'string' ? origin : 'null',
        });
        response.end();

        return;
      }

      // A host-permission GET from the extension worker carries no Origin.
      // The token is the capability; a present Origin must still match.
      if (
        state.allowedOrigin === null ||
        (typeof origin === 'string' && origin !== state.allowedOrigin)
      ) {
        response.writeHead(403);
        response.end();

        return;
      }

      if (state.key === null || url.searchParams.get('t') !== state.token) {
        response.writeHead(
          404,
          typeof origin === 'string' ? { 'access-control-allow-origin': origin } : {}
        );
        response.end();

        return;
      }

      response.writeHead(200, {
        ...(typeof origin === 'string' ? { 'access-control-allow-origin': origin } : {}),
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ key: state.key, v: 1, ws: state.wsUrl }));

      return;
    }

    if (url.pathname.startsWith('/__kilo_browser_pair')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>Pairing in progress…</body></html>');

      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return server;
};

export const startFakeHub = async (): Promise<FakeHub> => {
  const state: PairingState = { allowedOrigin: null, key: null, token: null, wsUrl: '' };
  const server = await startServer(state);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const hub: FakeHub = {
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
    connected: false,
    frames: [],
    origin: undefined,
    setAllowedOrigin: () => {
      /* Rebound to the live state below. */
    },
    setPairing: () => {
      /* Rebound to the live state below. */
    },
    pairingUrl: (hubId, token) =>
      `http://127.0.0.1:${port}/__kilo_browser_pair#v=1&hub=${hubId}&t=${encodeURIComponent(token)}&ws=${encodeURIComponent(hub.wsUrl)}`,
    port,
    send: () => {
      /* Rebound to the socket once it opens. */
    },
    wsUrl: `ws://127.0.0.1:${port}/__kilo_browser`,
  };
  state.wsUrl = hub.wsUrl;
  hub.setAllowedOrigin = origin => {
    state.allowedOrigin = origin;
  };
  hub.setPairing = input => {
    state.key = input.key;
    state.token = input.token;
  };

  let socket: ClientWebSocket | null = null;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, stream: Duplex, head: Buffer) => {
    const { origin } = request.headers;

    if (typeof origin !== 'string') {
      stream.destroy();

      return;
    }

    wss.handleUpgrade(request, stream, head, (client: ClientWebSocket) => {
      socket = client;
      hub.origin = origin;
      hub.connected = true;

      client.on('message', (data: Buffer) => {
        hub.frames.push(frameSchema.parse(JSON.parse(data.toString())));
      });
      client.on('close', () => {
        hub.connected = false;
      });
      client.on('error', () => {
        /* The close event drives connection state. */
      });
    });
  });

  hub.send = (frame: FakeHubFrame) => {
    socket?.send(JSON.stringify(frame));
  };

  return hub;
};
