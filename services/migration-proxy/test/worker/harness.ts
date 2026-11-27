import type { AttestedGithubRun, GithubRunAttestationResult } from '@kilocode/sts-contracts';
import { env, runInDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';
import type { Attested } from '../../src/attest';
import { MigrationRunDO } from '../../src/dos/MigrationRunDO';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { FakeGithub } from '../support/fake-github';

/**
 * Builds a `MigrationRunDO` on a real SQLite storage with a fake container, a fake STS and a fake
 * GitHub (global fetch), and drives its alarms by hand. Alarms are recorded rather than set, so
 * the runtime never fires one on its own.
 */

export const PRODUCTION_WORKFLOW =
  'Kilo-Org/cloud/.github/workflows/deploy-production.yml@refs/heads/main';

export const VARS: Record<string, string> = {
  MIGRATION_PROXY_ENVIRONMENT: 'production',
  MIGRATION_DB_TARGET: 'db.test.invalid:5432/postgres',
  MIGRATION_DB_USER: 'kilo_migration_proxy',
  MIGRATION_DB_LOGIN_MODE: 'member',
  MIGRATION_SESSION_KEY: 'label',
  MIGRATION_SESSION_SAMPLE_MINUTES: '60',
  MIGRATION_RUN_DEADLINE_SECONDS: '21600',
  MIGRATION_PROXY_GITHUB_APP_ID: '12345',
  MIGRATION_PROXY_GITHUB_INSTALLATION_ID: '67890',
  MIGRATION_REVIEW_BASELINE_SHA: '0000000000000000000000000000000000000001',
};

export type ContainerStatus = {
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

/** A container whose server is scripted; every call goes to `log`. */
export class FakeContainer {
  running = false;
  readonly images: Record<string, string> = { proxy: 'registry.test/migration-proxy:proxy' };
  startOptions: unknown = null;
  denyHandlers: Fetcher[] = [];
  applyBodies: Record<string, unknown>[] = [];
  sampleBodies: Record<string, unknown>[] = [];
  /** What `/status` answers; null makes it fail. */
  status: ((runId: string) => ContainerStatus) | null = runId => ({
    runId,
    phase: 'migrating',
    pair: { pid: 101, backendStart: '2026-11-27T10:00:00.000000Z' },
    pending: [],
    applied: [],
    cleanup: { terminated: 0, unexpected: 0 },
    failure: null,
    heartbeatAt: new Date().toISOString(),
  });
  sample: Record<string, unknown> = {
    result: 'ok',
    reason: null,
    pair: { pid: 202, backendStart: '2026-11-27T11:00:00.000000Z' },
    unexpected: 0,
    leftover: 0,
  };
  private runId: string | null = null;

  constructor(
    readonly log: string[],
    readonly insideBlock: () => boolean
  ) {}

  /** Thrown by `start()`, as the runtime does for options it refuses. */
  startError: Error | null = null;
  /** What `/apply` answers instead of 202, when set. */
  applyStatus: number | null = null;
  /** `/status` waits for this before answering, when set: a slow answer arriving late. */
  statusGate: Promise<void> | null = null;

  start(options: unknown): void {
    if (this.startError !== null) throw this.startError;
    this.log.push('start');
    this.startOptions = options;
    this.running = true;
  }
  async setInactivityTimeout(ms: number): Promise<void> {
    this.log.push(`setInactivityTimeout:${ms}:${this.insideBlock() ? 'blocked' : 'free'}`);
  }
  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.log.push('interceptAllOutboundHttp');
    this.denyHandlers.push(binding);
  }
  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    this.log.push(`interceptOutboundHttps:${addr}`);
    this.denyHandlers.push(binding);
  }
  async destroy(): Promise<void> {
    this.log.push('destroy');
    this.running = false;
    this.runId = null;
  }
  getTcpPort(port: number) {
    return {
      fetch: async (input: string, init: RequestInit = {}) => {
        if (!this.running || port !== 8080) throw new Error('container port closed');
        const path = new URL(input).pathname;
        const method = init.method ?? 'GET';
        this.log.push(`${method} ${path}`);
        if (path === '/health') return Response.json({ ok: true });
        if (path === '/apply') {
          if (this.applyStatus !== null) return Response.json({}, { status: this.applyStatus });
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          this.applyBodies.push(body);
          if (this.runId !== null && this.runId !== body.runId)
            return Response.json({}, { status: 409 });
          this.runId = String(body.runId);
          return Response.json({ runId: body.runId }, { status: 202 });
        }
        if (path === '/status') {
          if (this.status === null || this.runId === null) throw new Error('status failed');
          // The answer is taken now and delivered after the gate: a late answer.
          const answer = this.status(this.runId);
          if (this.statusGate !== null) await this.statusGate;
          return Response.json(answer);
        }
        if (path === '/sample') {
          this.sampleBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
          return Response.json(this.sample);
        }
        if (path === '/cancel') return Response.json({ ok: true }, { status: 202 });
        return Response.json({}, { status: 404 });
      },
    };
  }
}

export function attestedRun(overrides: Partial<AttestedGithubRun> = {}): AttestedGithubRun {
  return {
    repositoryId: '1145038391',
    repositoryOwnerId: '201822503',
    environment: 'production',
    ref: 'refs/heads/main',
    sha: 'f'.repeat(40),
    eventName: 'workflow_run',
    jobWorkflowRef: PRODUCTION_WORKFLOW,
    runId: '1000',
    runAttempt: '1',
    ...overrides,
  };
}

export function attested(
  overrides: Partial<AttestedGithubRun> = {},
  workload = 'ci-db-migrate'
): Attested {
  return { workload, github: attestedRun(overrides) };
}

export class FakeSts {
  /** token → answer; an unknown token is identity_rejected. */
  attestations = new Map<string, GithubRunAttestationResult>();
  attestThrows = false;
  secrets: Record<string, string> = {
    MIGRATION_PROXY_DB_PASSWORD: 'sentinel-db-password',
    MIGRATION_PROXY_GITHUB_APP_KEY: '',
  };
  bundleCalls = 0;

  async attestGithubRun({ token }: { token: string }): Promise<GithubRunAttestationResult> {
    if (this.attestThrows) throw new Error('sts down');
    return this.attestations.get(token) ?? { status: 'denied', reason: 'identity_rejected' };
  }

  async getBundle() {
    this.bundleCalls += 1;
    return {
      status: 'ok' as const,
      workload: 'migration-proxy',
      environment: 'production' as const,
      etag: '"etag-0123456789abcdef"',
      stale: false,
      fetchedAt: new Date().toISOString(),
      secrets: Object.fromEntries(
        Object.entries(this.secrets).map(([name, value]) => [name, { value, version: 1 }])
      ),
      missing: [],
    };
  }

  allow(token: string, run: Attested): void {
    this.attestations.set(token, {
      status: 'ok',
      workload: run.workload,
      github: run.github,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  }
}

let keyPem: string | null = null;
/** A throwaway RSA key in PKCS#1 PEM, the form GitHub issues App keys in. */
export async function appKeyPem(): Promise<string> {
  if (keyPem !== null) return keyPem;
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const pkcs8 = new Uint8Array(exported);
  keyPem = pem('RSA PRIVATE KEY', pkcs1Of(pkcs8));
  return keyPem;
}

/** The DER length at `offset`: [length, bytes the length field used]. */
function derLength(bytes: Uint8Array, offset: number): [number, number] {
  const first = bytes[offset];
  if (first < 0x80) return [first, 1];
  let length = 0;
  for (let index = 1; index <= (first & 0x7f); index += 1)
    length = length * 256 + bytes[offset + index];
  return [length, 1 + (first & 0x7f)];
}

/** The `RSAPrivateKey` inside a PKCS#8 `PrivateKeyInfo`: its third element, an OCTET STRING. */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
  let offset = 1 + derLength(pkcs8, 1)[1];
  for (let element = 0; element < 2; element += 1) {
    const [length, used] = derLength(pkcs8, offset + 1);
    offset += 1 + used + length;
  }
  const [length, used] = derLength(pkcs8, offset + 1);
  return pkcs8.slice(offset + 1 + used, offset + 1 + used + length);
}

function pem(label: string, der: Uint8Array): string {
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/(.{64})/g, '$1\n');
  const fence = '-----';
  return `${fence}BEGIN ${label}${fence}\n${body}\n${fence}END ${label}${fence}\n`;
}

export type Proxy = {
  object: MigrationRunDO;
  container: FakeContainer;
  github: FakeGithub;
  sts: FakeSts;
  env: Env;
  log: string[];
  /** The alarm the object last asked for. */
  alarmAt: () => number | null;
  /** Forgets the alarm, as if the runtime lost it. */
  clearAlarm: () => void;
  /** Runs alarms until no run is active or `max` ran. */
  drive: (max?: number) => Promise<void>;
  /** The Worker's fetch against this object. */
  request: (
    method: string,
    path: string,
    init?: { token?: string; body?: string }
  ) => Promise<Response>;
  /** Builds a second object over the same storage, as a restarted object would be. */
  restart: () => Promise<MigrationRunDO>;
  queue: unknown[];
  /** How the Worker addressed the object: `eu:<name>` through the jurisdiction, `plain:<name>`. */
  routes: string[];
  /** The audit outbox, oldest first. */
  events: () => { type: string; data: { outcome: string; attributes: Record<string, unknown> } }[];
  /** One SQL query against the object's storage. */
  sql: <T extends Record<string, SqlStorageValue>>(query: string) => T[];
};

export async function withProxy<T>(
  options: { vars?: Record<string, string | undefined>; containerRunning?: boolean },
  body: (proxy: Proxy) => Promise<T>
): Promise<T> {
  const stub = env.MIGRATION_RUN_DO.idFromName(crypto.randomUUID());
  return await runInDurableObject(env.MIGRATION_RUN_DO.get(stub), async (_instance, state) => {
    const log: string[] = [];
    let inside = false;
    let alarm: number | null = null;
    const container = new FakeContainer(log, () => inside);
    container.running = options.containerRunning ?? false;
    const github = new FakeGithub();
    const sts = new FakeSts();
    sts.secrets.MIGRATION_PROXY_GITHUB_APP_KEY = await appKeyPem();
    const queue: unknown[] = [];
    const storage = new Proxy(state.storage, {
      get(target, property) {
        if (property === 'setAlarm') {
          return async (at: number | Date) => {
            alarm = typeof at === 'number' ? at : at.getTime();
          };
        }
        if (property === 'getAlarm') return async () => alarm;
        if (property === 'deleteAlarm') {
          return async () => {
            alarm = null;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const vars = Object.fromEntries(
      Object.entries({ ...VARS, ...options.vars }).filter(([, value]) => value !== undefined)
    );
    const proxyEnv = {
      ...vars,
      STS: sts,
      AUDIT_QUEUE: {
        send: async (body: unknown) => {
          queue.push(body);
        },
      },
    } as unknown as Env;
    let ready: Promise<unknown> = Promise.resolve();
    // The runtime refuses any other object as a Durable Object's state, so the real one gets the
    // fakes as own properties, shadowing its container, storage and blockConcurrencyWhile.
    const ctx = state;
    const shadow = (name: string, value: unknown) =>
      Object.defineProperty(ctx, name, { value, configurable: true, writable: true });
    shadow('container', container);
    shadow('storage', storage);
    shadow('blockConcurrencyWhile', (fn: () => Promise<unknown>) => {
      log.push('blockConcurrencyWhile');
      inside = true;
      ready = fn().finally(() => {
        inside = false;
      });
      return ready;
    });
    const build = async () => {
      const object = new MigrationRunDO(ctx, proxyEnv);
      await ready;
      return object;
    };
    let object = await build();
    const routes: string[] = [];
    proxyEnv.MIGRATION_RUN_DO = {
      jurisdiction: (name: string) => ({
        getByName: (objectName: string) => {
          routes.push(`${name}:${objectName}`);
          return object;
        },
      }),
      getByName: (objectName: string) => {
        routes.push(`plain:${objectName}`);
        return object;
      },
    } as unknown as Env['MIGRATION_RUN_DO'];
    vi.stubGlobal('fetch', github.fetch);
    try {
      return await body({
        get object() {
          return object;
        },
        container,
        github,
        sts,
        env: proxyEnv,
        log,
        queue,
        routes,
        events: () =>
          state.storage.sql
            .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
            .toArray()
            .map(row => JSON.parse(row.event) as ReturnType<Proxy['events']>[number]),
        sql: query => state.storage.sql.exec(query).toArray() as never,
        alarmAt: () => alarm,
        clearAlarm: () => {
          alarm = null;
        },
        drive: async (max = 40) => {
          for (let tick = 0; tick < max; tick += 1) {
            await object.alarm();
            const active = state.storage.sql
              .exec<{ n: number }>(
                "SELECT count(*) AS n FROM runs WHERE state IN ('pending','running')"
              )
              .one();
            if (active.n === 0) return;
          }
        },
        request: (method, path, init = {}) =>
          worker.fetch(
            new Request(`https://migration-proxy.kiloapps.io${path}`, {
              method,
              headers: {
                ...(init.token === undefined ? {} : { Authorization: `Bearer ${init.token}` }),
                'Content-Type': 'application/json',
              },
              body: init.body,
            }),
            proxyEnv
          ),
        restart: async () => {
          object = await build();
          return object;
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
}
