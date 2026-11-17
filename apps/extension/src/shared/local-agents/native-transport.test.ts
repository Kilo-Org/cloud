/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { describe, expect, it } from 'vitest';
import {
  classifyNativeMessagingError,
  createNativeDial,
  NATIVE_MESSAGING_HOST_NAME,
} from './native-transport';
import type { NativeMessagingPort } from './native-transport';
import type { LocalAgentExtensionHello } from './envelope';
import type { LocalAgentFailure, LocalAgentTimers } from './transport-types';

const HELLO: LocalAgentExtensionHello = {
  browser: { name: 'Firefox', version: '141' },
  capabilities: {
    console: true,
    dialogs: true,
    fileUpload: true,
    network: true,
    tabGroups: true,
    trustedInput: false,
  },
  contractSha: 'b'.repeat(64),
  extensionVersion: '1.0.4',
  profileLabel: 'Firefox on macOS',
  protocol: [1],
  type: 'ext.hello',
};

type Scheduled = { callback: () => void; delayMs: number; id: number };

const createTimers = (): {
  clearTimeout(handle: number): void;
  runDue(): void;
  scheduled: Scheduled[];
  setTimeout(callback: () => void, delayMs: number): number;
} => {
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

const createPort = () => {
  const messages: unknown[] = [];
  const disconnectListeners: (() => void)[] = [];
  const messageListeners: ((message: unknown) => void)[] = [];
  let disconnected = 0;
  const port: NativeMessagingPort = {
    disconnect: () => {
      disconnected += 1;
    },
    onDisconnect: {
      addListener: listener => {
        disconnectListeners.push(listener);
      },
    },
    onMessage: {
      addListener: listener => {
        messageListeners.push(listener);
      },
    },
    postMessage: (message: unknown) => {
      messages.push(message);
    },
  };

  return {
    disconnected: () => disconnected,
    messages,
    port,
    receive: (message: unknown) => {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
  };
};

const createHarness = () => {
  const timers = createTimers();
  const port = createPort();
  const failures: LocalAgentFailure[] = [];
  let ready = 0;

  createNativeDial({
    hello: HELLO,
    runtime: {
      connectNative: hostName => {
        expect(hostName).toBe(NATIVE_MESSAGING_HOST_NAME);

        return port.port;
      },
    },
    timers: timers satisfies LocalAgentTimers,
  })({
    onClosed: failure => {
      failures.push(failure);
    },
    onEnvelope: () => {
      // No envelopes in these cases.
    },
    onReady: () => {
      ready += 1;
    },
  });

  return { failures, port, ready: () => ready, timers };
};

describe('native transport', () => {
  it('fails a silent host after the handshake deadline', () => {
    const harness = createHarness();

    expect(harness.timers.scheduled[0]?.delayMs).toBe(10_000);
    harness.timers.runDue();

    expect(harness.failures).toStrictEqual([{ kind: 'transport' }]);
    expect(harness.port.disconnected()).toBe(1);
  });

  it('clears the deadline once hub.hello arrives', () => {
    const harness = createHarness();

    harness.port.receive({ hubVersion: '1', mode: 'native', protocol: [1], type: 'hub.hello' });

    expect(harness.ready()).toBe(1);
    expect(harness.port.messages).toHaveLength(1);
    harness.timers.runDue();
    expect(harness.failures).toStrictEqual([]);
  });

  it('classifies a missing and a forbidden host', () => {
    expect(
      classifyNativeMessagingError('Specified native messaging host not found.')
    ).toStrictEqual({
      kind: 'host_missing',
      reason: 'not_installed',
    });
    expect(
      classifyNativeMessagingError('No such native application ai.kilo.browser_host')
    ).toStrictEqual({ kind: 'host_missing', reason: 'not_installed' });
    expect(
      classifyNativeMessagingError('Access to the specified native messaging host is forbidden.')
    ).toStrictEqual({ kind: 'host_missing', reason: 'permission_denied' });
    expect(classifyNativeMessagingError('host exited')).toStrictEqual({ kind: 'transport' });
  });
});
