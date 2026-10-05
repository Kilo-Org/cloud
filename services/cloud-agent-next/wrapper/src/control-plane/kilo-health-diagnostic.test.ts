import { describe, expect, it, spyOn } from 'bun:test';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createKiloRuntime, type KiloRuntimeScheduler } from './kilo-runtime.js';

const SENTINEL = 'PRIVATE_HEALTH_SENTINEL';
const outcomes = [
  'healthy',
  'unhealthy',
  'http_error',
  'parse_error',
  'invalid_payload',
  'request_error',
  'aborted',
  'pending',
  'unknown',
  'not_applicable',
];

function parseRestartDiagnostics(fileLog: string): Record<string, unknown>[] {
  return fileLog
    .split('\n')
    .filter(line => line.includes('control-plane kilo restarting '))
    .map(line => {
      const marker = ' diagnostic=';
      const position = line.lastIndexOf(marker);
      expect(position).toBeGreaterThan(-1);
      const serialized = line.slice(position + marker.length);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512);
      expect(serialized).not.toContain(SENTINEL);
      const diagnostic = JSON.parse(serialized) as Record<string, unknown>;
      expect(Object.keys(diagnostic).sort()).toEqual(
        [
          'trigger',
          'probeOutcome',
          'decisionResolution',
          'innerAbortObserved',
          'probeDurationMs',
          'probeDurationClamped',
          'sseSilenceMs',
          'sseSilenceClamped',
          'reconnectCount',
          ...(diagnostic.httpStatus === undefined ? [] : ['httpStatus']),
        ].sort()
      );
      expect([
        'health_probe_false',
        'sse_reconnect_budget',
        'process_exit',
        'no_client_retry',
      ]).toContain(String(diagnostic.trigger));
      expect(outcomes).toContain(String(diagnostic.probeOutcome));
      expect(['fulfilled_false', 'rejected', 'not_applicable']).toContain(
        String(diagnostic.decisionResolution)
      );
      expect(typeof diagnostic.innerAbortObserved).toBe('boolean');
      for (const field of ['probeDurationMs', 'sseSilenceMs']) {
        expect(Number.isInteger(diagnostic[field])).toBe(true);
        expect(diagnostic[field]).toBeGreaterThanOrEqual(0);
        expect(diagnostic[field]).toBeLessThanOrEqual(600_000);
      }
      expect(typeof diagnostic.probeDurationClamped).toBe('boolean');
      expect(typeof diagnostic.sseSilenceClamped).toBe('boolean');
      expect(diagnostic.reconnectCount).toBeGreaterThanOrEqual(0);
      expect(diagnostic.reconnectCount).toBeLessThanOrEqual(6);
      if (diagnostic.httpStatus !== undefined) {
        expect(Number.isInteger(diagnostic.httpStatus)).toBe(true);
        expect(diagnostic.httpStatus).toBeGreaterThanOrEqual(100);
        expect(diagnostic.httpStatus).toBeLessThanOrEqual(599);
      }
      return diagnostic;
    });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Health diagnostic test timed out');
    await Bun.sleep(5);
  }
}

function harness(
  url: string,
  options: {
    heartbeat?: boolean;
    healthRequestMs?: number;
    failReplacement?: boolean;
    isIdle?: () => Promise<boolean>;
  } = {}
) {
  let clock = 0;
  let tick: (() => void) | undefined;
  const scheduler: KiloRuntimeScheduler = {
    now: () => clock,
    setInterval(handler) {
      tick = handler;
      return 1;
    },
    clearInterval() {
      tick = undefined;
    },
  };
  const counts = { spawns: 0, stops: 0, opens: 0, restarts: 0 };
  const logs: string[] = [];
  const exits: Array<() => void> = [];
  let unavailable = 0;
  const runtime = createKiloRuntime({
    directory: `/tmp/${SENTINEL}`,
    env: {},
    pidfileDirectory: `/tmp/${SENTINEL}/pids`,
    timers: {
      ...CONTROL_PLANE_TIMERS,
      wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, healthRequestMs: options.healthRequestMs ?? 200 },
    },
    scheduler,
    prepareFilesystem: async () => {},
    readProcessStartTime: () => undefined,
    ...(options.isIdle ? { isIdle: options.isIdle } : {}),
    spawnKilo: async () => {
      counts.spawns++;
      if (options.failReplacement && counts.spawns > 1) throw new Error('replacement failed');
      const exited = Promise.withResolvers<void>();
      exits.push(() => exited.resolve());
      return {
        pid: 900000 + counts.spawns,
        url,
        exited: exited.promise,
        stop: async () => {
          counts.stops++;
          return true;
        },
      };
    },
    openFeed(_source, callbacks) {
      counts.opens++;
      return {
        open: async () => {
          callbacks.onEvent({ type: 'server.connected', properties: {}, nativeRuntimeId: '' });
          if (options.heartbeat !== false && counts.opens > 1)
            callbacks.onEvent({ type: 'server.heartbeat', properties: {}, nativeRuntimeId: '' });
        },
        close() {},
      };
    },
    log: line => logs.push(line),
    onRestart: () => {
      counts.restarts++;
    },
    onUnavailable: () => {
      unavailable++;
    },
  });
  return {
    runtime,
    logs,
    counts,
    exits,
    unavailable: () => unavailable,
    silence(ms = 30000) {
      clock += ms;
      tick?.();
    },
  };
}

describe('default SDK health diagnostics', () => {
  for (const fixture of [
    { name: 'healthy', body: { healthy: true }, outcome: undefined, status: 200 },
    { name: 'unhealthy', body: { healthy: false }, outcome: 'unhealthy', status: 200 },
    {
      name: '503 healthy-looking body',
      body: { healthy: true },
      outcome: 'http_error',
      status: 503,
    },
    { name: 'malformed JSON', body: undefined, outcome: 'parse_error', status: 200 },
    { name: 'invalid payload', body: { healthy: 'true' }, outcome: 'invalid_payload', status: 200 },
    { name: 'missing health field', body: {}, outcome: 'invalid_payload', status: 200 },
    { name: 'connection refusal', body: undefined, outcome: 'request_error', status: undefined },
    { name: 'stalled request', body: undefined, outcome: 'pending-or-aborted', status: undefined },
  ]) {
    it(`default SDK health outcomes produce distinct restart diagnostics without changing decisions: ${fixture.name}`, async () => {
      let requests = 0;
      const release = Promise.withResolvers<Response>();
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          requests++;
          if (fixture.name === 'stalled request') return release.promise;
          const headers = { 'content-type': 'application/json', 'x-private-fixture': SENTINEL };
          return new Response(
            fixture.name === 'malformed JSON'
              ? `{${SENTINEL}`
              : JSON.stringify({ ...fixture.body, private: SENTINEL }),
            { status: fixture.status ?? 200, headers }
          );
        },
      });
      const url = String(server.url);
      if (fixture.name === 'connection refusal') await server.stop(true);
      const test = harness(url);
      const fetchSpy = spyOn(globalThis, 'fetch');
      try {
        await test.runtime.ensure();
        test.silence();
        await waitFor(() =>
          fixture.outcome === undefined ? test.counts.opens === 2 : test.counts.restarts === 1
        );
        const diagnostics = parseRestartDiagnostics(test.logs.join('\n'));
        expect(requests).toBe(fixture.name === 'connection refusal' ? 0 : 1);
        expect(fetchSpy.mock.calls).toHaveLength(1);
        expect(test.counts).toEqual({
          spawns: fixture.outcome ? 2 : 1,
          stops: fixture.outcome ? 1 : 0,
          opens: 2,
          restarts: fixture.outcome ? 1 : 0,
        });
        if (!fixture.outcome) expect(diagnostics).toEqual([]);
        else {
          expect(diagnostics).toHaveLength(1);
          const diagnostic = diagnostics[0];
          expect(diagnostic.trigger).toBe('health_probe_false');
          expect(diagnostic.httpStatus).toBe(fixture.status);
          if (fixture.name === 'stalled request') {
            expect(['pending', 'aborted']).toContain(String(diagnostic.probeOutcome));
            expect(['rejected', 'fulfilled_false']).toContain(
              String(diagnostic.decisionResolution)
            );
            expect(diagnostic.innerAbortObserved).toBe(true);
          } else {
            expect(diagnostic.probeOutcome).toBe(fixture.outcome);
            expect(diagnostic.decisionResolution).toBe('fulfilled_false');
            expect(diagnostic.innerAbortObserved).toBe(false);
          }
          expect(test.logs.filter(line => line.includes(' diagnostic='))).toHaveLength(1);
          expect(test.logs.find(line => line.includes(' kilo restarting '))).toContain(
            'reason=hang pid=900001'
          );
          console.log(
            JSON.stringify({ fixture: fixture.name, requests, ...test.counts, diagnostic })
          );
        }
      } finally {
        fetchSpy.mockRestore();
        release.resolve(Response.json({ healthy: true }));
        await test.runtime.shutdown();
        await server.stop(true);
      }
    });
  }

  it('pending health operation is reported without inferring the timeout-race winner and late completion cannot mutate its snapshot', async () => {
    const held = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    let requests = 0;
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        (input: RequestInfo | URL) => {
          requests++;
          expect(input).toBeInstanceOf(Request);
          signal = (input as Request).signal;
          return held.promise;
        },
        { preconnect: globalThis.fetch.preconnect }
      )
    );
    const test = harness('http://127.0.0.1:1', { healthRequestMs: 80 });
    try {
      await test.runtime.ensure();
      test.silence();
      await waitFor(() => test.counts.restarts === 1);
      const before = test.logs.find(line => line.includes(' diagnostic='));
      const diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[0];
      expect(diagnostic.probeOutcome).toBe('pending');
      expect(diagnostic.decisionResolution).toBe('rejected');
      expect(diagnostic.innerAbortObserved).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(requests).toBe(1);
      expect(test.counts).toEqual({ spawns: 2, stops: 1, opens: 2, restarts: 1 });
      const response = Response.json({ healthy: true, private: SENTINEL });
      const bodyRead = spyOn(response, 'text');
      held.resolve(response);
      await waitFor(() => bodyRead.mock.calls.length === 1);
      await Bun.sleep(30);
      expect(test.logs.find(line => line.includes(' diagnostic='))).toBe(before);
      expect(parseRestartDiagnostics(test.logs.join('\n'))).toEqual([diagnostic]);
      expect(test.counts.restarts).toBe(1);
      console.log(
        JSON.stringify({
          fixture: 'pending then late SDK settlement',
          requests,
          ...test.counts,
          diagnostic,
        })
      );
    } finally {
      held.resolve(Response.json({ healthy: true }));
      fetchMock.mockRestore();
      await test.runtime.shutdown();
    }
  });

  it('diagnostic projection cannot turn a healthy result false when an observed response property throws', async () => {
    let statusReads = 0;
    const response = Response.json({ healthy: true });
    Object.defineProperty(response, 'status', {
      get() {
        if (++statusReads > 1) throw new Error(SENTINEL);
        return 200;
      },
    });
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const test = harness('http://127.0.0.1:1');
    try {
      await test.runtime.ensure();
      test.silence();
      await waitFor(() => test.counts.opens === 2);
      expect(statusReads).toBe(2);
      expect(test.counts).toEqual({ spawns: 1, stops: 0, opens: 2, restarts: 0 });
      expect(parseRestartDiagnostics(test.logs.join('\n'))).toEqual([]);
    } finally {
      fetchMock.mockRestore();
      await test.runtime.shutdown();
    }
  });

  it('unknown projection is bounded without retaining error or response details', async () => {
    const response = Response.json({ healthy: false });
    let statusReads = 0;
    Object.defineProperty(response, 'status', {
      get() {
        if (++statusReads > 1) throw new Error(SENTINEL);
        return 200;
      },
    });
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const test = harness('http://127.0.0.1:1');
    try {
      await test.runtime.ensure();
      test.silence(1_000_000);
      await waitFor(() => test.counts.restarts === 1);
      const diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[0];
      expect(diagnostic.probeOutcome).toBe('unknown');
      expect(diagnostic.httpStatus).toBeUndefined();
      expect(diagnostic.sseSilenceMs).toBe(600_000);
      expect(diagnostic.sseSilenceClamped).toBe(true);
    } finally {
      fetchMock.mockRestore();
      await test.runtime.shutdown();
    }
  });

  for (const status of [99, 600, NaN, Infinity, 201.5]) {
    it(`omits an untrusted HTTP status outside the bounded integer contract: ${status}`, async () => {
      const response = Response.json({ healthy: false });
      let reads = 0;
      Object.defineProperty(response, 'status', {
        get() {
          return ++reads === 1 ? 200 : status;
        },
      });
      const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(response);
      const test = harness('http://127.0.0.1:1');
      try {
        await test.runtime.ensure();
        test.silence();
        await waitFor(() => test.counts.restarts === 1);
        const diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[0];
        expect(diagnostic.probeOutcome).toBe('unhealthy');
        expect(diagnostic.httpStatus).toBeUndefined();
      } finally {
        fetchMock.mockRestore();
        await test.runtime.shutdown();
      }
    });
  }

  it('reports duration clamping without retaining an unbounded elapsed value', async () => {
    let now = 0;
    const clockMock = spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        () => {
          now = 1_000_000;
          return Promise.resolve(Response.json({ healthy: false }));
        },
        { preconnect: globalThis.fetch.preconnect }
      )
    );
    const test = harness('http://127.0.0.1:1');
    try {
      await test.runtime.ensure();
      test.silence();
      await waitFor(() => test.counts.restarts === 1);
      const diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[0];
      expect(diagnostic.probeDurationMs).toBe(600_000);
      expect(diagnostic.probeDurationClamped).toBe(true);
    } finally {
      clockMock.mockRestore();
      fetchMock.mockRestore();
      await test.runtime.shutdown();
    }
  });

  it('fault diagnostics remain one existing record per restart within the three-in-ten-minute budget', async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return Response.json({ healthy: false, private: SENTINEL });
      },
    });
    const test = harness(String(server.url));
    try {
      await test.runtime.ensure();
      for (let attempt = 1; attempt <= 4; attempt++) {
        test.silence();
        await waitFor(() =>
          attempt < 4 ? test.counts.restarts === attempt : test.runtime.isUnavailable()
        );
      }
      expect(requests).toBe(4);
      expect(test.counts).toEqual({ spawns: 4, stops: 3, opens: 4, restarts: 3 });
      expect(parseRestartDiagnostics(test.logs.join('\n'))).toHaveLength(3);
      expect(test.logs.filter(line => line.includes(' diagnostic='))).toHaveLength(3);
    } finally {
      await test.runtime.shutdown();
      await server.stop(true);
    }
  });

  it('process exit and SSE budget exhaustion identify their actual deciding branches', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json({ healthy: true });
      },
    });
    const test = harness(String(server.url), { heartbeat: false });
    try {
      await test.runtime.ensure();
      test.exits[0]();
      await waitFor(() => test.counts.restarts === 1);
      let diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[0];
      expect(diagnostic.trigger).toBe('process_exit');
      expect(diagnostic.probeOutcome).toBe('not_applicable');
      expect(diagnostic.decisionResolution).toBe('not_applicable');
      for (let attempt = 1; attempt <= 7; attempt++) {
        test.silence(attempt === 1 ? 30000 : 15000);
        await waitFor(() =>
          attempt <= 6 ? test.counts.opens === attempt + 2 : test.counts.restarts === 2
        );
        await Bun.sleep(5);
      }
      diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[1];
      expect(diagnostic.trigger).toBe('sse_reconnect_budget');
      expect(diagnostic.probeOutcome).toBe('not_applicable');
      expect(diagnostic.reconnectCount).toBe(6);
    } finally {
      await test.runtime.shutdown();
      await server.stop(true);
    }
  });

  it('watchdog retries after failed replacement are attributed to no_client_retry without a new exit event', async () => {
    const test = harness('http://127.0.0.1:1', { failReplacement: true });
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      await test.runtime.ensure();
      expect(test.counts.spawns).toBe(1);
      test.exits[0]();
      await waitFor(() => test.counts.spawns === 2 && !test.runtime.isRestarting());
      for (const spawns of [3, 4]) {
        test.silence();
        await waitFor(() => test.counts.spawns === spawns && !test.runtime.isRestarting());
      }
      const before = test.logs.filter(line => line.includes(' kilo restarting '));
      const diagnostics = parseRestartDiagnostics(test.logs.join('\n'));
      expect(diagnostics.map(diagnostic => diagnostic.trigger)).toEqual([
        'process_exit',
        'no_client_retry',
        'no_client_retry',
      ]);
      expect(before).toHaveLength(3);
      expect(before.every(line => line.includes('reason=exit'))).toBe(true);
      expect(before[0]).toContain('pid=900001');
      expect(before.slice(1).every(line => line.includes('pid=none'))).toBe(true);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.probeOutcome).toBe('not_applicable');
        expect(diagnostic.decisionResolution).toBe('not_applicable');
        expect(diagnostic.innerAbortObserved).toBe(false);
        expect(diagnostic.httpStatus).toBeUndefined();
        expect(diagnostic.probeDurationMs).toBe(0);
      }
      expect(test.exits).toHaveLength(1);
      expect(fetchSpy.mock.calls).toHaveLength(0);
      expect(test.counts).toEqual({ spawns: 4, stops: 1, opens: 1, restarts: 0 });
      test.silence();
      await waitFor(() => test.runtime.isUnavailable());
      expect(test.unavailable()).toBe(1);
      expect(test.runtime.isSuspected()).toBe(true);
      expect(test.runtime.isRestarting()).toBe(false);
      test.silence();
      expect(test.counts).toEqual({ spawns: 4, stops: 1, opens: 1, restarts: 0 });
      expect(test.unavailable()).toBe(1);
      expect(fetchSpy.mock.calls).toHaveLength(0);
      expect(test.logs.filter(line => line.includes(' kilo restarting '))).toEqual(before);
      expect(parseRestartDiagnostics(test.logs.join('\n'))).toEqual(diagnostics);
      console.log(
        JSON.stringify({
          fixture: 'failed replacement watchdog retries',
          ...test.counts,
          records: diagnostics.length,
          exitEvents: 1,
          healthRequests: fetchSpy.mock.calls.length,
          unavailable: test.unavailable(),
          diagnostics,
        })
      );
    } finally {
      fetchSpy.mockRestore();
      await test.runtime.shutdown();
    }
  });

  it('no-client retry snapshots omit stale successful health observations and status', async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return Response.json({ healthy: true, private: SENTINEL });
      },
    });
    const test = harness(String(server.url), { failReplacement: true });
    try {
      await test.runtime.ensure();
      test.silence();
      await waitFor(() => test.counts.opens === 2 && !test.runtime.isSuspected());
      expect(requests).toBe(1);
      test.exits[0]();
      await waitFor(() => test.counts.spawns === 2 && !test.runtime.isRestarting());
      test.silence();
      await waitFor(() => test.counts.spawns === 3 && !test.runtime.isRestarting());
      const diagnostic = parseRestartDiagnostics(test.logs.join('\n'))[1];
      expect(diagnostic.trigger).toBe('no_client_retry');
      expect(diagnostic.probeOutcome).toBe('not_applicable');
      expect(diagnostic.decisionResolution).toBe('not_applicable');
      expect(diagnostic.httpStatus).toBeUndefined();
      expect(diagnostic.probeDurationMs).toBe(0);
      expect(diagnostic.innerAbortObserved).toBe(false);
      expect(requests).toBe(1);
    } finally {
      await test.runtime.shutdown();
      await server.stop(true);
    }
  });

  it('credential refresh remains unenriched and exempt from the fault restart budget', async () => {
    const test = harness('http://127.0.0.1:1', { isIdle: async () => true });
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      await test.runtime.ensure();
      for (let refresh = 1; refresh <= 4; refresh++) {
        await test.runtime.installCredentials({ LOCAL_TEST_REFRESH: String(refresh) });
        expect(await test.runtime.applyPendingCredentials(() => true)).toBe(true);
      }
      const refreshLines = test.logs.filter(line => line.includes(' kilo restarting '));
      expect(refreshLines).toHaveLength(4);
      expect(
        refreshLines.every(
          line => line.includes('reason=credentials') && !line.includes(' diagnostic=')
        )
      ).toBe(true);
      expect(test.runtime.isUnavailable()).toBe(false);
      for (let fault = 1; fault <= 3; fault++) {
        test.exits.at(-1)?.();
        await waitFor(() => test.counts.restarts === 4 + fault);
      }
      expect(
        parseRestartDiagnostics(
          test.logs.filter(line => !line.includes('reason=credentials')).join('\n')
        )
      ).toHaveLength(3);
      test.exits.at(-1)?.();
      await waitFor(() => test.runtime.isUnavailable());
      expect(test.unavailable()).toBe(1);
      expect(test.counts).toEqual({ spawns: 8, stops: 7, opens: 8, restarts: 7 });
      expect(test.logs.filter(line => line.includes(' diagnostic='))).toHaveLength(3);
      expect(fetchSpy.mock.calls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      await test.runtime.shutdown();
    }
  });
});
