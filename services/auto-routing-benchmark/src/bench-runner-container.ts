import { Container } from '@cloudflare/containers';

// Cloudflare Container that runs the stable `kilo` CLI for decider benchmark
// cases. The worker proxies POST /run to the container's HTTP server (see
// container/server.mjs) via this DO. One instance is keyed per
// (runId, model, chunk) so concurrent chunks/models don't share state.
export class BenchRunnerContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '2m';
}
