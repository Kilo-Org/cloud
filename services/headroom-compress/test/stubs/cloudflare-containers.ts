export class Container<Env = unknown> {
  defaultPort?: number;
  sleepAfter?: string;
  env: Env;

  constructor(_ctx: unknown, env: Env) {
    this.env = env;
  }

  fetch(request: Request): Response {
    return new Response(null, {
      status: 502,
      statusText: `Container stub cannot handle ${request.method} ${new URL(request.url).pathname}`,
    });
  }
}
