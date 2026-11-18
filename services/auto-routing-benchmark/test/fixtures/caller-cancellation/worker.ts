import { DurableObject } from 'cloudflare:workers';
import { withCallerCancellation } from '../../../src/caller-cancellation';

type FixtureEnv = { RELAY: DurableObjectNamespace<Relay> };

// Stands in for BenchRunnerContainer: `/relay` forwards the way it does now, `/direct`
// forwards the incoming request the way @cloudflare/containers does on its own.
export class Relay extends DurableObject<FixtureEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upstream = url.searchParams.get('upstream') ?? '';
    const forwarded = url.pathname === '/relay' ? withCallerCancellation(request) : request;
    return fetch(upstream, forwarded).catch(() => new Response(null, { status: 499 }));
  }
}

// Stands in for the queue invocation: it starts a case and then goes away mid-flight.
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    const relay = env.RELAY.get(env.RELAY.idFromName(url.pathname));
    relay
      .fetch(
        new Request(`http://relay${url.pathname}${url.search}`, { method: 'POST', body: '{}' })
      )
      .catch(() => {});
    await scheduler.wait(Number(url.searchParams.get('leaveAfterMs')));
    return new Response('caller gone');
  },
} satisfies ExportedHandler<FixtureEnv>;
