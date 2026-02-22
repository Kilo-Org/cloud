import { Container } from '@cloudflare/containers';

const TC_LOG = '[TownContainer.do]';

/**
 * TownContainer — a Cloudflare Container per town.
 *
 * All agent processes for a town run inside this container via the SDK.
 * The container exposes:
 * - HTTP control server on port 8080 (start/stop/message/status/merge)
 * - WebSocket on /ws that multiplexes events from all agents
 *
 * This DO is intentionally thin. It manages container lifecycle and proxies
 * ALL requests (including WebSocket upgrades) directly to the container via
 * the base Container class's fetch(). No relay, no polling, no buffering.
 *
 * The browser connects via WebSocket through this DO and the connection is
 * passed directly to the container's Bun server, which sends SDK events
 * over that WebSocket in real-time.
 */
export class TownContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  // Container env vars. Includes infra URLs and any tokens stored via setEnvVar().
  // The Container base class reads this when booting the container.
  envVars: Record<string, string> = {
    ...(this.env.GASTOWN_API_URL ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL } : {}),
    ...(this.env.KILO_API_URL
      ? {
          KILO_API_URL: this.env.KILO_API_URL,
          KILO_OPENROUTER_BASE: `${this.env.KILO_API_URL}/api`,
        }
      : {}),
  };

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    // Load persisted env vars (like KILOCODE_TOKEN) into envVars
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
   * hasn't started yet). Call this from the TownDO during configureRig.
   */
  async setEnvVar(key: string, value: string): Promise<void> {
    const stored = (await this.ctx.storage.get<Record<string, string>>('container:envVars')) ?? {};
    stored[key] = value;
    await this.ctx.storage.put('container:envVars', stored);
    this.envVars[key] = value;
    console.log(`${TC_LOG} setEnvVar: ${key}=${value.slice(0, 8)}... stored`);
  }

  override onStart(): void {
    console.log(`${TC_LOG} container started for DO id=${this.ctx.id.toString()}`);
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log(
      `${TC_LOG} container stopped: exitCode=${exitCode} reason=${reason} id=${this.ctx.id.toString()}`
    );
  }

  override onError(error: unknown): void {
    console.error(`${TC_LOG} container error:`, error, `id=${this.ctx.id.toString()}`);
  }

  // No fetch() override — the base Container class handles everything:
  // - HTTP requests are proxied to port 8080 via containerFetch
  // - WebSocket upgrades are proxied to port 8080 via containerFetch
  //   (the container's Bun.serve handles the WS upgrade natively)
}

export function getTownContainerStub(env: Env, townId: string) {
  return env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));
}
