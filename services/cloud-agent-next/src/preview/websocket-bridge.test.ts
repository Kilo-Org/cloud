import { describe, expect, it } from 'vitest';
import { bridgeSockets } from './websocket-bridge.js';

type Listener = (event: unknown) => void;

/** Mirrors workerd: `close()` throws once this side has closed or on an unsendable frame. */
class FakeSocket {
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  private closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  accept(): void {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    if (this.closed) throw new TypeError('WebSocket already closed');
    if (code === 1005 || code === 1006 || code === 1015) throw new TypeError('Invalid close code');
    if (new TextEncoder().encode(reason).length > 123) throw new TypeError('Reason too long');
    this.closed = true;
    this.closes.push({ code, reason });
  }

  /** A close frame from the far side; workerd replies to it, so this side is closed too. */
  receiveClose(code: number, reason: string): void {
    this.closed = true;
    this.emit('close', { code, reason });
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function bridge(): { browser: FakeSocket; container: FakeSocket } {
  const browser = new FakeSocket();
  const container = new FakeSocket();
  bridgeSockets(browser as unknown as WebSocket, container as unknown as WebSocket);
  return { browser, container };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

describe('bridgeSockets', () => {
  it('keeps frame order when a Blob frame is followed by a text frame', async () => {
    const { browser, container } = bridge();
    container.emit('message', { data: new Blob([new Uint8Array([1, 2, 3])]) });
    container.emit('message', { data: 'after' });
    await settle();
    expect(browser.sent).toHaveLength(2);
    expect(new Uint8Array(browser.sent[0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(browser.sent[1]).toBe('after');
  });

  it('does not throw when the close echoes back to a side that already closed', () => {
    const { browser, container } = bridge();
    container.receiveClose(1000, 'done');
    expect(browser.closes).toEqual([{ code: 1000, reason: 'done' }]);
    expect(() => browser.receiveClose(1000, 'done')).not.toThrow();
    expect(container.closes).toEqual([]);
  });

  it.each([1005, 1006, 1015, 999, 5000])('sends close code %i to the peer as 1000', code => {
    const { browser, container } = bridge();
    container.receiveClose(code, '');
    expect(browser.closes).toEqual([{ code: 1000, reason: '' }]);
  });

  it('keeps an application close code', () => {
    const { browser, container } = bridge();
    container.receiveClose(4001, 'app');
    expect(browser.closes).toEqual([{ code: 4001, reason: 'app' }]);
  });

  it('cuts a close reason to 123 bytes without splitting a character', () => {
    const { browser, container } = bridge();
    container.receiveClose(1000, 'é'.repeat(100));
    const reason = browser.closes[0]?.reason ?? '';
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(123);
    expect(reason).toBe('é'.repeat(61));
  });

  it('closes the source with 1011 when a send to the peer fails', async () => {
    const { browser, container } = bridge();
    container.send = () => {
      throw new Error('send failed');
    };
    browser.emit('message', { data: 'hello' });
    await settle();
    expect(browser.closes).toEqual([
      { code: 1011, reason: 'Failed to forward message to container' },
    ]);
  });
});
