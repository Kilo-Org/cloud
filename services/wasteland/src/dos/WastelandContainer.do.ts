import { Container } from '@cloudflare/containers';

const WC_LOG = '[WastelandContainer.do]';

/**
 * WastelandContainerDO — a Cloudflare Container per wasteland.
 *
 * Runs the `wl` CLI and a lightweight control server for protocol
 * operations (browse, claim, post, sync) against DoltHub.
 *
 * This DO is intentionally thin. It manages container lifecycle and proxies
 * ALL requests directly to the container via the base Container class's fetch().
 */
export class WastelandContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  // Container env vars. Includes infra URLs and any tokens stored via setEnvVar().
  // The Container base class reads this when booting the container.
  envVars: Record<string, string> = {
    ...(this.env.WASTELAND_API_URL ? { WASTELAND_API_URL: this.env.WASTELAND_API_URL } : {}),
    ...(this.env.KILO_API_URL ? { KILO_API_URL: this.env.KILO_API_URL } : {}),
  };

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    // Load persisted env vars (like DOLTHUB_TOKEN) into envVars
    // so they're available when the container boots.
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Record<string, string>>('container:envVars');
      if (stored) {
        Object.assign(this.envVars, stored);
      }
    });
  }

  /**
   * Store an env var that will be injected into the container OS environment.
   * Takes effect on the next container boot (or immediately if the container
   * hasn't started yet). Call this from the WastelandDO when storing credentials.
   */
  async setEnvVar(key: string, value: string): Promise<void> {
    const stored = (await this.ctx.storage.get<Record<string, string>>('container:envVars')) ?? {};
    stored[key] = value;
    await this.ctx.storage.put('container:envVars', stored);
    this.envVars[key] = value;
    console.log(`${WC_LOG} setEnvVar: ${key} stored (${value.length} chars)`);
  }

  async deleteEnvVar(key: string): Promise<void> {
    const stored = (await this.ctx.storage.get<Record<string, string>>('container:envVars')) ?? {};
    delete stored[key];
    await this.ctx.storage.put('container:envVars', stored);
    delete this.envVars[key];
    console.log(`${WC_LOG} deleteEnvVar: ${key} removed`);
  }

  override onStart(): void {
    console.log(`${WC_LOG} container started for DO id=${this.ctx.id.toString()}`);
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log(
      `${WC_LOG} container stopped: exitCode=${exitCode} reason=${reason} id=${this.ctx.id.toString()}`
    );
  }

  override onError(error: unknown): void {
    console.error(`${WC_LOG} container error:`, error, `id=${this.ctx.id.toString()}`);
  }
}

export function getWastelandContainerStub(env: Env, wastelandId: string) {
  return env.WASTELAND_CONTAINER.get(env.WASTELAND_CONTAINER.idFromName(wastelandId));
}
