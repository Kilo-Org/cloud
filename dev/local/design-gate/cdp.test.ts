import assert from 'node:assert/strict';
import test from 'node:test';

import { expandSamples, InfraError } from './capture';
import {
  createProbeClient,
  openSession,
  parsePages,
  parseSamples,
  selectPage,
  type CdpSocket,
  type MetroPage,
} from './cdp';

const page = (id: string, deviceName: string, ws = true): MetroPage => ({
  id,
  title: 'React Native Bridgeless',
  deviceName,
  webSocketDebuggerUrl: ws ? `ws://127.0.0.1:8081/inspector/debug?page=${id}` : undefined,
});

test('selectPage picks the newest debuggable page of the target device', () => {
  const pages = [
    page('a-1', 'sdk_gphone64_arm64'),
    page('b-1', 'iPhone 16'),
    page('a-3', 'sdk_gphone64_arm64'),
    page('a-4', 'sdk_gphone64_arm64', false),
  ];
  assert.equal(selectPage(pages, ['sdk_gphone64_arm64'])?.id, 'a-3');
  assert.equal(selectPage(pages, ['iphone 16'])?.id, 'b-1');
});

test('selectPage falls back to the only page and refuses ambiguous unmatched pages', () => {
  assert.equal(selectPage([page('x-1', 'Pixel')], ['other'])?.id, 'x-1');
  assert.equal(selectPage([page('x-1', 'Pixel'), page('y-1', 'iPad')], ['other']), undefined);
  assert.equal(selectPage([], ['Pixel']), undefined);
});

test('parsePages drops entries without an id', () => {
  assert.deepEqual(
    parsePages([
      { id: 'p-1', title: 't', deviceName: 'd', webSocketDebuggerUrl: 'ws://x' },
      { title: 'x' },
    ]),
    [{ id: 'p-1', title: 't', deviceName: 'd', webSocketDebuggerUrl: 'ws://x' }]
  );
});

type Listener = (event: { data?: unknown }) => void;

function fakeSocket(
  respond: (message: { id: number; method: string; params: Record<string, unknown> }) => unknown
) {
  const listeners = new Map<string, Listener[]>();
  const emit = (type: string, data?: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  };
  const sent: string[] = [];
  const socket: CdpSocket = {
    send: data => {
      sent.push(data);
      const message = JSON.parse(data) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      const reply = respond(message);
      if (reply !== undefined)
        queueMicrotask(() =>
          emit('message', JSON.stringify({ id: message.id, ...(reply as object) }))
        );
    },
    close: () => emit('close'),
    addEventListener: (type, listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  queueMicrotask(() => emit('open'));
  return { socket, sent, emit };
}

test('openSession matches responses by id and times out silent requests', async () => {
  const fake = fakeSocket(message =>
    message.method === 'Silent' ? undefined : { result: { echo: message.method } }
  );
  const session = await openSession('ws://x', () => fake.socket, 50);
  assert.deepEqual(await session.request('Ping', {}), { echo: 'Ping' });
  await assert.rejects(session.request('Silent', {}, 10), /timed out after 10 ms/);
  session.close();
  await assert.rejects(session.request('Ping', {}), /closed/);
});

test('probe client evaluates over the selected page and parses dumps', async () => {
  const dump = {
    version: 1,
    env: {
      platform: 'android',
      osVersion: '15',
      route: '/',
      window: { width: 400, height: 800 },
      pixelRatio: 2,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: false,
      language: 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 28, touch: 44 },
    },
    nodes: [{ parent: -1, tag: 'View', rect: [0, 0, 400, 800] }],
  };
  const expressions: string[] = [];
  const urls: string[] = [];
  const client = createProbeClient({
    metro: 'http://127.0.0.1:8081',
    names: ['Pixel'],
    fetch: (async (input: URL) => {
      urls.push(String(input));
      return Response.json([page('p-1', 'Pixel'), page('p-2', 'Pixel')]);
    }) as typeof fetch,
    createSocket: url => {
      urls.push(url);
      return fakeSocket(message => {
        const expression = String(message.params.expression);
        expressions.push(expression);
        if (expression.includes('ready')) return { result: { result: { value: true } } };
        if (expression.includes('dump'))
          return { result: { result: { value: JSON.stringify(dump) } } };
        return { result: { exceptionDetails: { text: 'boom' } } };
      }).socket;
    },
  });
  assert.equal(await client.ready(), true);
  assert.equal((await client.dump()).env.window.width, 400);
  await assert.rejects(client.setLanguage('ar', 'ar'), /Runtime.evaluate threw: boom/);
  assert.deepEqual(urls, [
    'http://127.0.0.1:8081/json/list',
    'ws://127.0.0.1:8081/inspector/debug?page=p-2',
  ]);
  assert.match(expressions[2] ?? '', /setLanguage\("ar", "ar"\)/);
  client.disconnect();
  await client.ready();
  assert.equal(urls.filter(url => url.endsWith('/json/list')).length, 2);
});

test('probe client retries Metro and socket failures with backoff, re-listing pages', async () => {
  const delays: number[] = [];
  let listCalls = 0;
  const expressions: string[] = [];
  const client = createProbeClient({
    metro: 'http://127.0.0.1:8081',
    names: ['Pixel'],
    sleep: async ms => delays.push(ms),
    fetch: (async () => {
      listCalls += 1;
      if (listCalls <= 2) throw new Error('Metro is rebuilding');
      return Response.json([page(`p-${listCalls}`, 'Pixel')]);
    }) as typeof fetch,
    createSocket: () =>
      fakeSocket(message => {
        const expression = String(message.params.expression);
        expressions.push(expression);
        const value = expression.endsWith('lastOutcome()')
          ? 'openLink kiloapp://sessions: pending'
          : expression.includes('openLink')
            ? { pending: 'promise' }
            : true;
        return { result: { result: { value } } };
      }).socket,
  });
  await client.resetNavigation();
  await client.openLink('kiloapp://sessions');
  assert.equal(await client.lastOutcome(), 'openLink kiloapp://sessions: pending');
  assert.deepEqual(delays, [2_000, 2_000]);
  assert.equal(listCalls, 3);
  assert.deepEqual(expressions, [
    'globalThis.__kiloDesignGate.resetNavigation()',
    'globalThis.__kiloDesignGate.openLink("kiloapp://sessions")',
    'globalThis.__kiloDesignGate.lastOutcome()',
  ]);
});

test('probe client raises InfraError after three retries', async () => {
  const delays: number[] = [];
  const client = createProbeClient({
    metro: 'http://127.0.0.1:8081',
    names: ['Pixel'],
    sleep: async ms => delays.push(ms),
    fetch: (async () => {
      throw new Error('down');
    }) as typeof fetch,
  });
  await assert.rejects(client.ready(), (error: unknown) => error instanceof InfraError);
  assert.deepEqual(delays, [2_000, 2_000, 2_000]);
});

test('parseSamples validates in-app samples and expandSamples repeats them', () => {
  const dump = {
    version: 1,
    env: {
      platform: 'ios',
      osVersion: '26',
      route: '/',
      window: { width: 100, height: 200 },
      pixelRatio: 3,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: false,
      language: 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 28, touch: 44 },
    },
    nodes: [{ parent: -1, tag: 'View', rect: [0, 0, 100, 200] }],
  };
  const samples = parseSamples(
    JSON.stringify({
      samples: [
        { t: 0, repeat: 3, dump },
        { t: 360, repeat: 1, dump },
      ],
    })
  );
  assert.deepEqual(
    samples.map(sample => [sample.t, sample.repeat]),
    [
      [0, 3],
      [360, 1],
    ]
  );
  assert.equal(expandSamples(samples).length, 4);
  assert.throws(() => parseSamples('{}'), InfraError);
  assert.throws(
    () => parseSamples(JSON.stringify({ samples: [{ t: 0, repeat: 0, dump }] })),
    InfraError
  );
});
