import { setTimeout as delay } from 'node:timers/promises';

import { InfraError } from './capture';
import { parseDump, type ProbeDump } from './tree';

export type MetroPage = Readonly<{
  id: string;
  title?: string;
  deviceName?: string;
  webSocketDebuggerUrl?: string;
}>;

export type CdpSocket = {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
};

export type CdpSession = {
  request: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<unknown>;
  isOpen: () => boolean;
  close: () => void;
};

export type ProbeSample = { t: number; repeat: number; dump: ProbeDump };

export function parseSamples(json: string): {
  readonly samples: ProbeSample[];
  readonly truncated: boolean;
} {
  const payload = record(JSON.parse(json));
  const samples = payload?.samples;
  if (!Array.isArray(samples)) throw new InfraError('stopSampling() returned no samples array');
  const truncated = payload?.truncated === true;
  return {
    truncated,
    samples: samples.map(entry => {
      const sample = record(entry);
      const t = sample?.t;
      const repeat = sample?.repeat;
      if (
        typeof t !== 'number' ||
        typeof repeat !== 'number' ||
        !Number.isInteger(repeat) ||
        repeat < 1
      ) {
        throw new InfraError(
          `stopSampling() returned a malformed sample: ${JSON.stringify(entry).slice(0, 200)}`
        );
      }
      return { t, repeat, dump: parseDump(sample?.dump) };
    }),
  };
}

export type ProbeClient = {
  ready: () => Promise<boolean>;
  dump: () => Promise<ProbeDump>;
  setLanguage: (preference: string, resolved: string) => Promise<void>;
  resolvedLanguage: () => Promise<string>;
  openLink: (url: string) => Promise<void>;
  resetNavigation: () => Promise<void>;
  lastOutcome: () => Promise<string>;
  press: (query: string) => Promise<string>;
  startSampling: (intervalMs: number, maxMs: number) => Promise<void>;
  stopSampling: () => Promise<{ readonly samples: ProbeSample[]; readonly truncated: boolean }>;
  disconnect: () => void;
};

export type ProbeClientOptions = {
  metro: string;
  names: readonly string[];
  fetch?: typeof fetch;
  createSocket?: (url: string) => CdpSocket;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
};

const EVALUATE_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 10_000;
const RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const PROBE = 'globalThis.__kiloDesignGate';

export class ProbeScriptError extends Error {
  override name = 'ProbeScriptError';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parsePages(json: unknown): MetroPage[] {
  if (!Array.isArray(json)) throw new InfraError('Metro /json/list did not return an array');
  return json.flatMap(entry => {
    const page = record(entry);
    const id = optionalString(page?.id);
    if (page === undefined || id === undefined) return [];
    return [
      {
        id,
        title: optionalString(page.title),
        deviceName: optionalString(page.deviceName),
        webSocketDebuggerUrl: optionalString(page.webSocketDebuggerUrl),
      },
    ];
  });
}

function pageSequence(page: MetroPage): number {
  const match = /(\d+)$/.exec(page.id);
  return match ? Number(match[1]) : -1;
}

export function selectPage(
  pages: readonly MetroPage[],
  names: readonly string[]
): MetroPage | undefined {
  const candidates = pages.filter(page => (page.webSocketDebuggerUrl ?? '').length > 0);
  const wanted = names.map(name => name.toLowerCase()).filter(name => name.length > 0);
  const matching = candidates.filter(page =>
    wanted.some(name =>
      [page.deviceName, page.title].some(field => field?.toLowerCase().includes(name) === true)
    )
  );
  const pool = matching.length > 0 ? matching : candidates.length === 1 ? candidates : [];
  let newest: MetroPage | undefined;
  for (const page of pool) {
    if (newest === undefined || pageSequence(page) >= pageSequence(newest)) newest = page;
  }
  return newest;
}

export async function listPages(
  metro: string,
  fetchFn: typeof fetch = fetch
): Promise<MetroPage[]> {
  const url = new URL('/json/list', metro);
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (error) {
    throw new InfraError(`Metro is not reachable at ${url.href}: ${String(error)}`);
  }
  if (!response.ok) throw new InfraError(`Metro ${url.href} returned HTTP ${response.status}`);
  return parsePages(await response.json());
}

// Node's WebSocket (undici) accepts an init object with headers; the DOM typing only knows protocols.
type NodeWebSocket = new (url: string, init: { headers: Record<string, string> }) => CdpSocket;

// The Metro inspector proxy rejects a debugger socket (HTTP 401) unless its Origin is the proxy's own
// origin or a loopback host; Node's WebSocket sends no Origin header on its own.
export function openSession(
  url: string,
  createSocket: (url: string) => CdpSocket = target =>
    new (WebSocket as unknown as NodeWebSocket)(target, {
      headers: { Origin: `http://${new URL(target).host}` },
    }),
  timeoutMs = EVALUATE_TIMEOUT_MS
): Promise<CdpSession> {
  const socket = createSocket(url);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;
  let open = false;

  const failAll = (error: Error) => {
    open = false;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const message = record(JSON.parse(event.data));
    const id = message?.id;
    if (typeof id !== 'number') return;
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    const error = record(message?.error);
    if (error) entry.reject(new Error(`CDP error: ${String(error.message)}`));
    else entry.resolve(message?.result);
  });

  const session: CdpSession = {
    isOpen: () => open,
    close: () => {
      failAll(new Error('CDP session closed'));
      socket.close();
    },
    request: (method, params, requestTimeoutMs = timeoutMs) => {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      if (!open) {
        reject(new Error('CDP session closed'));
        return promise;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
  };

  const connected = Promise.withResolvers<CdpSession>();
  const timer = setTimeout(() => {
    socket.close();
    connected.reject(new Error(`CDP connect to ${url} timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    open = true;
    connected.resolve(session);
  });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    failAll(new Error('CDP socket error'));
    connected.reject(new Error(`CDP connect to ${url} failed`));
  });
  socket.addEventListener('close', () => {
    clearTimeout(timer);
    failAll(new Error('CDP socket closed'));
    connected.reject(new Error(`CDP socket to ${url} closed`));
  });
  return connected.promise;
}

export async function evaluate(
  session: CdpSession,
  expression: string,
  timeoutMs?: number
): Promise<unknown> {
  const result = record(
    await session.request(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs
    )
  );
  const exception = record(result?.exceptionDetails);
  if (exception) {
    const description = record(exception.exception)?.description ?? exception.text;
    throw new ProbeScriptError(`Runtime.evaluate threw: ${String(description)}`);
  }
  return record(result?.result)?.value;
}

export function createProbeClient(options: ProbeClientOptions): ProbeClient {
  const timeoutMs = options.timeoutMs ?? EVALUATE_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  let session: CdpSession | undefined;

  const connect = async (): Promise<CdpSession> => {
    if (session?.isOpen()) return session;
    const pages = await listPages(options.metro, options.fetch);
    const page = selectPage(pages, options.names);
    if (page?.webSocketDebuggerUrl === undefined) {
      throw new InfraError(
        `No Metro debugger page for ${options.names.join(' / ')} at ${options.metro} (${pages.length} pages listed)`
      );
    }
    session = await openSession(page.webSocketDebuggerUrl, options.createSocket, timeoutMs);
    return session;
  };

  const disconnect = () => {
    session?.close();
    session = undefined;
  };

  const call = async (expression: string): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS);
      try {
        return await evaluate(await connect(), expression, timeoutMs);
      } catch (error) {
        if (error instanceof ProbeScriptError) throw error;
        lastError = error;
        disconnect();
      }
    }
    if (lastError instanceof InfraError) throw lastError;
    throw new InfraError(`CDP evaluate failed after ${RETRIES} retries: ${String(lastError)}`);
  };

  const run = async (method: string, ...args: (string | number)[]) =>
    call(`${PROBE}.${method}(${args.map(arg => JSON.stringify(arg)).join(', ')})`);
  const text = async (method: string, ...args: string[]) => {
    const value = await run(method, ...args);
    if (typeof value !== 'string') {
      throw new InfraError(`Design gate probe ${method}() did not return a string`);
    }
    return value;
  };

  return {
    ready: async () => (await call(`${PROBE}?.ready() === true`)) === true,
    dump: async () => {
      const json = await call(`${PROBE}.dump()`);
      if (typeof json !== 'string')
        throw new InfraError('Design gate probe dump() did not return a string');
      return parseDump(json);
    },
    setLanguage: async (preference, resolved) => {
      await run('setLanguage', preference, resolved);
    },
    resolvedLanguage: () => text('resolvedLanguage'),
    openLink: async url => {
      await run('openLink', url);
    },
    resetNavigation: async () => {
      await run('resetNavigation');
    },
    lastOutcome: () => text('lastOutcome'),
    press: query => text('press', query),
    startSampling: async (intervalMs, maxMs) => {
      await run('startSampling', intervalMs, maxMs);
    },
    stopSampling: async () => parseSamples(await text('stopSampling')),
    disconnect,
  };
}
