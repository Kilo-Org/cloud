import { afterEach, describe, expect, it } from 'bun:test';
import { WrapperState } from './state';
import type { WrapperKiloClient } from './kilo-api';
import {
  buildKiloGlobalFeedWebSocketUrl,
  openKiloGlobalFeed,
  parseSseDataStream,
} from './global-feed';

type GlobalFeedWebSocketImpl = NonNullable<
  Parameters<typeof openKiloGlobalFeed>[0]['WebSocketImpl']
>;

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function asFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static initialBufferedAmount = 0;

  readonly url: string;
  readonly options?: { headers?: Record<string, string> } | string | string[];
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = FakeWebSocket.initialBufferedAmount;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string, options?: { headers?: Record<string, string> } | string | string[]) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(
      new CloseEvent('close', {
        code: 1000,
        reason: '',
      })
    );
  }
}

function bindGlobalFeedSession(state: WrapperState): void {
  state.bindSession({
    kiloSessionId: 'kilo_root_1',
    ingestUrl: 'wss://worker.example.com/sessions/user_1/agent_1/ingest',
    workerAuthToken: 'worker-token',
    wrapperRunId: 'wr_run_1',
    wrapperGeneration: 7,
    wrapperConnectionId: 'conn_1',
    agentSessionId: 'agent_1',
  });
}

function makeKiloClient(serverUrl = 'http://127.0.0.1:4321'): WrapperKiloClient {
  return { serverUrl } as WrapperKiloClient;
}

afterEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.initialBufferedAmount = 0;
});

describe('buildKiloGlobalFeedWebSocketUrl', () => {
  it('uses the fenced global ingest path and identity query parameters', () => {
    const state = new WrapperState();
    bindGlobalFeedSession(state);

    const url = new URL(buildKiloGlobalFeedWebSocketUrl(state.currentSession!));

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/sessions/user_1/agent_1/kilo-global-ingest');
    expect(url.searchParams.get('kiloSessionId')).toBe('kilo_root_1');
    expect(url.searchParams.get('wrapperRunId')).toBe('wr_run_1');
    expect(url.searchParams.get('wrapperGeneration')).toBe('7');
    expect(url.searchParams.get('wrapperConnectionId')).toBe('conn_1');
  });
});

describe('parseSseDataStream', () => {
  it('yields data frames across chunks and supports multiline data fields', async () => {
    const stream = streamFromChunks([
      'event: message\ndata: {"one":',
      '1}\n\n:data ignored\ndata: line-a\n',
      'data: line-b\n\n',
    ]);

    const frames: string[] = [];
    for await (const frame of parseSseDataStream(stream)) {
      frames.push(frame);
    }

    expect(frames).toEqual(['{"one":1}', 'line-a\nline-b']);
  });

  it('recognizes CRLF frame boundaries split after a carriage return', async () => {
    const stream = streamFromChunks([
      'data: line-a\r\n',
      'data: line-b\r',
      '\n\r\n',
      'data: {"next":true}\r\n\r',
      '\n',
    ]);

    const frames: string[] = [];
    for await (const frame of parseSseDataStream(stream)) {
      frames.push(frame);
    }

    expect(frames).toEqual(['line-a\nline-b', '{"next":true}']);
  });

  it('yields a final data frame when the stream ends without a blank-line delimiter', async () => {
    const frames: string[] = [];
    for await (const frame of parseSseDataStream(streamFromChunks(['data: final\r\n']))) {
      frames.push(frame);
    }

    expect(frames).toEqual(['final']);
  });
});

describe('openKiloGlobalFeed', () => {
  it('streams substantive Kilo global events to the fenced worker WebSocket', async () => {
    const state = new WrapperState();
    bindGlobalFeedSession(state);
    const fetchedUrls: string[] = [];
    const fetchImpl = asFetch(async input => {
      fetchedUrls.push(input instanceof Request ? input.url : input.toString());
      return new Response(
        streamFromChunks([
          'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
          'data: not-json\n\n',
          'data: {"directory":"/workspace/root","payload":{"type":"message.updated","properties":{"id":"msg_1"}}}\n\n',
          'data: {"payload":{"type":"server.heartbeat","properties":{}}}\n\n',
          'data: {"directory":"/workspace/child","payload":{"type":"session.idle","properties":{"sessionID":"child"}}}\n\n',
        ]),
        { status: 200 }
      );
    });

    const connection = openKiloGlobalFeed({
      state,
      kiloClient: makeKiloClient(),
      fetchImpl,
      WebSocketImpl: FakeWebSocket as unknown as GlobalFeedWebSocketImpl,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    connection.close();
    await connection.done;

    const ws = FakeWebSocket.instances[0];
    expect(fetchedUrls[0]).toBe('http://127.0.0.1:4321/global/event');
    expect(ws.url).toContain('/sessions/user_1/agent_1/kilo-global-ingest');
    expect((ws.options as { headers?: Record<string, string> }).headers).toEqual({
      Authorization: 'Bearer worker-token',
    });
    expect(ws.sent).toEqual([
      JSON.stringify({
        directory: '/workspace/root',
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      }),
      JSON.stringify({
        directory: '/workspace/child',
        payload: { type: 'session.idle', properties: { sessionID: 'child' } },
      }),
    ]);
  });

  it('forwards substantive events from a CRLF feed split between delimiter bytes', async () => {
    const state = new WrapperState();
    bindGlobalFeedSession(state);
    const fetchImpl = asFetch(async () => {
      return new Response(
        streamFromChunks([
          'data: {"payload":{"type":"server.connected","properties":{}}}\r',
          '\n\r',
          '\n',
          'data: {"directory":"/workspace/root","payload":{"type":"message.updated","properties":{"id":"msg_crlf"}}}\r',
          '\n\r',
          '\n',
        ]),
        { status: 200 }
      );
    });

    const connection = openKiloGlobalFeed({
      state,
      kiloClient: makeKiloClient(),
      fetchImpl,
      WebSocketImpl: FakeWebSocket as unknown as GlobalFeedWebSocketImpl,
      retryDelayMs: 60_000,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    connection.close();
    await connection.done;

    expect(FakeWebSocket.instances[0].sent).toEqual([
      JSON.stringify({
        directory: '/workspace/root',
        payload: { type: 'message.updated', properties: { id: 'msg_crlf' } },
      }),
    ]);
  });

  it('does not buffer frames when the worker WebSocket is backed up', async () => {
    const state = new WrapperState();
    bindGlobalFeedSession(state);
    FakeWebSocket.initialBufferedAmount = Number.MAX_SAFE_INTEGER;
    const fetchImpl = asFetch(async () => {
      return new Response(
        streamFromChunks([
          'data: {"directory":"/workspace/root","payload":{"type":"message.updated","properties":{"id":"msg_1"}}}\n\n',
        ]),
        { status: 200 }
      );
    });

    const connection = openKiloGlobalFeed({
      state,
      kiloClient: makeKiloClient(),
      fetchImpl,
      WebSocketImpl: FakeWebSocket as unknown as GlobalFeedWebSocketImpl,
      retryDelayMs: 60_000,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    connection.close();
    await connection.done;

    expect(FakeWebSocket.instances[0].sent).toEqual([]);
  });

  it('restarts the global feed after the private Kilo SSE stream ends', async () => {
    const state = new WrapperState();
    bindGlobalFeedSession(state);
    let fetchCount = 0;
    let secondFetchStarted: (() => void) | undefined;
    const secondFetch = new Promise<void>(resolve => {
      secondFetchStarted = resolve;
    });
    const fetchImpl = asFetch(async () => {
      fetchCount += 1;
      if (fetchCount === 2) {
        secondFetchStarted?.();
      }
      return new Response(
        streamFromChunks([
          `data: {"directory":"/workspace/${fetchCount}","payload":{"type":"message.updated","properties":{"id":"msg_${fetchCount}"}}}\n\n`,
        ]),
        { status: 200 }
      );
    });

    const connection = openKiloGlobalFeed({
      state,
      kiloClient: makeKiloClient(),
      fetchImpl,
      WebSocketImpl: FakeWebSocket as unknown as GlobalFeedWebSocketImpl,
    });

    await secondFetch;
    await new Promise(resolve => setTimeout(resolve, 0));
    connection.close();
    await connection.done;

    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(FakeWebSocket.instances.flatMap(instance => instance.sent)).toContain(
      JSON.stringify({
        directory: '/workspace/2',
        payload: { type: 'message.updated', properties: { id: 'msg_2' } },
      })
    );
  });
});
