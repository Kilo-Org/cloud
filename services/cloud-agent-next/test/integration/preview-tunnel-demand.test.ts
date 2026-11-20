import { reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_NOT_READY_TEXT,
  PREVIEW_UNAVAILABLE_TEXT,
} from '../../src/preview/container-port-fetch.js';
import { PREVIEW_OUTDATED_RUNTIME_TEXT } from '../../src/preview-tunnel/failures.js';
import {
  connectTunnelPeer,
  previewRequest,
  previewTunnelStub,
  setTunnelLimits,
} from './helpers/preview-tunnel-peer.js';
import { readSandboxAlarm, startTunnelSandbox } from './helpers/preview-tunnel-sandbox.js';
import { waitFor } from './wait-for.js';

afterEach(async () => {
  await reset();
});

describe('PreviewTunnel demand', () => {
  it('asks the bound wrapper for a tunnel and serves the waiting requests on it', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const allocationId = sandbox.allocationId;
    const tunnel = previewTunnelStub(sandbox.sandboxId, allocationId);
    const first = tunnel.fetch(previewRequest('/a', { allocationId }));
    const second = tunnel.fetch(previewRequest('/b', { allocationId }));
    await waitFor(() => expect(sandbox.demands()).toBe(1));
    const peer = await connectTunnelPeer(tunnel, allocationId);
    for (let index = 0; index < 2; index += 1) {
      const open = await peer.takeType('open');
      peer.respond(open.stream, 200, open.open.path);
    }
    expect(await (await first).text()).toBe('/a');
    expect(await (await second).text()).toBe('/b');
    // The two waiting requests shared one demand.
    expect(sandbox.demands()).toBe(1);
    sandbox.wrapper.close();
  });

  it('changes no sandbox activity or alarm while tunnel streams are open', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const allocationId = sandbox.allocationId;
    const tunnel = previewTunnelStub(sandbox.sandboxId, allocationId);
    const readSandbox = async () => {
      const state = await sandbox.stub.getAllocationState();
      return {
        kind: state.kind,
        lastActivityAt: state.lastActivityAt,
        lastFrameAt: state.lastFrameAt,
        alarm: await readSandboxAlarm(sandbox.stub),
      };
    };
    const before = await readSandbox();

    // One HTTP stream whose head the wrapper holds, and one open browser WebSocket.
    const held = tunnel.fetch(previewRequest('/held', { allocationId }));
    await waitFor(() => expect(sandbox.demands()).toBe(1));
    const peer = await connectTunnelPeer(tunnel, allocationId);
    const heldOpen = await peer.takeType('open');
    const upgrade = tunnel.fetch(
      previewRequest('/hmr', { allocationId, headers: { Upgrade: 'websocket' } })
    );
    const wsOpen = await peer.takeType('ws_open');
    peer.send({ type: 'ws_accept', stream: wsOpen.stream, protocol: '' });
    const browser = (await upgrade).webSocket!;
    browser.accept();
    browser.send('update');
    await peer.takeType('ws_text', wsOpen.stream);
    peer.send({ type: 'ws_text', stream: wsOpen.stream, text: 'reload' });
    expect(await readSandbox()).toEqual(before);

    peer.respond(heldOpen.stream, 200, 'done');
    expect(await (await held).text()).toBe('done');
    browser.close(1000, 'page closed');
    await peer.takeType('ws_close', wsOpen.stream);
    expect(await readSandbox()).toEqual(before);
    sandbox.wrapper.close();
  });

  it('answers 409 when the bound wrapper has no tunnel', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: false });
    const tunnel = previewTunnelStub(sandbox.sandboxId, sandbox.allocationId);
    const response = await tunnel.fetch(
      previewRequest('/', { allocationId: sandbox.allocationId })
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(PREVIEW_OUTDATED_RUNTIME_TEXT);
    expect(sandbox.demands()).toBe(0);
    sandbox.wrapper.close();
  });

  it('answers 503 not ready when no wrapper is bound to the allocation', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    expect(await sandbox.stub.requestPreviewTunnel('alloc_other')).toBe('not_ready');
    const unknown = previewTunnelStub('sbx_no_allocation', 'alloc_none');
    const response = await unknown.fetch(previewRequest('/', { allocationId: 'alloc_none' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.text()).toBe(PREVIEW_NOT_READY_TEXT);
    expect(sandbox.demands()).toBe(0);
    sandbox.wrapper.close();
  });

  it('answers 503 when the wrapper does not connect within the wait', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const tunnel = previewTunnelStub(sandbox.sandboxId, sandbox.allocationId);
    await setTunnelLimits(tunnel, { connectWaitMs: 300 });
    const response = await tunnel.fetch(
      previewRequest('/', { allocationId: sandbox.allocationId })
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(PREVIEW_UNAVAILABLE_TEXT);
    expect(sandbox.demands()).toBe(1);
    sandbox.wrapper.close();
  });

  it('keeps a tunnel that is slow to acknowledge one open while it sends other frames', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const allocationId = sandbox.allocationId;
    const tunnel = previewTunnelStub(sandbox.sandboxId, allocationId);
    await setTunnelLimits(tunnel, { ackTimeoutMs: 1_000 });
    const peer = await connectTunnelPeer(tunnel, allocationId);
    peer.autoAck = false;
    const slow = tunnel.fetch(previewRequest('/slow-ack', { allocationId }));
    const slowOpen = await peer.takeType('open');
    // The second open goes out after the first, so its frames prove the tunnel is alive.
    const other = tunnel.fetch(previewRequest('/other', { allocationId }));
    const otherOpen = await peer.takeType('open');
    peer.send({ type: 'credit', stream: otherOpen.stream, bytes: 0 });
    peer.respond(otherOpen.stream, 200, 'other');
    expect(await (await other).text()).toBe('other');
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(peer.closeInfo()).toBeNull();
    peer.respond(slowOpen.stream, 200, 'slow');
    const response = await slow;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('slow');
    expect(sandbox.demands()).toBe(0);
    sandbox.wrapper.close();
  });

  it('closes a tunnel that does not acknowledge with 4002 and asks for a new one', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const allocationId = sandbox.allocationId;
    const tunnel = previewTunnelStub(sandbox.sandboxId, allocationId);
    await setTunnelLimits(tunnel, { ackTimeoutMs: 300 });
    const silent = await connectTunnelPeer(tunnel, allocationId);
    silent.autoAck = false;
    const pending = tunnel.fetch(previewRequest('/retry', { allocationId }));
    await silent.takeType('open');
    expect(await silent.waitForClose()).toMatchObject({ code: 4002 });
    await waitFor(() => expect(sandbox.demands()).toBe(1));
    const fresh = await connectTunnelPeer(tunnel, allocationId);
    const open = await fresh.takeType('open');
    expect(open.open.path).toBe('/retry');
    fresh.respond(open.stream, 200, 'second tunnel');
    expect(await (await pending).text()).toBe('second tunnel');
    sandbox.wrapper.close();
  });
});
