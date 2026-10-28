import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function isolatedKiloEnvironment(input: {
  home: string;
  token: string;
  password: string;
  web: string;
  worker: string;
  gateway: string;
  parent?: NodeJS.Dict<string>;
}): NodeJS.Dict<string> {
  const parent = input.parent ?? process.env;
  const env: NodeJS.Dict<string> = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'NODE_EXTRA_CA_CERTS']) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return {
    ...env,
    HOME: input.home,
    XDG_CONFIG_HOME: path.join(input.home, 'config'),
    XDG_DATA_HOME: path.join(input.home, 'data'),
    XDG_CACHE_HOME: path.join(input.home, 'cache'),
    XDG_STATE_HOME: path.join(input.home, 'state'),
    KILO_DB: path.join(input.home, 'kilo.db'),
    KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: input.token } }),
    KILO_SERVER_USERNAME: 'kilo',
    KILO_SERVER_PASSWORD: input.password,
    KILO_CONFIG_CONTENT: '{}',
    KILO_CLIENT: 'cli',
    KILO_TELEMETRY_LEVEL: 'off',
    DO_NOT_TRACK: '1',
    KILO_DISABLE_AUTOUPDATE: '1',
    KILO_DISABLE_DEFAULT_PLUGINS: '1',
    KILO_DISABLE_PROJECT_CONFIG: '1',
    KILO_DISABLE_EXTERNAL_SKILLS: '1',
    KILO_DISABLE_MODELS_FETCH: '1',
    KILO_DISABLE_SHARE: '1',
    KILO_DISABLE_SESSION_INGEST: '1',
    KILO_SESSION_INGEST_URL: 'http://127.0.0.1:9',
    KILO_DISABLE_PRESENCE: '1',
    KILO_DISABLE_CODEBASE_INDEXING: 'vscode-no-workspace',
    KILO_MARKETPLACE_BASE_URL: 'http://127.0.0.1:9',
    CLOUD_AGENT_NEXT_BASE_URL: input.worker,
    KILO_WEB_APP_URL: input.web,
    KILO_API_URL: input.web,
    KILO_AI_GATEWAY_URL: `${input.gateway}/api/v1`,
    KILO_AUTO_ROUTING_URL: 'http://127.0.0.1:9',
    KILO_MODELS_URL: 'http://127.0.0.1:9',
  };
}

export async function startLocalKilo(input: {
  repo: string;
  bun: string;
  home: string;
  token: string;
  web: string;
  worker: string;
  gateway: string;
}) {
  await mkdir(input.home, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('hex');
  const basic = Buffer.from(`kilo:${password}`).toString('base64');
  const ready = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<void>();
  let log = '';
  const child = spawn(
    input.bun,
    [
      'run',
      '--cwd',
      'packages/opencode',
      '--conditions=node',
      'src/index.ts',
      'serve',
      '--pure',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: input.repo,
      env: isolatedKiloEnvironment({ ...input, password }) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const output = (chunk: Buffer) => {
    log = (log + chunk.toString())
      .replaceAll(input.token, '[redacted]')
      .replaceAll(password, '[redacted]')
      .replaceAll(basic, '[redacted]')
      .slice(-64 * 1024);
    const match = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
    if (match?.[1]) ready.resolve(match[1]);
  };
  child.stdout.on('data', output);
  child.stderr.on('data', output);
  child.on('error', error => {
    ready.reject(error);
    exited.resolve();
  });
  child.on('exit', code => {
    ready.reject(new Error(`Local Kilo exited (${code}) before readiness: ${log}`));
    exited.resolve();
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await exited.promise;
    } finally {
      clearTimeout(timer);
    }
  };
  const timer = setTimeout(
    () => ready.reject(new Error(`Local Kilo startup timed out: ${log}`)),
    60_000
  );
  try {
    const url = await ready.promise;
    return {
      url,
      headers: { Authorization: `Basic ${basic}` },
      close,
      logs: () => log,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type KiloEvent = { type: string; properties: Record<string, unknown> };

export function createSseDecoder() {
  let buffer = '';
  return (chunk: string): KiloEvent[] => {
    buffer += chunk;
    const events: KiloEvent[] = [];
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (frame.length > 1024 * 1024)
        throw new Error('SSE frame exceeded the integration-test bound');
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      const value: unknown = JSON.parse(data);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        typeof value.type !== 'string'
      ) {
        throw new Error('SSE frame did not contain a typed event');
      }
      const properties = 'properties' in value ? value.properties : {};
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        throw new Error('SSE event properties were not an object');
      }
      events.push({ type: value.type, properties: Object.fromEntries(Object.entries(properties)) });
    }
    if (buffer.length > 1024 * 1024)
      throw new Error('SSE frame exceeded the integration-test bound');
    return events;
  };
}

export async function openKiloSse(url: string, headers: HeadersInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('SSE connection timed out')), 20_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ...Object.fromEntries(new Headers(headers)), accept: 'text/event-stream' },
      signal: controller.signal,
      redirect: 'error',
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`SSE connection returned HTTP ${response.status}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    controller.abort();
    throw new Error('SSE connection returned the wrong content type');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const decode = createSseDecoder();
  const events: KiloEvent[] = [];
  const listeners = new Set<() => void>();
  let fault: Error | undefined;
  const done = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('SSE returned a non-byte chunk');
        events.push(...decode(decoder.decode(chunk, { stream: true })));
        if (events.length > 10_000)
          throw new Error('SSE event count exceeded the integration-test bound');
        for (const listener of listeners) listener();
      }
      if (!controller.signal.aborted) throw new Error('SSE connection closed unexpectedly');
    } catch (error) {
      if (!controller.signal.aborted)
        fault = error instanceof Error ? error : new Error(String(error));
    } finally {
      for (const listener of listeners) listener();
    }
  })();
  const wait = (
    predicate: (event: KiloEvent) => boolean,
    label: string,
    after = 0,
    milliseconds = 120_000
  ) => {
    const result = Promise.withResolvers<KiloEvent>();
    const inspect = () => {
      try {
        const event = events.slice(after).find(predicate);
        if (event) result.resolve(event);
        else if (fault) result.reject(fault);
        else if (controller.signal.aborted)
          result.reject(new Error(`SSE closed while waiting for ${label}`));
      } catch (error) {
        result.reject(error);
      }
    };
    const timer = setTimeout(
      () => result.reject(new Error(`Timed out waiting for ${label}`)),
      milliseconds
    );
    listeners.add(inspect);
    inspect();
    return result.promise.finally(() => {
      clearTimeout(timer);
      listeners.delete(inspect);
    });
  };
  return {
    events,
    wait,
    error: () => fault,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await done;
    },
  };
}
