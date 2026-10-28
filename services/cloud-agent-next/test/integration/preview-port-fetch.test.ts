import { getSandbox } from '@cloudflare/sandbox';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PreviewPortTestDO } from './helpers/preview-port-test-do.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    PREVIEW_PORT_TEST: DurableObjectNamespace<PreviewPortTestDO>;
  }
}

function marked(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:5173${path}`, {
    headers: { 'x-kilo-preview-port': '5173', ...headers },
  });
}

function sandboxFor(name: string) {
  return getSandbox(env.PREVIEW_PORT_TEST, name);
}

describe('preview port fetch over stub.fetch (fake getTcpPort)', () => {
  it('streams a response body across a getSandbox-wrapped fetch boundary', async () => {
    const response = await sandboxFor('stream').fetch(marked('/stream'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    await expect(response.text()).resolves.toBe('chunk-1|chunk-2');
  });

  it('delivers the first chunk before the origin produces the rest', async () => {
    const stub = env.PREVIEW_PORT_TEST.getByName('gated');
    const response = await stub.fetch(marked('/gated'));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const first = await reader!.read();
    expect(decoder.decode(first.value)).toBe('chunk-1');

    const secondRead = reader!.read();
    const raced = await Promise.race([
      secondRead.then(() => 'chunk' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(raced).toBe('timeout');

    await stub.releaseStream();
    const second = await secondRead;
    expect(decoder.decode(second.value)).toBe('chunk-2');
    await expect(reader!.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('bridges a container WebSocket 101 across a getSandbox-wrapped fetch boundary', async () => {
    const response = await sandboxFor('ws').fetch(marked('/ws', { Upgrade: 'websocket' }));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no echo')), 5000);
      socket!.addEventListener('message', event => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
      socket!.send('hi');
    });
    expect(echoed).toBe('echo:hi');
    socket!.close();
  });

  it('propagates a binary frame and a close inside the DO isolate', async () => {
    const stub = env.PREVIEW_PORT_TEST.getByName('ws-isolate');
    const observed = await runInDurableObject(stub, async instance => {
      const response = await instance.fetchPreview('/ws');
      const socket = response.webSocket;
      if (socket === null) return { status: response.status, binary: null, close: null };
      socket.accept();
      const binary = await new Promise<string>(resolve => {
        socket.addEventListener('message', event => resolve(String(event.data)));
        socket.send(new Uint8Array([1, 2, 3, 4]).buffer);
      });
      const close = await new Promise<number>(resolve => {
        socket.addEventListener('close', event => resolve(event.code));
        socket.send('close-me');
      });
      return { status: response.status, binary, close };
    });
    expect(observed).toEqual({ status: 101, binary: 'bin:4', close: 1000 });
  });

  it('maps a closed container port to 502 across the stub boundary', async () => {
    const stub = env.PREVIEW_PORT_TEST.getByName('refused');
    const response = await stub.fetch(marked('/refused'));
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe('Nothing is listening on that port');
  });

  it('refuses a request without the marker', async () => {
    const stub = env.PREVIEW_PORT_TEST.getByName('unmarked');
    const response = await stub.fetch(new Request('http://localhost:5173/stream'));
    expect(response.status).toBe(400);
  });
});
