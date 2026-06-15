import { Container } from '@cloudflare/containers';

// Cloudflare Container that runs the stable `kilo` CLI for decider benchmark
// cases. The worker proxies POST /run to the container's HTTP server (see
// container/server.mjs) via this DO. One instance is keyed per
// (runId, model, chunk) so concurrent chunks/models don't share state.
export class BenchRunnerContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '2m';
  // The CLI resolves every gateway endpoint from KILO_API_URL. Production
  // points at the real gateway; local dev overrides it via .dev.vars so the
  // benchmark runs against the local apps/web instance.
  envVars = { KILO_API_URL: this.env.KILO_CLI_API_URL };
}
