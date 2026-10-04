import { execFile, spawn } from 'node:child_process';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect as netConnect, type Server as NetServer } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ ContainerProxy: class {} }));
vi.mock('../../src/container-usage.js', () => ({ MeteredSandbox: class {} }));

import { handleManagedScmOutbound } from '../../src/sandbox-outbound.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import { createPreparationManager } from '../../wrapper/src/control-plane/prepare.js';
import { git, type ExecResult, type ProcessOptions } from '../../wrapper/src/utils.js';
import type { WrapperKiloClient } from '../../wrapper/src/kilo-api.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import type {
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';

const nativeFetch = globalThis.fetch;

const GIT_URL = 'https://github.com/synthetic/repo.git';
const REPO_PREFIX = '/synthetic/repo.git';
const FIXTURE_CONTENT = 'Synthetic managed GitHub preparation fixture\n';
const ALIAS = createControlPlaneCredential('synthetic-sandbox', 'github');
const CAPABILITY = 'kgh2.synthetic-upstream';
const DIRECT_TOKEN = 'ghp-synthetic-direct';
const ALIAS_AUTHORIZATION = `Basic ${Buffer.from(`x-access-token:${ALIAS}`).toString('base64')}`;
const DIRECT_AUTHORIZATION = `Basic ${Buffer.from(`x-access-token:${DIRECT_TOKEN}`).toString('base64')}`;
const REDEEMED_AUTHORIZATION = `Basic ${Buffer.from('x-access-token:redeemed-synthetic').toString('base64')}`;

type AuthClass = 'none' | 'alias' | 'direct' | 'redeemed' | 'other';

function classifyAuthorization(authorization: string | null | undefined): AuthClass {
  if (!authorization) return 'none';
  if (authorization === ALIAS_AUTHORIZATION) return 'alias';
  if (authorization === DIRECT_AUTHORIZATION) return 'direct';
  if (authorization === REDEEMED_AUTHORIZATION) return 'redeemed';
  return 'other';
}

type HandlerHit = { host: string; method: string; path: string; auth: AuthClass };
type BackendHit = { method: string; path: string; query: string; auth: AuthClass };
type ProxyHit = { connect?: string; absolute?: string };

type Mode =
  | { kind: 'serve' }
  | { kind: 'retry-once' }
  | { kind: 'direct-401' }
  | { kind: 'discovery-redirect'; location: string }
  | { kind: 'post-redirect'; location: string };

type FixtureState = {
  mode: Mode;
  handler: HandlerHit[];
  backend: BackendHit[];
  proxy: ProxyHit[];
  resolutions: number;
  redemptions: number;
  redeemedDiscoveryCount: number;
};

type Fixture = {
  root: string;
  homeRoot: string;
  certPath: string;
  commit: string;
  proxyPort: number;
  backendUrl: string;
  state: FixtureState;
  reset: (mode: Mode) => void;
  setResolver: (resolver: () => Promise<unknown> | unknown) => void;
  anonymousProbe: () => Promise<number>;
  close: () => Promise<void>;
};

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'date',
  'content-length',
]);

async function readBody(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function runExec(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; input?: string | Buffer }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
    child.stdin?.end(options.input ?? '');
  });
}

function runGitHttpBackend(
  root: string,
  request: { method: string; url: string; contentType: string | undefined; gitProtocol?: string },
  body: Buffer
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise(resolve => {
    const url = new URL(request.url, 'https://github.com');
    const pathInfo = REPO_PREFIX + url.pathname.slice(REPO_PREFIX.length);
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: request.method,
      PATH_INFO: pathInfo,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      CONTENT_TYPE: request.contentType ?? '',
      CONTENT_LENGTH: String(body.length),
      REMOTE_ADDR: '127.0.0.1',
      ...(request.gitProtocol ? { GIT_PROTOCOL: request.gitProtocol } : {}),
    };
    const child = spawn('git', ['http-backend'], {
      cwd: root,
      env,
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.on('error', () =>
      resolve({ status: 500, headers: {}, body: Buffer.from('fixture cgi error') })
    );
    child.on('close', () => {
      const buffer = Buffer.concat(stdout);
      const crlf = buffer.indexOf('\r\n\r\n');
      const headerEnd = crlf === -1 ? buffer.indexOf('\n\n') : crlf;
      const bodyStart = headerEnd === -1 ? buffer.length : headerEnd + (crlf === -1 ? 2 : 4);
      let status = 200;
      const headers: Record<string, string> = {};
      const headerText = headerEnd === -1 ? '' : buffer.subarray(0, headerEnd).toString('utf8');
      for (const line of headerText.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator === -1) continue;
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      resolve({ status, headers, body: buffer.subarray(bodyStart) });
    });
    child.stdin.end(body);
  });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-github-prep-'));
  const homeRoot = path.join(root, 'homes');
  await mkdir(homeRoot, { recursive: true });
  const repoRoot = path.join(root, 'synthetic');
  const repo = path.join(repoRoot, 'repo.git');
  await mkdir(repoRoot, { recursive: true });

  const fixtureEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_AUTHOR_NAME: 'Synthetic Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  await runExec('git', ['init', '--bare', '--initial-branch=main', repo], {
    cwd: root,
    env: fixtureEnv,
  });
  const blob = (
    await runExec('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], {
      cwd: root,
      env: fixtureEnv,
      input: FIXTURE_CONTENT,
    })
  ).trim();
  const tree = (
    await runExec('git', ['--git-dir', repo, 'mktree'], {
      cwd: root,
      env: fixtureEnv,
      input: `100644 blob ${blob}\tfixture.txt\n`,
    })
  ).trim();
  const commit = (
    await runExec('git', ['--git-dir', repo, 'commit-tree', tree, '-m', 'Synthetic fixture'], {
      cwd: root,
      env: fixtureEnv,
    })
  ).trim();
  for (const ref of ['refs/heads/main', 'refs/pull/12/head']) {
    await runExec('git', ['--git-dir', repo, 'update-ref', ref, commit], {
      cwd: root,
      env: fixtureEnv,
    });
  }

  const keyPath = path.join(root, 'fixture.key');
  const certPath = path.join(root, 'fixture.crt');
  await runExec(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=github.com',
      '-addext',
      'subjectAltName=DNS:github.com',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { cwd: root, env: fixtureEnv }
  );
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };

  const state: FixtureState = {
    mode: { kind: 'serve' },
    handler: [],
    backend: [],
    proxy: [],
    resolutions: 0,
    redemptions: 0,
    redeemedDiscoveryCount: 0,
  };
  let resolver: () => Promise<unknown> | unknown = () => ({ credential: CAPABILITY });

  const env = {
    SANDBOX_CONTROL: {
      getByName: () => ({
        resolveCredential: async () => {
          state.resolutions += 1;
          return await resolver();
        },
      }),
    },
    GIT_TOKEN_SERVICE: {
      redeemGitHubSessionCapability: async () => {
        state.redemptions += 1;
        return { success: true, authorization: REDEEMED_AUTHORIZATION };
      },
    },
  } as unknown as Parameters<typeof handleManagedScmOutbound>[1];

  const isDiscovery = (method: string, pathName: string, query: string): boolean =>
    method === 'GET' &&
    pathName.endsWith('/info/refs') &&
    query.includes('service=git-upload-pack');

  const handleBackend: RequestListener = async (incoming, outgoing) => {
    try {
      const body = await readBody(incoming);
      const url = new URL(incoming.url ?? '/', 'http://fixture.invalid');
      const auth = classifyAuthorization(
        typeof incoming.headers.authorization === 'string' ? incoming.headers.authorization : null
      );
      const hit: BackendHit = {
        method: incoming.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        auth,
      };
      state.backend.push(hit);
      const mode = state.mode;
      if (mode.kind === 'direct-401' && auth === 'none') {
        outgoing.setHeader('WWW-Authenticate', 'Basic realm="synthetic"');
        outgoing.writeHead(401);
        outgoing.end('Synthetic authentication challenge');
        return;
      }
      if (auth === 'none') {
        outgoing.setHeader('Retry-After', '0');
        outgoing.writeHead(429);
        outgoing.end('Synthetic anonymous rate limit');
        return;
      }
      if (
        mode.kind === 'retry-once' &&
        auth === 'redeemed' &&
        isDiscovery(hit.method, hit.path, hit.query)
      ) {
        if (state.redeemedDiscoveryCount === 0) {
          state.redeemedDiscoveryCount += 1;
          outgoing.setHeader('Retry-After', '0');
          outgoing.writeHead(429);
          outgoing.end('Synthetic authenticated rate limit');
          return;
        }
        state.redeemedDiscoveryCount += 1;
      }
      if (
        mode.kind === 'discovery-redirect' &&
        auth === 'redeemed' &&
        isDiscovery(hit.method, hit.path, hit.query)
      ) {
        outgoing.setHeader('Location', mode.location);
        outgoing.writeHead(302);
        outgoing.end();
        return;
      }
      if (
        mode.kind === 'post-redirect' &&
        auth === 'redeemed' &&
        hit.method === 'POST' &&
        hit.path.endsWith('/git-upload-pack')
      ) {
        outgoing.setHeader('Location', mode.location);
        outgoing.writeHead(302);
        outgoing.end();
        return;
      }
      const cgi = await runGitHttpBackend(
        root,
        {
          method: hit.method,
          url: incoming.url ?? '/',
          contentType:
            typeof incoming.headers['content-type'] === 'string'
              ? incoming.headers['content-type']
              : undefined,
          gitProtocol:
            typeof incoming.headers['git-protocol'] === 'string'
              ? incoming.headers['git-protocol']
              : undefined,
        },
        body
      );
      // Real GitHub prefixes the protocol-v2 capability advertisement with the
      // smart-HTTP service banner; `git http-backend` drops it under
      // GIT_PROTOCOL=version=2. Restore it so the fixture matches the remote.
      const smartBanner = Buffer.from('001e# service=git-upload-pack\n0000');
      const cgiBody =
        hit.method === 'GET' &&
        hit.path.endsWith('/info/refs') &&
        !cgi.body.includes(Buffer.from('# service=git-upload-pack'))
          ? Buffer.concat([smartBanner, cgi.body])
          : cgi.body;
      for (const [name, value] of Object.entries(cgi.headers)) outgoing.setHeader(name, value);
      outgoing.writeHead(cgi.status);
      outgoing.end(cgiBody);
    } catch {
      outgoing.writeHead(500);
      outgoing.end('Synthetic backend failure');
    }
  };

  const handleFrontend: RequestListener = async (incoming, outgoing) => {
    try {
      const body =
        incoming.method === 'GET' || incoming.method === 'HEAD'
          ? Buffer.alloc(0)
          : await readBody(incoming);
      const host = String(incoming.headers.host ?? '').split(':')[0] ?? '';
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      headers.set('Host', 'github.com');
      const request = new Request(`https://github.com${incoming.url}`, {
        method: incoming.method ?? 'GET',
        headers,
        ...(body.length > 0 ? { body: Uint8Array.from(body).buffer } : {}),
      });
      state.handler.push({
        host,
        method: request.method,
        path: new URL(request.url).pathname,
        auth: classifyAuthorization(request.headers.get('authorization')),
      });
      const response = await handleManagedScmOutbound(request, env, {
        containerId: 'synthetic-container',
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) outgoing.setHeader(name, value);
      });
      outgoing.writeHead(response.status);
      outgoing.write(responseBody);
      outgoing.end();
    } catch {
      outgoing.writeHead(500);
      outgoing.end('Synthetic handler failure');
    }
  };

  const backend: Server = createHttpServer(handleBackend);
  await listen(backend, 0);
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === 'string')
    throw new Error('Invalid backend address');
  const backendUrl = `http://127.0.0.1:${backendAddress.port}`;

  // The fixture is always reached through an owned CONNECT proxy so a followed
  // redirect to any host, port, or scheme observably trips the proxy and fails
  // the case. The proxy forwards raw TCP bytes to a local HTTPS server; the
  // client terminates TLS with the process-scoped trusted certificate. This
  // avoids the manual TLS-socket hand-off, which does not complete under Bun's
  // runtime with real Git clients.
  const frontend: ReturnType<typeof createHttpsServer> = createHttpsServer(tls, handleFrontend);
  await listen(frontend, 0);
  const frontendAddress = frontend.address();
  if (!frontendAddress || typeof frontendAddress === 'string')
    throw new Error('Invalid frontend address');
  const frontendPort = frontendAddress.port;

  const proxy: Server = createHttpServer((incoming, outgoing) => {
    state.proxy.push({ absolute: incoming.url ?? '' });
    outgoing.writeHead(502);
    outgoing.end();
  });
  proxy.on('connect', (request, clientSocket, head) => {
    state.proxy.push({ connect: request.url ?? '' });
    const upstream = netConnect(frontendPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await listen(proxy, 0);
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Invalid proxy address');
  const proxyPort = proxyAddress.port;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'github.com') throw new Error('Unexpected external transport');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? await request.arrayBuffer() : undefined;
    return nativeFetch(new URL(url.pathname + url.search, backendUrl), {
      method: request.method,
      headers: request.headers,
      ...(body ? { body } : {}),
      redirect: 'manual',
    });
  }) as unknown as typeof fetch;

  return {
    root,
    homeRoot,
    certPath,
    commit,
    proxyPort,
    backendUrl,
    state,
    reset: mode => {
      state.mode = mode;
      state.handler.length = 0;
      state.backend.length = 0;
      state.proxy.length = 0;
      state.resolutions = 0;
      state.redemptions = 0;
      state.redeemedDiscoveryCount = 0;
      resolver = () => ({ credential: CAPABILITY });
    },
    setResolver: next => {
      resolver = next;
    },
    anonymousProbe: async () =>
      (await nativeFetch(`${backendUrl}${REPO_PREFIX}/info/refs?service=git-upload-pack`)).status,
    close: async () => {
      globalThis.fetch = nativeFetch;
      for (const server of [proxy, frontend, backend]) server.closeAllConnections();
      await Promise.all([closeServer(proxy), closeServer(frontend), closeServer(backend)]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function listen(server: NetServer, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: { close: (callback: () => void) => unknown } | null): Promise<void> {
  return new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
}

function fixtureGitEnv(fixture: Fixture): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(fixture.root, 'home'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSL_CAINFO: fixture.certPath,
    GIT_AUTHOR_NAME: 'Synthetic Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    // Process-scoped config: route every git connection through the owned
    // CONNECT proxy (so a followed redirect to any host/port/scheme is visible)
    // and reset the credential-helper list so a host system helper (for example
    // macOS Xcode's `osxkeychain`) cannot run on the follow-up request. System
    // config is otherwise preserved.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: `http://127.0.0.1:${fixture.proxyPort}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

function subcommandOf(args: string[]): string {
  let index = 0;
  while (index < args.length && args[index] === '-c') index += 2;
  return args[index] ?? '';
}

type GitOp = { subcommand: string; args: string[]; exitCode: number };

type PreparationOptions = {
  directory: string;
  token?: string;
  platform?: 'github' | 'gitlab' | 'bitbucket' | null;
  url?: string;
  branch?: string;
  hasGit?: boolean;
};

type PreparationResult = {
  frames: ControlPlaneWrapperFrame[];
  prepared: boolean;
  gitOps: GitOp[];
  directory: string;
};

async function prepareOnFixture(
  fixture: Fixture,
  options: PreparationOptions
): Promise<PreparationResult> {
  const directory = options.directory;
  await mkdir(directory, { recursive: true });
  const frames: ControlPlaneWrapperFrame[] = [];
  const gitOps: GitOp[] = [];
  const spec: ControlPlaneRouteSpec = {
    sessionId: 'workspace_synthetic',
    kiloSessionId: 'ses_synthetic',
    attemptId: 'synthetic-attempt',
    directory,
    branch: options.branch ?? 'main',
    runtimeIsolation: 'per-session',
    git: {
      url: options.url ?? GIT_URL,
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.platform === null ? {} : { platform: options.platform ?? 'github' }),
    },
    kilo: {
      scopeId: 'synthetic-scope',
      token: 'synthetic-kilo',
      containmentEnabled: true,
      targets: {
        backendBaseUrl: 'http://127.0.0.1:1',
        providerBaseUrl: 'http://127.0.0.1:1',
        sessionIngestBaseUrl: 'http://127.0.0.1:1',
      },
    },
  };
  const manager = createPreparationManager({
    timers: {
      ...CONTROL_PLANE_TIMERS,
      wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, cloneMs: 20_000 },
    },
    emit: frame => frames.push(frame),
    inheritedEnv: fixtureGitEnv(fixture),
    homeRoot: fixture.homeRoot,
    runGit: async (args: string[], processOptions?: ProcessOptions): Promise<ExecResult> => {
      const result = await git(args, { ...processOptions, hardTimeoutMs: 10_000 });
      gitOps.push({ subcommand: subcommandOf(args), args, exitCode: result.exitCode });
      return result;
    },
    runtimes: {
      ensure: async () => ({ serverUrl: 'http://127.0.0.1:1' }) as unknown as WrapperKiloClient,
      installCredentials: async () => undefined,
      isUnavailable: () => false,
      remove: () => undefined,
      release: () => undefined,
    },
    seedRegistration: async () => undefined,
    sessionExists: async () => true,
    hasGit: async () => options.hasGit ?? false,
    hasBootstrapMarker: async () => false,
    writeBootstrapMarker: async () => undefined,
    mkdir: async dir => {
      await mkdir(dir, { recursive: true });
    },
  });
  await manager.prepare(spec);
  return { frames, prepared: manager.isPrepared(spec.sessionId), gitOps, directory };
}

function opsFor(gitOps: GitOp[], subcommand: string): GitOp[] {
  return gitOps.filter(op => op.subcommand === subcommand);
}

function hasReady(frames: ControlPlaneWrapperFrame[]): boolean {
  return frames.some(frame => frame.type === 'session.ready');
}

function hasFailed(frames: ControlPlaneWrapperFrame[]): boolean {
  return frames.some(frame => frame.type === 'session.failed');
}

function hasCloneRetryProgress(frames: ControlPlaneWrapperFrame[]): boolean {
  return frames.some(
    frame => frame.type === 'session.progress' && (frame.detail ?? '').startsWith('Retrying clone')
  );
}

function authenticatedUrl(token: string): string {
  const url = new URL(GIT_URL);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

async function seedCachedRepo(fixture: Fixture, directory: string): Promise<void> {
  const env = fixtureGitEnv(fixture);
  await mkdir(directory, { recursive: true });
  await runExec('git', ['init', '--initial-branch=main', directory], { cwd: fixture.root, env });
  await runExec('git', ['-C', directory, 'remote', 'add', 'origin', authenticatedUrl(ALIAS)], {
    cwd: fixture.root,
    env,
  });
  await runExec('git', ['-C', directory, 'commit', '--allow-empty', '-m', 'seed'], {
    cwd: fixture.root,
    env,
  });
  const head = (
    await runExec('git', ['-C', directory, 'rev-parse', 'HEAD'], { cwd: fixture.root, env })
  ).trim();
  await runExec('git', ['-C', directory, 'update-ref', 'refs/remotes/origin/main', head], {
    cwd: fixture.root,
    env,
  });
}

async function checkedOutHead(directory: string): Promise<string> {
  return (
    await runExec('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
  ).trim();
}

async function findGitConfigFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findGitConfigFiles(child)));
    else if (entry.name === '.gitconfig') found.push(child);
  }
  return found;
}

const SAME_ORIGIN = '/synthetic/renamed.git';
const REDIRECT_VARIANTS = [
  {
    name: 'same-origin',
    discoveryLocation: `https://github.com${SAME_ORIGIN}/info/refs?service=git-upload-pack`,
    postLocation: `https://github.com${SAME_ORIGIN}/git-upload-pack`,
    targetPathFragment: SAME_ORIGIN,
  },
  {
    name: 'cross-host',
    discoveryLocation:
      'https://redirected.example/synthetic/repo.git/info/refs?service=git-upload-pack',
    postLocation: 'https://redirected.example/synthetic/repo.git/git-upload-pack',
    targetPathFragment: undefined,
  },
  {
    name: 'alternate-port',
    discoveryLocation:
      'https://github.com:8443/synthetic/repo.git/info/refs?service=git-upload-pack',
    postLocation: 'https://github.com:8443/synthetic/repo.git/git-upload-pack',
    targetPathFragment: undefined,
  },
  {
    name: 'downgrade',
    discoveryLocation: 'http://github.com/synthetic/repo.git/info/refs?service=git-upload-pack',
    postLocation: 'http://github.com/synthetic/repo.git/git-upload-pack',
    targetPathFragment: undefined,
  },
] as const;

function expectNoTargetRequest(fixture: Fixture, fragment: string | undefined): void {
  expect(fixture.state.proxy).toEqual([{ connect: 'github.com:443' }]);
  if (fragment) {
    expect(fixture.state.handler.some(hit => hit.path.includes(fragment))).toBe(false);
    expect(fixture.state.backend.some(hit => hit.path.includes(fragment))).toBe(false);
  }
}

async function expectExactCheckout(
  fixture: Fixture,
  directory: string,
  result: PreparationResult
): Promise<void> {
  expect(result.prepared).toBe(true);
  expect(hasReady(result.frames)).toBe(true);
  expect(hasFailed(result.frames)).toBe(false);
  expect(await checkedOutHead(directory)).toBe(fixture.commit);
  expect(await readFile(path.join(directory, 'fixture.txt'), 'utf8')).toBe(FIXTURE_CONTENT);
}

function expectRedeemedUpstream(fixture: Fixture): void {
  expect(fixture.state.backend.length).toBeGreaterThanOrEqual(1);
  expect(fixture.state.backend.every(hit => hit.auth === 'redeemed')).toBe(true);
}

function expectOneResolutionPerLogicalRequest(fixture: Fixture): void {
  expect(fixture.state.resolutions).toBe(fixture.state.redemptions);
  expect(fixture.state.redemptions).toBe(fixture.state.handler.length);
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await fixture.close();
});

describe('managed GitHub preparation invocation auth', () => {
  it('completes an eligible clone with alias auth on discovery and POST, redeemed upstream', async () => {
    fixture.reset({ kind: 'serve' });
    const directory = path.join(fixture.root, 'clone-first');
    const result = await prepareOnFixture(fixture, { directory, token: ALIAS });

    await expectExactCheckout(fixture, directory, result);

    const clones = opsFor(result.gitOps, 'clone');
    expect(clones).toHaveLength(1);
    expect(clones[0]!.exitCode).toBe(0);
    expect(clones[0]!.args.slice(0, 5)).toEqual([
      '-c',
      'http.https://github.com/.proactiveAuth=basic',
      '-c',
      'http.https://github.com/.followRedirects=false',
      'clone',
    ]);

    const discovery = fixture.state.handler.filter(hit => hit.method === 'GET');
    const uploadPack = fixture.state.handler.filter(hit => hit.method === 'POST');
    expect(discovery.length).toBeGreaterThanOrEqual(1);
    expect(uploadPack.length).toBeGreaterThanOrEqual(1);
    expect(discovery.every(hit => hit.auth === 'alias')).toBe(true);
    expect(
      uploadPack.every(hit => hit.auth === 'alias' && hit.path.endsWith('/git-upload-pack'))
    ).toBe(true);
    expectRedeemedUpstream(fixture);
    expectOneResolutionPerLogicalRequest(fixture);
    expect(await fixture.anonymousProbe()).toBe(429);
  }, 60_000);

  it('completes an eligible explicit :443 clone', async () => {
    fixture.reset({ kind: 'serve' });
    const directory = path.join(fixture.root, 'clone-443');
    const result = await prepareOnFixture(fixture, {
      directory,
      token: ALIAS,
      url: 'https://github.com:443/synthetic/repo.git',
    });

    await expectExactCheckout(fixture, directory, result);
    const clones = opsFor(result.gitOps, 'clone');
    expect(clones).toHaveLength(1);
    expect(clones[0]!.exitCode).toBe(0);
    expect(clones[0]!.args.slice(0, 5)).toEqual([
      '-c',
      'http.https://github.com/.proactiveAuth=basic',
      '-c',
      'http.https://github.com/.followRedirects=false',
      'clone',
    ]);
    expectRedeemedUpstream(fixture);
    expectOneResolutionPerLogicalRequest(fixture);
  }, 60_000);

  it('completes an eligible first-time review-ref fetch after clone', async () => {
    fixture.reset({ kind: 'serve' });
    const directory = path.join(fixture.root, 'fetch-first');
    const result = await prepareOnFixture(fixture, {
      directory,
      token: ALIAS,
      branch: 'refs/pull/12/head',
    });

    await expectExactCheckout(fixture, directory, result);
    const fetches = opsFor(result.gitOps, 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.exitCode).toBe(0);
    expect(fetches[0]!.args.slice(0, 5)).toEqual([
      '-c',
      'http.https://github.com/.proactiveAuth=basic',
      '-c',
      'http.https://github.com/.followRedirects=false',
      'fetch',
    ]);
    const uploadPack = fixture.state.handler.filter(
      hit => hit.method === 'POST' && hit.path.endsWith('/git-upload-pack')
    );
    expect(uploadPack.length).toBeGreaterThanOrEqual(1);
    expect(uploadPack.every(hit => hit.auth === 'alias')).toBe(true);
    expectRedeemedUpstream(fixture);
    expectOneResolutionPerLogicalRequest(fixture);
  }, 60_000);

  it('completes a cached review-ref fetch without cloning and with alias auth on fetch only', async () => {
    fixture.reset({ kind: 'serve' });
    const directory = path.join(fixture.root, 'fetch-cached');
    await seedCachedRepo(fixture, directory);
    const result = await prepareOnFixture(fixture, {
      directory,
      token: ALIAS,
      branch: 'refs/pull/12/head',
      hasGit: true,
    });

    await expectExactCheckout(fixture, directory, result);
    expect(opsFor(result.gitOps, 'clone')).toHaveLength(0);
    const fetches = opsFor(result.gitOps, 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.exitCode).toBe(0);
    expect(fetches[0]!.args[0]).toBe('-c');
    const checkouts = opsFor(result.gitOps, 'checkout');
    expect(checkouts.every(op => op.args[0] !== '-c')).toBe(true);
    const uploadPack = fixture.state.handler.filter(
      hit => hit.method === 'POST' && hit.path.endsWith('/git-upload-pack')
    );
    expect(uploadPack.length).toBeGreaterThanOrEqual(1);
    expect(uploadPack.every(hit => hit.auth === 'alias')).toBe(true);
    expectRedeemedUpstream(fixture);
    expectOneResolutionPerLogicalRequest(fixture);
  }, 60_000);

  it('does not pass options on a cached normal-branch checkout', async () => {
    fixture.reset({ kind: 'serve' });
    const directory = path.join(fixture.root, 'cached-main');
    await seedCachedRepo(fixture, directory);
    const result = await prepareOnFixture(fixture, { directory, token: ALIAS, hasGit: true });

    expect(result.prepared).toBe(true);
    expect(opsFor(result.gitOps, 'clone')).toHaveLength(0);
    expect(opsFor(result.gitOps, 'fetch')).toHaveLength(0);
    const checkouts = opsFor(result.gitOps, 'checkout');
    expect(checkouts.length).toBeGreaterThanOrEqual(1);
    expect(
      result.gitOps.every(
        op =>
          !op.args.includes('http.https://github.com/.proactiveAuth=basic') &&
          !op.args.includes('http.https://github.com/.followRedirects=false')
      )
    ).toBe(true);
  }, 60_000);

  it('completes a direct-credential 401 challenge without the options', async () => {
    fixture.reset({ kind: 'direct-401' });
    const directory = path.join(fixture.root, 'direct-401');
    const result = await prepareOnFixture(fixture, { directory, token: DIRECT_TOKEN });

    await expectExactCheckout(fixture, directory, result);
    const clones = opsFor(result.gitOps, 'clone');
    expect(clones).toHaveLength(1);
    expect(clones[0]!.exitCode).toBe(0);
    expect(clones[0]!.args[0]).toBe('clone');
    expect(
      result.gitOps.every(
        op =>
          !op.args.includes('http.https://github.com/.proactiveAuth=basic') &&
          !op.args.includes('http.https://github.com/.followRedirects=false')
      )
    ).toBe(true);
    expect(fixture.state.redemptions).toBe(0);
    expect(fixture.state.backend.some(hit => hit.auth === 'none')).toBe(true);
    expect(fixture.state.backend.some(hit => hit.auth === 'direct')).toBe(true);
  }, 60_000);

  it('completes an authenticated reset-bearing 429 with one redemption and one reissue', async () => {
    fixture.reset({ kind: 'retry-once' });
    const directory = path.join(fixture.root, 'retry-once');
    const result = await prepareOnFixture(fixture, { directory, token: ALIAS });

    await expectExactCheckout(fixture, directory, result);
    const clones = opsFor(result.gitOps, 'clone');
    expect(clones).toHaveLength(1);
    expect(clones[0]!.exitCode).toBe(0);

    const handlerDiscovery = fixture.state.handler.filter(
      hit => hit.method === 'GET' && hit.path.endsWith('/info/refs')
    );
    const backendDiscovery = fixture.state.backend.filter(
      hit => hit.method === 'GET' && hit.path.endsWith('/info/refs')
    );
    expect(handlerDiscovery).toHaveLength(1);
    expect(backendDiscovery).toHaveLength(2);
    expect(fixture.state.redeemedDiscoveryCount).toBe(2);
    expectOneResolutionPerLogicalRequest(fixture);
  }, 60_000);

  it('fails preparation when the resolver rejects the alias, with no redeemed upstream request', async () => {
    fixture.reset({ kind: 'serve' });
    fixture.setResolver(() => null);
    const directory = path.join(fixture.root, 'revoked');
    const result = await prepareOnFixture(fixture, { directory, token: ALIAS });

    expect(result.prepared).toBe(false);
    expect(hasFailed(result.frames)).toBe(true);
    expect(fixture.state.backend).toHaveLength(0);
    expect(fixture.state.redemptions).toBe(0);
  }, 60_000);

  it('persists no auth setting in the clone config or the isolated home', async () => {
    fixture.reset({ kind: 'serve' });
    const directory = path.join(fixture.root, 'persist');
    const result = await prepareOnFixture(fixture, { directory, token: ALIAS });
    expect(result.prepared).toBe(true);

    const config = await readFile(path.join(directory, '.git', 'config'), 'utf8');
    expect(config).not.toMatch(/proactiveAuth|followRedirects|extraHeader|Authorization/i);

    for (const configPath of await findGitConfigFiles(fixture.homeRoot)) {
      expect(await readFile(configPath, 'utf8')).not.toMatch(
        /proactiveAuth|followRedirects|extraHeader|Authorization/i
      );
    }
  }, 60_000);

  describe('redirect matrix', () => {
    for (const variant of REDIRECT_VARIANTS) {
      it(`clone rejects a ${variant.name} discovery redirect with no POST or target request`, async () => {
        fixture.reset({ kind: 'discovery-redirect', location: variant.discoveryLocation });
        const directory = path.join(fixture.root, `redirect-clone-discovery-${variant.name}`);
        const result = await prepareOnFixture(fixture, { directory, token: ALIAS });

        expect(result.prepared).toBe(false);
        expect(hasFailed(result.frames)).toBe(true);
        expect(hasCloneRetryProgress(result.frames)).toBe(false);
        const clones = opsFor(result.gitOps, 'clone');
        expect(clones).toHaveLength(1);
        expect(clones[0]!.exitCode).not.toBe(0);
        const handlerGets = fixture.state.handler.filter(hit => hit.method === 'GET');
        const handlerPosts = fixture.state.handler.filter(hit => hit.method === 'POST');
        expect(handlerGets).toHaveLength(1);
        expect(handlerPosts).toHaveLength(0);
        expectNoTargetRequest(fixture, variant.targetPathFragment);
      }, 60_000);

      it(`clone rejects a ${variant.name} upload-pack redirect with no target request`, async () => {
        fixture.reset({ kind: 'post-redirect', location: variant.postLocation });
        const directory = path.join(fixture.root, `redirect-clone-post-${variant.name}`);
        const result = await prepareOnFixture(fixture, { directory, token: ALIAS });

        expect(result.prepared).toBe(false);
        expect(hasFailed(result.frames)).toBe(true);
        const clones = opsFor(result.gitOps, 'clone');
        expect(clones).toHaveLength(1);
        expect(clones[0]!.exitCode).not.toBe(0);
        const handlerGets = fixture.state.handler.filter(hit => hit.method === 'GET');
        const handlerPosts = fixture.state.handler.filter(
          hit => hit.method === 'POST' && hit.path.endsWith('/git-upload-pack')
        );
        expect(handlerGets.length).toBeGreaterThanOrEqual(1);
        expect(handlerPosts.length).toBeGreaterThanOrEqual(1);
        expectNoTargetRequest(fixture, variant.targetPathFragment);
      }, 60_000);

      it(`fetch rejects a ${variant.name} discovery redirect with no POST or target request`, async () => {
        fixture.reset({ kind: 'discovery-redirect', location: variant.discoveryLocation });
        const directory = path.join(fixture.root, `redirect-fetch-discovery-${variant.name}`);
        await seedCachedRepo(fixture, directory);
        const result = await prepareOnFixture(fixture, {
          directory,
          token: ALIAS,
          branch: 'refs/pull/12/head',
          hasGit: true,
        });

        expect(result.prepared).toBe(false);
        expect(hasFailed(result.frames)).toBe(true);
        expect(hasCloneRetryProgress(result.frames)).toBe(false);
        const fetches = opsFor(result.gitOps, 'fetch');
        expect(fetches).toHaveLength(1);
        expect(fetches[0]!.exitCode).not.toBe(0);
        const handlerGets = fixture.state.handler.filter(hit => hit.method === 'GET');
        const handlerPosts = fixture.state.handler.filter(hit => hit.method === 'POST');
        expect(handlerGets).toHaveLength(1);
        expect(handlerPosts).toHaveLength(0);
        expectNoTargetRequest(fixture, variant.targetPathFragment);
      }, 60_000);

      it(`fetch rejects a ${variant.name} upload-pack redirect with no target request`, async () => {
        fixture.reset({ kind: 'post-redirect', location: variant.postLocation });
        const directory = path.join(fixture.root, `redirect-fetch-post-${variant.name}`);
        await seedCachedRepo(fixture, directory);
        const result = await prepareOnFixture(fixture, {
          directory,
          token: ALIAS,
          branch: 'refs/pull/12/head',
          hasGit: true,
        });

        expect(result.prepared).toBe(false);
        expect(hasFailed(result.frames)).toBe(true);
        const fetches = opsFor(result.gitOps, 'fetch');
        expect(fetches).toHaveLength(1);
        expect(fetches[0]!.exitCode).not.toBe(0);
        const handlerGets = fixture.state.handler.filter(hit => hit.method === 'GET');
        const handlerPosts = fixture.state.handler.filter(
          hit => hit.method === 'POST' && hit.path.endsWith('/git-upload-pack')
        );
        expect(handlerGets.length).toBeGreaterThanOrEqual(1);
        expect(handlerPosts.length).toBeGreaterThanOrEqual(1);
        expectNoTargetRequest(fixture, variant.targetPathFragment);
      }, 60_000);
    }
  });
});
