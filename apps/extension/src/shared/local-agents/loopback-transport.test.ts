/* eslint-disable typescript-eslint/consistent-type-definitions, vitest/no-conditional-in-test -- AGENTS.md prefers type over interface, and the frame assertions branch on handshake phase */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { computeExtensionMac, computeHubMac, decodePairingKey } from './encoding';
import type { LocalAgentExtensionHello } from './envelope';
import { createLoopbackDial } from './loopback-transport';
import type { LoopbackSocketConnect, LoopbackSocketHandlers } from './loopback-transport';
import type { LocalAgentFailure } from './transport-types';

const recordSchema = z.record(z.string(), z.unknown());
const stringRecordSchema = z.record(z.string(), z.string());
const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WS = 'ws://127.0.0.1:47917/__kilo_browser';
const HELLO: LocalAgentExtensionHello = {
  browser: { name: 'Chrome', version: '1' },
  capabilities: {
    console: true,
    dialogs: true,
    fileUpload: true,
    network: true,
    tabGroups: false,
    trustedInput: true,
  },
  contractSha: 'a'.repeat(64),
  extensionVersion: '1.0.4',
  profileLabel: 'Chrome on macOS',
  protocol: [1],
  type: 'ext.hello',
};

type Scheduled = { callback: () => void; delayMs: number; id: number };

type FakeTimers = {
  clearTimeout(handle: number): void;
  runDue(): void;
  scheduled: Scheduled[];
  setTimeout(callback: () => void, delayMs: number): number;
};

const createTimers = (): FakeTimers => {
  const scheduled: Scheduled[] = [];
  let nextId = 0;

  return {
    clearTimeout: (handle: number) => {
      const index = scheduled.findIndex(entry => entry.id === handle);

      if (index !== -1) {
        scheduled.splice(index, 1);
      }
    },
    runDue: () => {
      const [first] = scheduled.splice(0, 1);
      first?.callback();
    },
    scheduled,
    setTimeout: (callback: () => void, delayMs: number) => {
      nextId += 1;
      scheduled.push({ callback, delayMs, id: nextId });

      return nextId;
    },
  };
};

const createHarness = () => {
  const timers = createTimers();
  let handlers: LoopbackSocketHandlers | null = null;
  const sent: string[] = [];
  const closed: number[] = [];
  const failures: LocalAgentFailure[] = [];
  const envelopes: unknown[] = [];
  let ready = 0;
  const connectSocket: LoopbackSocketConnect = (url, socketHandlers) => {
    expect(url).toBe(WS);
    handlers = socketHandlers;

    return {
      close: () => {
        closed.push(1);
      },
      sendText: (text: string) => {
        sent.push(text);
      },
    };
  };
  const handle = createLoopbackDial({
    connectSocket,
    endpoint: { hubId: HUB_ID, key: KEY, ws: WS },
    hello: HELLO,
    timers,
  })({
    onClosed: failure => {
      failures.push(failure);
    },
    onEnvelope: envelope => {
      envelopes.push(envelope);
    },
    onReady: () => {
      ready += 1;
    },
  });

  const push = (frame: Record<string, unknown>) => {
    (handlers as LoopbackSocketHandlers | null)?.onText(JSON.stringify(frame));
  };

  return { closed, envelopes, failures, handle, push, ready: () => ready, sent, timers };
};

describe('loopback transport deadlines', () => {
  it('fails a socket that never opens, because the deadline starts at dial', () => {
    const harness = createHarness();

    expect(harness.timers.scheduled[0]?.delayMs).toBe(10_000);
    harness.timers.runDue();

    expect(harness.failures).toStrictEqual([{ kind: 'transport' }]);
    expect(harness.closed).toHaveLength(1);
  });

  it('verifies auth_ok before it reads hub.hello', async () => {
    const harness = createHarness();
    const keyBytes = decodePairingKey(KEY);

    if (keyBytes === null) {
      throw new Error('test key must decode');
    }

    const nonceH = 'EBESExQVFhcYGRobHB0eHw';
    harness.push({ nonceH, type: 'challenge' });
    await vi.waitFor(() => {
      expect(harness.sent).toHaveLength(1);
    });

    const auth = stringRecordSchema.parse(JSON.parse(harness.sent[0] ?? '{}'));
    const expectedMac = await computeExtensionMac(keyBytes, nonceH, auth['nonceE'] ?? '');
    expect(auth['mac']).toBe(expectedMac);

    // A wrong auth_ok followed by hub.hello must not pass far enough to send ext.hello.
    harness.push({ mac: 'wrong', type: 'auth_ok' });
    harness.push({ hubVersion: '1', mode: 'loopback', protocol: [1], type: 'hub.hello' });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.failures).toStrictEqual([{ kind: 'auth' }]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.ready()).toBe(0);
  });

  it('sends ext.hello once the hub proves the key', async () => {
    const harness = createHarness();
    const keyBytes = decodePairingKey(KEY);

    if (keyBytes === null) {
      throw new Error('test key must decode');
    }

    const nonceH = 'EBESExQVFhcYGRobHB0eHw';
    harness.push({ nonceH, type: 'challenge' });
    await vi.waitFor(() => {
      expect(harness.sent).toHaveLength(1);
    });

    const auth = stringRecordSchema.parse(JSON.parse(harness.sent[0] ?? '{}'));
    const nonceE = auth['nonceE'] ?? '';
    harness.push({ mac: await computeHubMac(keyBytes, nonceE, nonceH), type: 'auth_ok' });
    harness.push({ hubVersion: '1', mode: 'loopback', protocol: [1], type: 'hub.hello' });
    await vi.waitFor(() => {
      expect(harness.ready()).toBe(1);
    });

    const helloFrame = recordSchema.parse(JSON.parse(harness.sent.at(-1) ?? '{}'));
    expect(helloFrame['type']).toBe('ext.hello');
    // Ready clears the deadline, so it never fires afterwards.
    harness.timers.runDue();
    expect(harness.failures).toStrictEqual([]);
  });
});
