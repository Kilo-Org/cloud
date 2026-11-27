import { DurableObject } from 'cloudflare:workers';
import { type Env, readConfig, type UtsConfig } from '../env';
import { rotationManager } from '../manager/key-set';
import { rotationSettings } from '../rotation/config';
import { HyperdriveClient } from '../rotation/hyperdrive';
import { isDue, type RotationStore, type RunResult, runRotation } from '../rotation/job';
import { alterLoginPassword } from '../rotation/postgres';
import { newLoginPassword } from '../rotation/scram';
import { switchToken } from '../rotation/secrets';
import { INITIAL_ROTATION, StoredRotationSchema } from '../rotation/state';
import { createVaultKey, StoredVaultKeySchema, Vault } from '../rotation/vault';
import { loginRotationObjectId } from './stubs';

/**
 * Storage keys. Both live in the object's KV storage, not in SQL rows: a Workers trace records each
 * SQL statement's bound values, while a storage get or put records the key name only.
 */
const VAULT_KEY = 'vault-key';
const STATE_KEY = 'rotation-state';

export type LoginRotationRun =
  | RunResult
  /** A run is already in progress in this object; this call did nothing. */
  | { status: 'busy' }
  /** The switch is off, or the environment lacks a binding the job needs. */
  | { status: 'off' }
  | { status: 'misconfigured'; reason: string };

/**
 * The one object, `<environment>:login-rotation` in the `eu` jurisdiction, that runs the
 * identity-store login rotation (design 5.2) and keeps every login's current password sealed under
 * a key generated here (design E6). Passwords never leave the object except to the identity store,
 * the manager and the Cloudflare API.
 */
export class UtsLoginRotationDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  readonly #refusal: string | null;
  /** The one admission guard: set before the first await of a run, cleared when it settles. */
  #running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    this.#refusal = ctx.id.equals(loginRotationObjectId(env, this.#config))
      ? null
      : 'login rotation object was not created by its name in this environment';
  }

  async run(): Promise<LoginRotationRun> {
    if (this.#refusal !== null) return { status: 'misconfigured', reason: this.#refusal };
    if (this.#running) return { status: 'busy' };
    this.#running = true;
    try {
      const settings = rotationSettings(this.env, this.#config);
      if (settings.status === 'off') return { status: 'off' };
      if (settings.status === 'misconfigured') {
        return { status: 'misconfigured', reason: `missing ${settings.missing.join(', ')}` };
      }
      // Most runs have nothing due: they read the state and return without building any client.
      const store = this.#store();
      const stored = await store.load();
      if (!isDue(stored.state, settings.timing, Date.now())) {
        return { status: 'ran', phase: stored.state.job.phase, steps: 0 };
      }
      const manager = rotationManager(this.env, this.#config);
      if (manager === null) return { status: 'misconfigured', reason: 'no manager' };
      const vault = await this.#vault();
      const hyperdrive = new HyperdriveClient({
        baseUrl: settings.cloudflare.baseUrl,
        accountId: settings.cloudflare.accountId,
        token: () => switchToken(this.env, this.#config),
      });
      const { configIds } = settings.cloudflare;
      return await runRotation(
        store,
        {
          now: () => Date.now(),
          pins: settings.pins,
          readConfig: pool => hyperdrive.read(configIds[pool]),
          switchLogin: (pool, current, login, password) =>
            hyperdrive.switchLogin(configIds[pool], current, login, password),
          alter: alterLoginPassword,
          manager,
          newPassword: newLoginPassword,
          seal: (login, password) => vault.seal(login, password),
          open: (login, sealed) => vault.open(login, sealed),
        },
        settings.timing
      );
    } finally {
      this.#running = false;
    }
  }

  /** The current phase without any password; for operators and the local end-to-end run. */
  async phase(): Promise<{ phase: string; switchedAt: Record<string, number> }> {
    const stored = await this.#store().load();
    return { phase: stored.state.job.phase, switchedAt: { ...stored.state.switchedAt } };
  }

  #store(): RotationStore {
    const storage = this.ctx.storage;
    return {
      async load() {
        const stored: unknown = await storage.get(STATE_KEY);
        return stored === undefined ? INITIAL_ROTATION : StoredRotationSchema.parse(stored);
      },
      async commit(expected, next) {
        // The input gate holds other events during this storage read, so nothing commits
        // between it and the put.
        const stored: unknown = await storage.get(STATE_KEY);
        const revision = stored === undefined ? 0 : StoredRotationSchema.parse(stored).revision;
        if (revision !== expected) return false;
        await storage.put(STATE_KEY, { revision: expected + 1, state: next });
        return true;
      },
    };
  }

  async #vault(): Promise<Vault> {
    const stored: unknown = await this.ctx.storage.get(VAULT_KEY);
    if (stored !== undefined) return await Vault.adopt(StoredVaultKeySchema.parse(stored));
    // Only a run creates the key, and the admission guard admits one run at a time.
    const key = await createVaultKey();
    await this.ctx.storage.put(VAULT_KEY, key);
    return await Vault.adopt(key);
  }
}
