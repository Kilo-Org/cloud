import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { createPreparationManager } from '../../wrapper/src/control-plane/prepare.js';
import { git } from '../../wrapper/src/utils.js';

const exec = promisify(execFile);
const alias = createControlPlaneCredential('synthetic-sandbox', 'github');
const authorization = `Basic ${Buffer.from(`x-access-token:${alias}`).toString('base64')}`;
const url = `https://x-access-token:${alias}@github.com/synthetic/repo.git`;
const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
const connections: string[] = [];
let redirect: string | undefined;
let root: string;
let env: Record<string, string>;
let https: ReturnType<typeof createHttpsServer>;
let proxy: ReturnType<typeof createHttpServer>;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return address.port;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'managed-github-auth-'));
  const key = path.join(root, 'key.pem');
  const cert = path.join(root, 'cert.pem');
  await exec('openssl', [
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
    key,
    '-out',
    cert,
  ]);
  https = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      if (req.headers.authorization !== authorization) {
        res.writeHead(429).end('Anonymous rate limit');
      } else if (redirect) {
        res.writeHead(302, { Location: redirect }).end();
      } else {
        // An empty smart-HTTP repository is enough to complete discovery and clone.
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
        res.end('001e# service=git-upload-pack\n00000000');
      }
    }
  );
  const httpsPort = await listen(https);
  proxy = createHttpServer((req, res) => {
    connections.push(req.url ?? '');
    res.writeHead(502).end();
  });
  proxy.on('connect', (req, client, head) => {
    connections.push(req.url ?? '');
    if (req.url !== 'github.com:443') {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = connect(httpsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSL_CAINFO: cert,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: `http://127.0.0.1:${proxyPort}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
});

afterAll(async () => {
  for (const server of [proxy, https]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  connections.length = 0;
  redirect = undefined;
});

async function preparationCommand(
  command: 'clone' | 'fetch',
  directory: string
): Promise<string[]> {
  let captured: string[] | undefined;
  const manager = createPreparationManager({
    timers: CONTROL_PLANE_TIMERS,
    emit: () => undefined,
    inheritedEnv: {},
    homeRoot: path.join(root, 'homes'),
    mkdir: async () => undefined,
    hasGit: async () => command === 'fetch',
    hasBootstrapMarker: async () => false,
    runGit: async args => {
      if (args.includes(command)) captured = args;
      return { exitCode: 128, stdout: '', stderr: 'fatal: Authentication failed' };
    },
    runtimes: {
      ensure: async () => {
        throw new Error('Only testing Git preparation');
      },
      installCredentials: async () => undefined,
      isUnavailable: () => false,
      remove: () => undefined,
      release: () => undefined,
    },
  });
  await manager.prepare({
    sessionId: 'workspace_synthetic',
    kiloSessionId: 'ses_synthetic',
    attemptId: 'attempt',
    directory,
    branch: 'refs/pull/12/head',
    git: { url: 'https://github.com/synthetic/repo.git', token: alias, platform: 'github' },
    kilo: {
      scopeId: 'synthetic',
      token: 'synthetic-kilo',
      targets: {
        backendBaseUrl: 'http://127.0.0.1:1',
        providerBaseUrl: 'http://127.0.0.1:1',
        sessionIngestBaseUrl: 'http://127.0.0.1:1',
      },
    },
  });
  if (!captured) throw new Error(`Preparation did not invoke ${command}`);
  return captured;
}

it('authenticates the first clone request instead of failing on anonymous discovery', async () => {
  const directory = path.join(root, 'clone');
  const args = await preparationCommand('clone', directory);
  const options = { env, inheritEnv: false, hardTimeoutMs: 5_000 };
  const anonymous = await git(['clone', url, directory], options);
  expect(anonymous.exitCode).not.toBe(0);
  expect(anonymous.stderr).toContain('429');
  expect(requests).toEqual([
    { url: '/synthetic/repo.git/info/refs?service=git-upload-pack', authorization: undefined },
  ]);

  requests.length = 0;
  const authenticated = await git(args, options);
  expect(authenticated.exitCode, authenticated.stderr).toBe(0);
  expect(requests).toEqual([
    { url: '/synthetic/repo.git/info/refs?service=git-upload-pack', authorization },
  ]);
  expect(await readFile(path.join(directory, '.git/config'), 'utf8')).not.toMatch(
    /proactiveAuth|followRedirects/i
  );
});

it.each(['clone', 'fetch'] as const)(
  '%s refuses redirects without forwarding the alias',
  async command => {
    const directory = await mkdtemp(path.join(root, `${command}-`));
    if (command === 'fetch') {
      await exec('git', ['init', directory], { env });
      await exec('git', ['-C', directory, 'remote', 'add', 'origin', url], { env });
    }
    const args = await preparationCommand(command, directory);
    for (const target of [
      'https://github.com/renamed/repo.git',
      'https://other.example/repo.git',
      'https://github.com:8443/repo.git',
      'http://github.com/repo.git',
    ]) {
      requests.length = 0;
      connections.length = 0;
      redirect = `${target}/info/refs?service=git-upload-pack`;
      const result = await git(args, {
        cwd: directory,
        env,
        inheritEnv: false,
        hardTimeoutMs: 5_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('302');
      expect(requests).toEqual([
        { url: '/synthetic/repo.git/info/refs?service=git-upload-pack', authorization },
      ]);
      expect(connections).toEqual(['github.com:443']);
    }
  }
);
