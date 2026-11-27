import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretDescription, SecretWrite } from '../../src/manager/client';
import {
  DEPLOYED_TIMING,
  developmentTiming,
  type LoginName,
  type RotationPool,
  type RotationTiming,
} from '../../src/rotation/config';
import type {
  HyperdriveOrigin,
  HyperdriveRead,
  HyperdriveSwitch,
} from '../../src/rotation/hyperdrive';
import {
  advance,
  nextSwitchWindow,
  type RotationPorts,
  type RotationStore,
  runRotation,
} from '../../src/rotation/job';
import type { AlterResult } from '../../src/rotation/postgres';
import type { LoginSeeds } from '../../src/rotation/secrets';
import {
  INITIAL_ROTATION,
  type RotationState,
  RotationStateSchema,
  type StoredRotation,
} from '../../src/rotation/state';
import { createVaultKey, Vault } from '../../src/rotation/vault';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 03:00 UTC, inside the deployed off-peak window. */
const START = Date.UTC(2026, 10, 27, 3, 0, 0);
const TIMING: RotationTiming = { ...DEPLOYED_TIMING };

const SEEDS: LoginSeeds = {
  uts_app_a: 'seed-app-a',
  uts_app_b: 'seed-app-b',
  uts_pat_a: 'seed-pat-a',
  uts_pat_b: 'seed-pat-b',
  uts_reader_a: 'seed-reader-a',
  uts_reader_b: 'seed-reader-b',
};

/** A stand-in identity store, manager and Cloudflare API behind the job's ports. */
class World {
  now = START;
  /** The password each login really has. */
  passwords = new Map<LoginName, string>([
    ['uts_app_a', 'seed-app-a'],
    ['uts_app_b', 'seed-app-b'],
    ['uts_pat_a', 'seed-pat-a'],
    ['uts_pat_b', 'seed-pat-b'],
    ['uts_reader_a', 'seed-reader-a'],
    ['uts_reader_b', 'seed-reader-b'],
  ]);
  configs: Record<RotationPool, HyperdriveOrigin> = {
    app: origin('uts_app_a'),
    pat: origin('uts_pat_a'),
    reader: origin('uts_reader_a'),
  };
  /** Values Hyperdrive was given, per login. */
  hyperdrivePasswords = new Map<string, string>();
  secrets = new Map<string, string>();
  pendingApprovals = new Map<string, string>();
  seeds: LoginSeeds = { ...SEEDS };
  approvalPolicy = false;
  alterOverride: AlterResult | null = null;
  readOverride: HyperdriveRead | null = null;
  switchOverride: HyperdriveSwitch | null = null;
  describeOverride: SecretDescription | null = null;
  createOverride: SecretWrite | null = null;
  calls: string[] = [];
  counter = 0;

  constructor(private readonly vault: Vault) {}

  approve(): void {
    for (const [name, value] of this.pendingApprovals) this.secrets.set(name, value);
    this.pendingApprovals.clear();
  }

  ports(): RotationPorts {
    return {
      now: () => this.now,
      readConfig: async pool => {
        this.calls.push(`read:${pool}`);
        return this.readOverride ?? { status: 'ok', origin: { ...this.configs[pool] } };
      },
      switchLogin: async (pool, _current, login, password) => {
        this.calls.push(`switch:${pool}:${login}`);
        if (this.switchOverride !== null) return this.switchOverride;
        this.configs[pool] = origin(login);
        this.hyperdrivePasswords.set(login, password);
        return { status: 'switched' };
      },
      alter: async (target, login, current, pending) => {
        this.calls.push(`alter:${login}`);
        expect(target).toEqual({ host: 'db.example.test', port: 5432, database: 'postgres' });
        if (this.alterOverride !== null) return this.alterOverride;
        const actual = this.passwords.get(login);
        if (actual === pending) return { status: 'already_applied' };
        if (actual !== current) return { status: 'auth_failed' };
        this.passwords.set(login, pending);
        return { status: 'altered' };
      },
      manager: {
        createIdentityStoreSecret: async (name, value) => {
          this.calls.push(`create:${name}`);
          if (this.createOverride !== null) return this.createOverride;
          if (this.approvalPolicy) {
            this.pendingApprovals.set(name, value);
            return { status: 'approval_pending' };
          }
          this.secrets.set(name, value);
          return { status: 'created' };
        },
        describeIdentityStoreSecret: async name => {
          this.calls.push(`describe:${name}`);
          if (this.describeOverride !== null) return this.describeOverride;
          return this.secrets.has(name) ? { status: 'present' } : { status: 'missing' };
        },
      },
      loginSeeds: async () => this.seeds,
      newPassword: () => `new-password-${(this.counter += 1)}`,
      seal: (login, password) => this.vault.seal(login, password),
      open: (login, sealed) => this.vault.open(login, sealed),
    };
  }
}

function origin(user: string): HyperdriveOrigin {
  return { scheme: 'postgres', host: 'db.example.test', port: 5432, database: 'postgres', user };
}

class MemoryStore implements RotationStore {
  stored: StoredRotation = INITIAL_ROTATION;
  commits = 0;
  /** Runs before a commit compares revisions: a concurrent writer or a crash. */
  beforeCommit: (() => void) | null = null;

  async load(): Promise<StoredRotation> {
    return this.stored;
  }

  async commit(expected: number, next: RotationState): Promise<boolean> {
    this.beforeCommit?.();
    if (this.stored.revision !== expected) return false;
    // Every committed state must survive the storage round trip of the object.
    this.stored = {
      revision: expected + 1,
      state: RotationStateSchema.parse(structuredClone(next)),
    };
    this.commits += 1;
    return true;
  }
}

let vault: Vault;
let world: World;
let store: MemoryStore;
let logs: string[];

beforeEach(async () => {
  vault = await Vault.adopt(await createVaultKey());
  world = new World(vault);
  store = new MemoryStore();
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      logs.push(`${level} ${String(line)}`);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const run = () => runRotation(store, world.ports(), TIMING);
const job = () => store.stored.state.job;
const logged = (level: string, event: string) =>
  logs.some(line => line.startsWith(`${level} `) && line.includes(`"uts.login_rotation.${event}"`));

describe('a full cycle', () => {
  it('rotates the idle login, stores it, switches the config, and keeps no password in the logs', async () => {
    const result = await run();
    expect(result).toEqual({ status: 'ran', phase: 'idle', steps: 4 });
    expect(world.passwords.get('uts_app_b')).toBe('new-password-1');
    expect(world.passwords.get('uts_app_a')).toBe('seed-app-a');
    expect(world.secrets.get('uts_app_b_20261127')).toBe('new-password-1');
    expect(world.configs.app.user).toBe('uts_app_b');
    expect(world.hyperdrivePasswords.get('uts_app_b')).toBe('new-password-1');
    expect(store.stored.state.switchedAt).toEqual({ app: START });
    expect(logs.join('\n')).not.toMatch(/new-password|seed-app/);
    expect(JSON.stringify(store.stored)).not.toMatch(/new-password|seed-app/);
  });

  it('switches the next pool only after the spacing, then alternates back a period later', async () => {
    await run();
    world.now += MINUTE;
    await run();
    // pat is rotated and stored, but its switch waits for 5 minutes after app's.
    expect(job()).toMatchObject({
      phase: 'switching',
      pool: 'pat',
      nextAttemptAt: START + 5 * MINUTE,
    });
    expect(world.configs.pat.user).toBe('uts_pat_a');
    world.now = START + 5 * MINUTE;
    await run();
    expect(world.configs.pat.user).toBe('uts_pat_b');
    world.now += 5 * MINUTE;
    await run();
    expect(world.configs.reader.user).toBe('uts_reader_b');
    world.now += MINUTE;
    expect(await run()).toEqual({ status: 'ran', phase: 'idle', steps: 0 });

    world.now = START + 30 * DAY;
    world.seeds = {};
    await run();
    // a is the idle login now; the first cycle adopted only b's seed, and the seeds are gone.
    expect(job()).toMatchObject({ phase: 'idle' });
    expect(logged('error', 'refused')).toBe(true);
  });
});

describe('the idle login without a password', () => {
  it('waits and alerts when no seed names it', async () => {
    world.seeds = { uts_app_a: 'seed-app-a' };
    expect(await run()).toEqual({ status: 'ran', phase: 'idle', steps: 1 });
    expect(job()).toEqual({ phase: 'idle', nextAttemptAt: START + HOUR });
    expect(world.calls).toEqual(['read:app']);
    expect(logged('error', 'refused')).toBe(true);
  });

  it('alternates a -> b -> a when both seeds are present', async () => {
    await run();
    expect(world.configs.app.user).toBe('uts_app_b');
    world.now += 5 * MINUTE;
    await run();
    world.now += 5 * MINUTE;
    await run();
    expect([world.configs.pat.user, world.configs.reader.user]).toEqual([
      'uts_pat_b',
      'uts_reader_b',
    ]);
    // app switched longest ago, so it goes first; a's seed lets the job log in as a.
    world.now = START + 30 * DAY;
    await run();
    expect(world.configs.app.user).toBe('uts_app_a');
    expect(world.passwords.get('uts_app_a')).toBe('new-password-4');
    expect(world.hyperdrivePasswords.get('uts_app_a')).toBe('new-password-4');
    expect(world.secrets.get('uts_app_a_20261227')).toBe('new-password-4');
    expect(world.passwords.get('uts_app_b')).toBe('new-password-1');
  });
});

describe('approval pending', () => {
  beforeEach(() => {
    world.approvalPolicy = true;
  });

  it('waits for the change request, checks hourly, alerts once after 24 hours, then switches', async () => {
    await run();
    expect(job()).toMatchObject({
      phase: 'awaiting_approval',
      requestedAt: START,
      nextCheckAt: START + HOUR,
    });
    expect(world.configs.app.user).toBe('uts_app_a');

    world.now += 30 * MINUTE;
    expect(await run()).toEqual({ status: 'ran', phase: 'awaiting_approval', steps: 0 });

    world.now = START + HOUR;
    await run();
    expect(job()).toMatchObject({
      phase: 'awaiting_approval',
      overdueAlerted: false,
      nextCheckAt: START + 2 * HOUR,
    });

    world.now = START + DAY;
    await run();
    expect(job()).toMatchObject({ overdueAlerted: true });
    expect(logs.filter(line => line.includes('approval_overdue'))).toHaveLength(1);
    world.now += HOUR;
    await run();
    expect(logs.filter(line => line.includes('approval_overdue'))).toHaveLength(1);

    world.approve();
    // The approval landed outside the window: the switch waits for 02:00 UTC.
    world.now += HOUR;
    await run();
    expect(job()).toMatchObject({ phase: 'switching' });
    const switching = job();
    const waitUntil = switching.phase === 'switching' ? switching.nextAttemptAt : 0;
    expect(new Date(waitUntil).getUTCHours()).toBe(2);
    world.now = waitUntil;
    await run();
    expect(world.configs.app.user).toBe('uts_app_b');
  });

  it('keeps waiting while describe answers missing, and retries sooner when it fails', async () => {
    await run();
    world.now = START + HOUR;
    world.describeOverride = { status: 'unreachable', detail: 'timeout', retryAfterMs: null };
    await run();
    expect(job()).toMatchObject({ phase: 'awaiting_approval', nextCheckAt: START + HOUR + MINUTE });
    expect(logged('warn', 'retry')).toBe(true);
    world.describeOverride = null;
    world.now += MINUTE;
    await run();
    expect(job()).toMatchObject({
      phase: 'awaiting_approval',
      nextCheckAt: START + 2 * HOUR + MINUTE,
    });
  });
});

describe('describe missing', () => {
  it('creates the secret when describe finds none, and does not create it twice after a lost answer', async () => {
    world.createOverride = { status: 'unreachable', detail: 'timeout', retryAfterMs: null };
    await run();
    expect(job()).toMatchObject({ phase: 'storing', nextAttemptAt: START + MINUTE });
    // The create landed, but its answer was lost.
    world.secrets.set('uts_app_b_20261127', 'new-password-1');
    world.createOverride = null;
    world.now += MINUTE;
    world.calls = [];
    await run();
    expect(world.calls.filter(call => call.startsWith('create:'))).toEqual([]);
    expect(world.configs.app.user).toBe('uts_app_b');
  });

  it('retries a refused create after an hour with an error', async () => {
    world.createOverride = { status: 'refused', detail: 'manager create answered 403' };
    await run();
    expect(job()).toMatchObject({ phase: 'storing', nextAttemptAt: START + HOUR });
    expect(logged('error', 'refused')).toBe(true);
  });
});

describe('ALTER failed', () => {
  it('keeps the pending password and retries a minute later when the store is unreachable', async () => {
    world.alterOverride = { status: 'unreachable', detail: 'connection failed' };
    await run();
    const first = job();
    expect(first).toMatchObject({ phase: 'altering', nextAttemptAt: START + MINUTE });
    world.alterOverride = null;
    world.now += MINUTE;
    await run();
    // The same pending password was used, not a new one.
    expect(world.passwords.get('uts_app_b')).toBe('new-password-1');
    expect(world.configs.app.user).toBe('uts_app_b');
  });

  it('retries a refused ALTER an hour later with an error', async () => {
    world.alterOverride = { status: 'refused', detail: 'SQLSTATE 42501' };
    await run();
    expect(job()).toMatchObject({ phase: 'altering', nextAttemptAt: START + HOUR });
    expect(logged('error', 'refused')).toBe(true);
  });

  it('marks the login lost when neither password logs in, and resumes from a restored seed', async () => {
    world.passwords.set('uts_app_b', 'changed-outside');
    await run();
    expect(job()).toMatchObject({ phase: 'lost', login: 'uts_app_b', since: START });
    expect(logged('error', 'login_lost')).toBe(true);

    world.now = START + HOUR;
    world.seeds = {};
    await run();
    expect(job()).toMatchObject({ phase: 'lost', nextCheckAt: START + 2 * HOUR });

    // 02:00 UTC the next day, so the switch after the recovery falls inside the window.
    world.now = START + 23 * HOUR;
    world.seeds = { uts_app_b: 'changed-outside' };
    await run();
    expect(world.passwords.get('uts_app_b')).toBe('new-password-1');
    expect(world.configs.app.user).toBe('uts_app_b');
  });

  it('waits when the primary config cannot be read', async () => {
    await advance(store.stored.state, world.ports(), TIMING).then(async step => {
      await store.commit(0, step.state);
    });
    world.readOverride = { status: 'unreachable', detail: 'cloudflare GET answered 503' };
    await run();
    expect(job()).toMatchObject({ phase: 'altering', nextAttemptAt: START + MINUTE });
  });
});

describe('Hyperdrive switch failed', () => {
  it('keeps the cycle in switching and retries; the login in use keeps serving', async () => {
    world.switchOverride = { status: 'unreachable', detail: 'cloudflare PATCH answered 502' };
    await run();
    expect(job()).toMatchObject({ phase: 'switching', nextAttemptAt: START + MINUTE });
    expect(world.configs.app.user).toBe('uts_app_a');
    expect(store.stored.state.switchedAt).toEqual({});
    world.switchOverride = null;
    world.now += MINUTE;
    await run();
    expect(world.configs.app.user).toBe('uts_app_b');
  });

  it('treats a switch that landed before its answer was lost as done', async () => {
    world.switchOverride = { status: 'unreachable', detail: 'cloudflare request failed' };
    await run();
    world.configs.app = origin('uts_app_b');
    world.switchOverride = null;
    world.now += MINUTE;
    world.calls = [];
    await run();
    expect(world.calls).toEqual(['read:app']);
    expect(store.stored.state.switchedAt).toEqual({ app: START + MINUTE });
  });

  it('refuses a config that uses a login outside its pair', async () => {
    world.configs.app = origin('postgres');
    await run();
    expect(job()).toEqual({ phase: 'idle', nextAttemptAt: START + HOUR });
    expect(world.calls).toEqual(['read:app']);
  });
});

describe('partial progress', () => {
  it('resumes after a crash that followed a successful ALTER without changing the password again', async () => {
    let commits = 0;
    store.beforeCommit = () => {
      commits += 1;
      // The second commit (altering -> storing) never happens: the object was reset after ALTER.
      if (commits === 2) throw new Error('object reset');
    };
    await expect(run()).rejects.toThrow('object reset');
    expect(job().phase).toBe('altering');
    expect(world.passwords.get('uts_app_b')).toBe('new-password-1');

    store.beforeCommit = null;
    world.calls = [];
    await run();
    expect(world.calls).toContain('alter:uts_app_b');
    expect(world.passwords.get('uts_app_b')).toBe('new-password-1');
    expect(world.secrets.get('uts_app_b_20261127')).toBe('new-password-1');
    expect(world.configs.app.user).toBe('uts_app_b');
  });
});

describe('a late result', () => {
  it('does not overwrite state another run committed first', async () => {
    store.beforeCommit = () => {
      // Another writer commits while this run waits on the network.
      store.beforeCommit = null;
      store.stored = {
        revision: store.stored.revision + 1,
        state: { ...store.stored.state, job: { phase: 'idle', nextAttemptAt: START + DAY } },
      };
    };
    expect(await run()).toEqual({ status: 'stale', phase: 'altering' });
    expect(store.stored).toEqual({
      revision: 1,
      state: { logins: {}, switchedAt: {}, job: { phase: 'idle', nextAttemptAt: START + DAY } },
    });
    expect(logged('warn', 'stale_result')).toBe(true);
  });
});

describe('timing', () => {
  it('finds the next off-peak window', () => {
    expect(nextSwitchWindow(START, TIMING)).toBe(START);
    expect(nextSwitchWindow(Date.UTC(2026, 10, 27, 1, 30), TIMING)).toBe(Date.UTC(2026, 10, 27, 2));
    expect(nextSwitchWindow(Date.UTC(2026, 10, 27, 5, 0), TIMING)).toBe(Date.UTC(2026, 10, 28, 2));
    expect(nextSwitchWindow(Date.UTC(2026, 10, 27, 23, 0), TIMING)).toBe(Date.UTC(2026, 10, 28, 2));
  });

  it('shortens every development wait to the period and has no window', () => {
    expect(developmentTiming(2000)).toEqual({
      periodMs: 2000,
      switchSpacingMs: 2000,
      approvalCheckMs: 2000,
      approvalAlertMs: 48_000,
      retryMs: 2000,
      refusedRetryMs: 2000,
      offPeakUtcHours: null,
    });
  });
});

describe('the vault', () => {
  it('opens only what it sealed for the same login', async () => {
    const sealed = await vault.seal('uts_app_a', 'secret-value');
    expect(await vault.open('uts_app_a', sealed)).toBe('secret-value');
    await expect(vault.open('uts_app_b', sealed)).rejects.toThrow();
    const other = await Vault.adopt(await createVaultKey());
    await expect(other.open('uts_app_a', sealed)).rejects.toThrow();
  });
});
