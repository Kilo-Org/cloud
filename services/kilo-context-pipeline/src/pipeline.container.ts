/**
 * PipelineContainer — Cloudflare Container managing the kilo-context pipeline.
 *
 * This is a Durable Object subclass with the Container mixin applied.
 * Cloudflare automatically:
 *   - Builds the Docker image referenced in wrangler.jsonc's `containers` block
 *   - Starts the container when the first request arrives via containerFetch()
 *   - Routes subsequent requests to the running container's HTTP server (port 8080)
 *   - Stops the container after sleepAfterSeconds of inactivity
 *
 * The container runs server.mjs which:
 *   - Listens on port 8080
 *   - Accepts POST /run — spawns the pipeline, streams stdout/stderr back
 *   - Accepts GET /health — liveness probe
 *
 * The Orchestrator creates one Container instance per run (using the run UUID
 * as the DO name), fires POST /run, reads the streaming response, then discards
 * the Container (the container shuts down after sleepAfterSeconds).
 */
import { Container } from 'cloudflare:containers';

export class PipelineContainer extends Container {
  /**
   * Port the in-container HTTP server listens on.
   * Must match EXPOSE and the listen port in server.mjs.
   */
  override defaultPort: number = 8080;

  /**
   * Shut down the container after 2 minutes of inactivity.
   * After a run completes the stream ends; the Orchestrator reads EOF and
   * moves on. The container has nothing else to do, so let it stop promptly.
   */
  override sleepAfterSeconds: number = 120;

  /**
   * Forward all requests to the container's HTTP server.
   * containerFetch() starts the container if it is not already running,
   * then proxies the request+response (including streaming bodies).
   */
  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request);
  }
}
