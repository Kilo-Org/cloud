import { Container } from '@cloudflare/containers';

/**
 * TownContainer — a Cloudflare Container per town.
 *
 * All agent processes (Mayor, Polecats, Refinery) for a town run as
 * Kilo CLI child processes inside this single container. The container
 * exposes a control server on port 8080 that the Rig DO / Hono routes
 * use to start/stop agents, send messages, and check health.
 *
 * The DO side (this class) handles container lifecycle; the control
 * server inside the container handles process management.
 */
export class TownContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  // Inject the gastown worker URL so the container's completion reporter
  // and plugin can call back to the worker API.
  envVars: Record<string, string> = this.env.GASTOWN_API_URL
    ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL }
    : {};

  override onStart(): void {
    console.log(`Town container started for DO id=${this.ctx.id.toString()}`);
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log(
      `Town container stopped: exitCode=${exitCode} reason=${reason} id=${this.ctx.id.toString()}`
    );
  }

  override onError(error: unknown): void {
    console.error('Town container error:', error, `id=${this.ctx.id.toString()}`);
  }
}

export function getTownContainerStub(env: Env, townId: string) {
  return env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));
}
