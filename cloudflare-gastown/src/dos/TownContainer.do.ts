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

  // Only infra URLs needed at boot. User config comes per-request via X-Town-Config.
  envVars: Record<string, string> = {
    ...(this.env.GASTOWN_API_URL ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL } : {}),
    ...(this.env.KILO_API_URL
      ? {
          KILO_API_URL: this.env.KILO_API_URL,
          KILO_OPENROUTER_BASE: `${this.env.KILO_API_URL}/api`,
        }
      : {}),
  };

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
