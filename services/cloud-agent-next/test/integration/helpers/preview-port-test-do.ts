import { DurableObject } from 'cloudflare:workers';
import {
  fetchPreviewPort,
  type PreviewContainerPort,
} from '../../../src/preview/container-port-fetch.js';

async function binaryLength(data: unknown): Promise<number> {
  if (data instanceof Blob) return (await data.arrayBuffer()).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

let releaseGatedStream: (() => void) | null = null;

function fakeContainer(): PreviewContainerPort {
  return {
    running: true,
    getTcpPort: () => ({
      fetch: async (url: string) => {
        const path = new URL(url).pathname;
        if (path === '/ws') {
          const pair = new WebSocketPair();
          const server = pair[1];
          server.accept();
          server.addEventListener('message', event => {
            if (event.data === 'close-me') {
              server.close(1000, 'bye');
              return;
            }
            if (typeof event.data === 'string') {
              server.send(`echo:${event.data}`);
              return;
            }
            void binaryLength(event.data).then(length => server.send(`bin:${length}`));
          });
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        if (path === '/refused') {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5173');
        }
        if (path === '/gated') {
          const gate = new Promise<void>(resolve => {
            releaseGatedStream = resolve;
          });
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('chunk-1'));
              await gate;
              controller.enqueue(new TextEncoder().encode('chunk-2'));
              controller.close();
            },
          });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk-1|'));
            controller.enqueue(new TextEncoder().encode('chunk-2'));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      },
    }),
  };
}

export class PreviewPortTestDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const marker = request.headers.get('x-kilo-preview-port');
    if (marker === null) return new Response('No marker', { status: 400 });
    return fetchPreviewPort(fakeContainer(), Number.parseInt(marker, 10), request, () => false);
  }

  fetchPreview(path: string): Promise<Response> {
    return this.fetch(
      new Request(`http://localhost:5173${path}`, {
        headers: { 'x-kilo-preview-port': '5173', Upgrade: 'websocket' },
      })
    );
  }

  releaseStream(): void {
    releaseGatedStream?.();
    releaseGatedStream = null;
  }
}
