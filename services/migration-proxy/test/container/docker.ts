import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Docker fixtures for the container suite: a test CA and a server certificate for `db.test`,
 * Supabase's Postgres image with TLS on, the proxy image built from container/ alone, and the
 * proxy container started on the same network with the test CA in place of the bundled one.
 */

export const SERVICE = join(import.meta.dirname, '../..');
export const DB_HOST = 'db.test';
export const ADMIN_PASSWORD = 'admin-password-for-tests-only';

const run = (command: string, args: string[], input?: string) =>
  execFileSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim();
export const docker = (...args: string[]) => run('docker', args);

const suffix = Math.random().toString(36).slice(2, 8);
const created: string[] = [];
let network: string | null = null;
let certDir: string | null = null;

export function testNetwork(): string {
  if (network === null) {
    network = `mp-test-${suffix}`;
    docker('network', 'create', network);
  }
  return network;
}

/** A CA and a `db.test` server certificate it signs, plus an unrelated CA. */
export function certificates(): { dir: string; ca: string; otherCa: string } {
  if (certDir === null) {
    certDir = mkdtempSync(join(tmpdir(), 'mp-certs-'));
    const at = (name: string) => join(certDir ?? '', name);
    const openssl = (...args: string[]) => run('openssl', args);
    for (const name of ['ca', 'other-ca']) {
      openssl(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        `/CN=Migration proxy test ${name}`,
        '-keyout',
        at(`${name}.key`),
        '-out',
        at(`${name}.pem`),
        '-addext',
        'basicConstraints=critical,CA:TRUE'
      );
    }
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${DB_HOST}`,
      '-keyout',
      at('server.key'),
      '-out',
      at('server.csr')
    );
    writeFileSync(at('server.ext'), `subjectAltName=DNS:${DB_HOST}\nbasicConstraints=CA:FALSE\n`);
    openssl(
      'x509',
      '-req',
      '-in',
      at('server.csr'),
      '-CA',
      at('ca.pem'),
      '-CAkey',
      at('ca.key'),
      '-CAcreateserial',
      '-days',
      '2',
      '-out',
      at('server.crt'),
      '-extfile',
      at('server.ext')
    );
  }
  return { dir: certDir, ca: join(certDir, 'ca.pem'), otherCa: join(certDir, 'other-ca.pem') };
}

export type Postgres = {
  name: string;
  image: string;
  port: number;
  admin: () => Promise<pg.Client>;
  /** A session from the test process as `user`, labelled `applicationName`. */
  session: (
    user: string,
    password: string,
    applicationName: string,
    database?: string
  ) => Promise<pg.Client>;
  psql: (args: string[], env?: Record<string, string>, input?: string) => string;
  exec: (...args: string[]) => string;
};

/** Supabase's image with TLS on, reachable as `db.test` on the test network. */
export async function startPostgres(image: string, label: string): Promise<Postgres> {
  const { dir } = certificates();
  const name = `mp-${label}-${suffix}`;
  const start = [
    'mkdir -p /certs',
    'cp /certs-src/server.crt /certs-src/server.key /certs/',
    'chown postgres /certs/server.key /certs/server.crt',
    'chmod 600 /certs/server.key',
    'exec docker-entrypoint.sh postgres -D /etc/postgresql -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key -c hot_standby=on',
  ].join(' && ');
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    testNetwork(),
    '--network-alias',
    DB_HOST,
    '-e',
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    '-v',
    `${dir}:/certs-src:ro`,
    '-p',
    '127.0.0.1::5432',
    '--entrypoint',
    'bash',
    image,
    '-c',
    start
  );
  created.push(name);
  const port = Number(docker('port', name, '5432/tcp').split('\n')[0]?.split(':').pop());
  const connect = async (
    user: string,
    password: string,
    applicationName: string,
    database = 'postgres'
  ) => {
    const client = new pg.Client({
      host: '127.0.0.1',
      port,
      user,
      password,
      database,
      application_name: applicationName,
    });
    client.on('error', () => {});
    await client.connect();
    return client;
  };
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      // The image restarts once after its init scripts; wait for a server that stays up.
      const client = await connect('supabase_admin', ADMIN_PASSWORD, 'test-admin');
      const result = await client.query<{ ready: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') AS ready"
      );
      await client.end();
      if (result.rows[0]?.ready) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const again = await connect('supabase_admin', ADMIN_PASSWORD, 'test-admin');
        await again.end();
        break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error(`${image} did not start: ${docker('logs', '--tail', '40', name)}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return {
    name,
    image,
    port,
    admin: () => connect('supabase_admin', ADMIN_PASSWORD, 'test-admin'),
    session: connect,
    psql: (args, env = {}, input) =>
      run(
        'docker',
        [
          'exec',
          '-i',
          ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          name,
          'psql',
          '-h',
          '127.0.0.1',
          '-d',
          'postgres',
          ...args,
        ],
        input
      ),
    exec: (...args) => docker('exec', name, ...args),
  };
}

let builtImage: string | null = null;

/** The proxy image, built exactly as wrangler builds it: from container/ alone. */
export function proxyImage(): string {
  if (builtImage === null) {
    builtImage = `migration-proxy-test:${suffix}`;
    docker('build', '-q', '-t', builtImage, join(SERVICE, 'container'));
  }
  return builtImage;
}

/** `GET /status` of the container (container/src/apply.ts `RunStatus`). */
export type RunStatus = {
  runId: string;
  phase: 'probing' | 'migrating' | 'done';
  pair: { pid: number; backendStart: string } | null;
  pending: string[] | null;
  applied: { tag: string; hash: string; createdAt: number }[];
  cleanup: { terminated: number; unexpected: number } | null;
  failure: {
    code: string;
    reason: string | null;
    sqlstate: string | null;
    migrationTag: string | null;
    indexes: string[];
  } | null;
  heartbeatAt: string;
};

/** Any JSON answer of the container; each test reads the fields of the route it called. */
export type Reply = RunStatus & {
  result?: 'ok' | 'failed';
  reason?: string | null;
  unexpected?: number;
  leftover?: number;
};

export type ProxyContainer = {
  name: string;
  /** JSON over the container's port, as the Durable Object talks to it. */
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Reply }>;
  logs: () => string;
  kill: () => void;
  stop: () => void;
};

/** Starts the proxy container with `caFile` mounted over its bundled CA. */
export async function startProxy(caFile = certificates().ca): Promise<ProxyContainer> {
  const name = `mp-proxy-${suffix}-${created.length}`;
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    testNetwork(),
    '-p',
    '127.0.0.1::8080',
    '-v',
    `${caFile}:/app/ca-bundle.pem:ro`,
    proxyImage()
  );
  created.push(name);
  const port = Number(docker('port', name, '8080/tcp').split('\n')[0]?.split(':').pop());
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // The container's own JSON; each test checks the fields it reads.
    const reply = (await response.json().catch(() => null)) as Reply;
    return { status: response.status, body: reply };
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await call('GET', '/health')).status === 200) break;
    } catch {
      if (attempt > 50) throw new Error(`proxy did not start: ${docker('logs', name)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return {
    name,
    call,
    logs: () =>
      execFileSync('docker', ['logs', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }) +
      execFileSync('bash', ['-c', `docker logs ${name} 2>&1 >/dev/null`], { encoding: 'utf8' }),
    kill: () => docker('kill', name),
    stop: () => docker('stop', '-t', '15', name),
  };
}

export function cleanup(): void {
  for (const name of created.splice(0)) {
    try {
      docker('rm', '-f', '-v', name);
    } catch {
      // already gone
    }
  }
  if (network !== null) docker('network', 'rm', network);
  network = null;
  if (certDir !== null) rmSync(certDir, { recursive: true, force: true });
  certDir = null;
  if (builtImage !== null) docker('rmi', '-f', builtImage);
  builtImage = null;
}

/** Polls `/status` until the run is done. */
export async function waitDone(proxy: ProxyContainer, timeoutMs = 120_000): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await proxy.call('GET', '/status');
    if (status.body?.phase === 'done') return status.body;
    if (Date.now() > deadline) throw new Error(`run not done: ${JSON.stringify(status.body)}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

export function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mp-file-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

export const setupLoginSql = () => readFileSync(join(SERVICE, 'sql/setup-login.sql'), 'utf8');
